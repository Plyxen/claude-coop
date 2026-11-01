// The MCP server each Claude runs. It is also a Claude Code channel: it polls
// the hub and pushes the crew's events into the running session, so a worker
// starts on new tasks by itself and the lead hears what the workers do.
// stdout belongs to the MCP protocol: log to stderr only.
import { homedir } from 'node:os'
import { basename, sep } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { HubClient, HubError } from '../client.js'
import { getProfile, readState, writeState } from '../config.js'
import { VERSION } from '../hub/app.js'
import { redactSecrets } from '../secrets.js'
import { instructionsFor } from './instructions.js'
import { isWellFormedEvent, metaFor, needsTask, pushText } from './messages.js'
import { shouldPush } from './policy.js'
import { toolsFor } from './tools.js'

const REMIND_MS = 5 * 60_000
const MAX_REMINDERS = 3
const IDLE_AFTER_MS = 5 * 60_000
const INBOX_SIZE = 200
const SEPARATOR = '\n\n---\n\n'
const MAX_PUSH = 40_000
const PERMISSION_WAIT_MS = 10 * 60_000
const MAX_PENDING = 50
const TOKEN_WARNING_MS = 14 * 24 * 60 * 60_000
const REQUEST_ID_RE = /^[a-km-z]{5}$/

const PermissionRequest = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z
    .object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string().optional(),
    })
    .passthrough(),
})

export function createCoopServer({
  profile,
  client = new HubClient(profile),
  pollMs = Number(process.env.COOP_POLL_MS) || 8_000,
  remindMs = REMIND_MS,
  launched = process.env.COOP_LAUNCHED === '1',
  log = (...args) => console.error('[coop]', ...args),
}) {
  const isWorker = profile.role === 'worker'
  const relay = isWorker && profile.relayPermissions !== false && process.env.COOP_RELAY_PERMISSIONS !== '0'
  const tools = toolsFor(profile.role)
  const inbox = []
  // request id -> when we stop accepting an answer to it
  const pendingPermissions = new Map()
  const reminded = new Map()

  let cursor = readState(profile.name).cursor
  let polling = null
  let timer = null
  let stopped = false
  let failures = 0
  let retryAt = 0
  let lastActivity = Date.now()
  let lastReminder = launched ? Date.now() : 0

  const mcp = new Server(
    { name: 'coop', version: VERSION },
    {
      capabilities: {
        experimental: { 'claude/channel': {}, ...(relay ? { 'claude/channel/permission': {} } : {}) },
        tools: {},
      },
      instructions: instructionsFor(profile),
    },
  )

  // --- tools ---------------------------------------------------------------

  const ctx = { client, profile, readInbox }

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    lastActivity = Date.now()
    const tool = tools.find((t) => t.name === request.params.name)
    if (!tool) return errorResult(`unknown tool ${request.params.name}`)
    try {
      // Secrets stay on this PC when a pattern can spot them. The hub checks
      // again, and neither check is a promise: see docs/security-guarantees.md.
      const { args, kinds } = redactArgs(request.params.arguments ?? {})
      const text = await tool.run(ctx, args)
      const warning = kinds.length ? `\n\nNote: coop took out what looked like a secret (${kinds.join(', ')}) before sending this.` : ''
      return { content: [{ type: 'text', text: text + warning }] }
    } catch (error) {
      if (!(error instanceof HubError) && !error.expose) log(error.message)
      return errorResult(error.message)
    }
  })

  // --- permission relay (workers) ------------------------------------------

  if (relay) {
    mcp.setNotificationHandler(PermissionRequest, async ({ params }) => {
      expirePending()
      if (!REQUEST_ID_RE.test(params.request_id) || pendingPermissions.size >= MAX_PENDING) {
        log('ignored a permission request with a bad id, or too many open ones. The prompt stays open on this PC.')
        return
      }
      pendingPermissions.set(params.request_id, Date.now() + PERMISSION_WAIT_MS)
      try {
        const sent = await client.permissionRequest({
          request_id: params.request_id,
          tool_name: params.tool_name,
          description: redactSecrets(params.description).text,
          input_preview: redactSecrets(params.input_preview ?? '').text,
          cwd: shownFolder(),
        })
        const until = Date.parse(sent?.expires_at)
        if (until) pendingPermissions.set(params.request_id, until)
      } catch (error) {
        pendingPermissions.delete(params.request_id)
        log(`couldn't relay a permission request to the lead: ${error.message}`)
      }
      schedule(1_000)
    })
  }

  // A verdict only counts if it comes from the lead, for a request this session
  // has open, before that request's time is up. The hub checks too; this also
  // stops an old or forged verdict from reaching Claude Code. It can't stop a
  // compromised hub that forges a timely one: see docs/threat-model.md.
  async function sendVerdict(event) {
    const { request_id: requestId, behavior } = event.data ?? {}
    if (behavior !== 'allow' && behavior !== 'deny') return
    const until = pendingPermissions.get(requestId)
    if (event.actor_role !== 'lead' || !until || Date.now() > until) {
      log(`ignored a permission answer that doesn't match an open request (${String(requestId).slice(0, 8)})`)
      return
    }
    pendingPermissions.delete(requestId)
    await mcp.notification({ method: 'notifications/claude/channel/permission', params: { request_id: requestId, behavior } })
  }

  function expirePending() {
    for (const [id, until] of pendingPermissions) if (Date.now() > until) pendingPermissions.delete(id)
  }

  // The project folder, without the part of the path that names the person.
  function shownFolder() {
    const cwd = process.cwd()
    const home = homedir()
    return cwd === home || cwd.startsWith(home + sep) ? `~${cwd.slice(home.length)}` : basename(cwd)
  }

  // --- channel pushes --------------------------------------------------------

  async function channel(text, meta) {
    inbox.push({ text, read: false })
    if (inbox.length > INBOX_SIZE) inbox.splice(0, inbox.length - INBOX_SIZE)
    try {
      await mcp.notification({ method: 'notifications/claude/channel', params: { content: text, meta } })
    } catch (error) {
      log(`couldn't push to the session: ${error.message}`)
    }
  }

  async function pushEvents(events) {
    const texts = []
    for (const event of events) {
      let task
      if (needsTask(event, profile)) task = (await client.task(event.task_id).catch(() => null))?.task
      texts.push(pushText(event, profile, task))
    }
    const meta = events.length === 1 ? metaFor(events[0]) : { event: 'batch', count: String(events.length), events: events.map((e) => metaFor(e).event).join(' ') }
    const text = texts.join(SEPARATOR)
    await channel(text.length > MAX_PUSH ? `${text.slice(0, MAX_PUSH)}\n[coop cut this message short: use coop_status or coop_task for the rest]` : text, meta)
  }

  // --- polling -------------------------------------------------------------

  function saveCursor() {
    try {
      writeState(profile.name, { cursor })
    } catch (error) {
      log(`couldn't save state: ${error.message}`)
    }
  }

  // One poll at a time: the loop and coop_inbox share it.
  function poll() {
    polling ??= (async () => {
      if (cursor == null) {
        cursor = (await client.me()).latest_event_id
        saveCursor()
      }
      for (let round = 0; round < 5; round++) {
        const page = await client.events(cursor, 100)
        const events = Array.isArray(page.events) ? page.events.filter(isWellFormedEvent) : []
        const next = Number.isSafeInteger(page.cursor) && page.cursor >= cursor ? page.cursor : cursor
        const toPush = []
        for (const event of events) {
          if (event.type === 'permission_verdict') {
            if (isWorker && event.target === profile.member) await sendVerdict(event)
          } else if (shouldPush(event, profile)) {
            toPush.push(event)
          }
        }
        if (toPush.length) {
          lastActivity = Date.now()
          await pushEvents(toPush)
        }
        // Only after the push: a crash in between repeats an event, it doesn't lose one.
        cursor = next
        saveCursor()
        // The hub was reset while this session ran: pick up from where it is now.
        if (Number.isSafeInteger(page.latest_event_id) && page.latest_event_id < cursor) {
          cursor = page.latest_event_id
          saveCursor()
        }
        if ((page.events?.length ?? 0) < 100) break
      }
      failures = 0
      await remind()
    })().finally(() => {
      polling = null
    })
    return polling
  }

  // Workers get nudged about work that's waiting, in case a push was missed.
  async function remind() {
    if (!isWorker || Date.now() - lastReminder < remindMs) return
    lastReminder = Date.now()
    const board = await client.board()
    const me = profile.member
    const busy = board.tasks.some((t) => t.assignee === me && (t.status === 'in_progress' || t.status === 'blocked'))
    if (busy) return
    const fresh = (t) => (reminded.get(t.id) ?? 0) < MAX_REMINDERS
    const mine = board.tasks.filter((t) => t.assignee === me && t.status === 'assigned' && fresh(t))
    const open = mine.length ? [] : board.tasks.filter((t) => t.status === 'open' && fresh(t))
    for (const t of [...mine, ...open]) reminded.set(t.id, (reminded.get(t.id) ?? 0) + 1)
    const list = (tasks) => tasks.map((t) => `#${t.id} "${t.title}"`).join(', ')
    if (mine.length) {
      await channel(`[coop] Reminder: ${list(mine)} ${mine.length === 1 ? 'is' : 'are'} assigned to you and not claimed yet. Claim with coop_claim and get going, or coop_release with a reason.`, { event: 'reminder', from: 'coop', from_role: 'system' })
    } else if (open.length) {
      await channel(`[coop] Open tasks are waiting and you have nothing in progress: ${list(open)}. Claim one with coop_claim.`, { event: 'reminder', from: 'coop', from_role: 'system' })
    }
  }

  // The lead hears what's waiting on them when their session starts.
  async function leadStartup() {
    const board = await client.board()
    const review = board.tasks.filter((t) => t.status === 'review')
    const blocked = board.tasks.filter((t) => t.status === 'blocked')
    const online = board.members.filter((m) => m.role === 'worker' && m.online).map((m) => m.name)
    const alerts = board.security_alerts ?? 0
    const asks = board.pending_permissions ?? 0
    if (!review.length && !blocked.length && !alerts && !asks) return
    const lines = ['[coop] Waiting on you:']
    if (alerts) lines.push(`- ${alerts} security alert(s) in the last day. Tell your user: coop audit shows them.`)
    if (asks) lines.push(`- ${asks} permission request(s) are open. Your user can see them with coop permissions.`)
    for (const t of review) lines.push(`- #${t.id} "${t.title}" from ${t.assignee} is waiting for review${t.pr_url ? ` (${t.pr_url})` : ''}.`)
    for (const t of blocked) lines.push(`- ${t.assignee} is blocked on #${t.id} "${t.title}" (coop_task ${t.id} shows why).`)
    lines.push(online.length ? `Workers online: ${online.join(', ')}.` : 'No workers are online right now.')
    await channel(lines.join('\n'), { event: 'startup', from: 'coop', from_role: 'system' })
  }

  function nextDelay() {
    expirePending()
    if (retryAt > Date.now()) return retryAt - Date.now()
    if (pendingPermissions.size) return 2_000
    if (failures) return Math.min(60_000, pollMs * 2 ** Math.min(failures, 4))
    return Date.now() - lastActivity > IDLE_AFTER_MS ? Math.max(pollMs, 20_000) : pollMs
  }

  function schedule(delay) {
    clearTimeout(timer)
    if (!stopped) timer = setTimeout(loop, delay)
  }

  async function loop() {
    try {
      await poll()
    } catch (error) {
      failures++
      if (error.status === 429) retryAt = Date.now() + (error.retryAfter ?? 60) * 1_000
      // A token that stopped working won't start again: stop asking, and say so.
      if (error.status === 401) {
        log(`the hub refused this token: ${error.message}`)
        stopped = true
        await channel(`[coop] Stopped: the hub no longer accepts your token (${error.message}). Stop working on crew tasks and tell your user. They can get a new invite from the lead and run coop join.`, { event: 'stopped', from: 'coop', from_role: 'system' })
        return
      }
      if (failures === 1 || failures % 10 === 0) log(`can't reach the hub: ${error.message}`)
    }
    schedule(nextDelay())
  }

  // --- coop_inbox (for sessions without channels) ----------------------------

  async function readInbox(waitSeconds) {
    const deadline = Date.now() + waitSeconds * 1_000
    for (;;) {
      await poll().catch(() => {})
      const unread = inbox.filter((item) => !item.read)
      if (unread.length) {
        for (const item of unread) item.read = true
        return unread.map((item) => item.text).join(SEPARATOR)
      }
      const left = deadline - Date.now()
      if (left <= 0) return waitSeconds ? `Nothing new in ${waitSeconds}s. Call coop_inbox again to keep waiting.` : 'Nothing new.'
      await new Promise((resolve) => setTimeout(resolve, Math.min(3_000, left)))
    }
  }

  // --- lifecycle -------------------------------------------------------------

  async function start() {
    try {
      const info = await client.me()
      if (info.name !== profile.member || info.role !== profile.role) {
        log(`warning: the hub knows this token as ${info.name} (${info.role}), but the profile says ${profile.member} (${profile.role}). Run coop join again.`)
      }
      // A fresh profile, or a hub that was reset: start from now.
      if (cursor == null || cursor > info.latest_event_id) {
        cursor = info.latest_event_id
        saveCursor()
      }
      const expires = Date.parse(info.token?.expires_at)
      if (expires && expires - Date.now() < TOKEN_WARNING_MS) {
        const days = Math.max(0, Math.ceil((expires - Date.now()) / 86_400_000))
        await channel(`[coop] Your crew token expires in ${days} day(s). Tell your user to run: coop tokens rotate`, { event: 'token_expiring', from: 'coop', from_role: 'system' })
      }
    } catch (error) {
      log(`can't reach the hub yet: ${error.message}`)
    }
    if (profile.role === 'lead') setTimeout(() => leadStartup().catch((error) => log(error.message)), 3_000)
    schedule(1_000)
  }

  function stop() {
    stopped = true
    clearTimeout(timer)
  }

  mcp.oninitialized = () => {
    start()
  }

  return { mcp, start, stop, poll }
}

// Every string a Claude passes to a tool, however deep.
function redactArgs(value) {
  const kinds = new Set()
  const walk = (item) => {
    if (typeof item === 'string') {
      const found = redactSecrets(item)
      for (const kind of found.kinds) kinds.add(kind)
      return found.text
    }
    if (Array.isArray(item)) return item.map(walk)
    if (typeof item === 'object' && item !== null) return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]))
    return item
  }
  return { args: walk(value), kinds: [...kinds] }
}

function errorResult(message) {
  return { content: [{ type: 'text', text: `coop: ${message}` }], isError: true }
}

/** @param {{ profileName?: string }} [options] */
export async function runMcpServer({ profileName } = {}) {
  const profile = getProfile(profileName)
  const server = createCoopServer({ profile })
  const shutdown = () => {
    server.stop()
    process.exit(0)
  }
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  server.mcp.onclose = shutdown
  await server.mcp.connect(new StdioServerTransport())
}
