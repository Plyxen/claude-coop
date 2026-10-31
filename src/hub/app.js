// The hub: a small JSON API that holds the crew, the task board and an event
// log. It only uses Web APIs (Request, Response, crypto.subtle), so the same
// code runs on Cloudflare Workers (cloudflare.js) and on Node (node.js).
import { SCHEMA } from './schema.js'

export const VERSION = '0.1.4'

const ONLINE_MS = 90_000
const SEEN_WRITE_MS = 30_000
const MAX_BODY = 64 * 1024
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const REQUEST_ID_RE = /^[a-km-z]{5}$/
const PRIORITIES = ['low', 'normal', 'high']
const ACTIVE = ['open', 'assigned', 'in_progress', 'blocked', 'review']
const HELD = ['assigned', 'in_progress', 'blocked']
const LIMITS = { title: 200, text: 20_000, scope: 2_000, branch: 200, url: 500 }

// Who may run each task action, from which statuses, and what it changes.
// "assignee" means the task's assignee or the lead.
const ACTIONS = {
  claim: { who: 'any', from: ['open', 'assigned'], event: 'task_claimed' },
  progress: { who: 'assignee', from: ['assigned', 'in_progress', 'blocked'], to: 'in_progress', needsNote: true, event: 'task_progress' },
  block: { who: 'assignee', from: ['assigned', 'in_progress'], to: 'blocked', needsNote: true, event: 'task_blocked' },
  submit: { who: 'assignee', from: ['in_progress', 'blocked'], to: 'review', needsNote: true, event: 'task_submitted' },
  release: { who: 'assignee', from: HELD, event: 'task_released' },
  approve: { who: 'lead', from: ['review'], to: 'done', event: 'task_approved' },
  changes: { who: 'lead', from: ['review', 'done'], to: 'in_progress', needsNote: true, event: 'task_changes_requested' },
  assign: { who: 'lead', from: ACTIVE, event: 'task_assigned' },
  cancel: { who: 'lead', from: ACTIVE, to: 'cancelled', event: 'task_cancelled' },
  reopen: { who: 'lead', from: ['done', 'cancelled'], event: 'task_reopened' },
  comment: { who: 'any', from: null, needsNote: true, event: 'task_comment' },
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function createHub({ db, leadToken, leadName = 'lead', hubName = 'coop', maxWorkers = 8, now = () => Date.now() }) {
  if (!leadToken || leadToken.length < 16) throw new Error('The lead token (COOP_LEAD_TOKEN) must be set and at least 16 characters long.')
  if (!NAME_RE.test(leadName)) throw new Error(`Lead name "${leadName}" is not valid: use lowercase letters, digits, - and _ (max 32).`)

  let ready
  const iso = () => new Date(now()).toISOString()

  async function init() {
    for (const statement of SCHEMA) await db.run(statement)
    const leadHash = await sha256(leadToken)
    // One lead: retire any earlier lead row, then make sure this one exists.
    await db.run("UPDATE members SET revoked = 1, token_hash = 'retired:' || name WHERE (role = 'lead' OR token_hash = ?) AND name != ?", [leadHash, leadName])
    await db.run(
      `INSERT INTO members (name, role, token_hash, created_at) VALUES (?, 'lead', ?, ?)
       ON CONFLICT(name) DO UPDATE SET role = 'lead', token_hash = excluded.token_hash, revoked = 0`,
      [leadName, leadHash, iso()],
    )
  }

  async function fetch(request) {
    try {
      ready ??= init().catch((error) => {
        ready = undefined
        throw error
      })
      await ready
      return await route(request)
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status)
      console.error(error)
      return json({ error: 'internal error' }, 500)
    }
  }

  async function route(request) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = request.method

    if (method === 'GET' && (path === '/' || path === '/health')) return json({ ok: true, hub: hubName, version: VERSION })
    if (!path.startsWith('/v1/')) throw new HttpError(404, 'not found')

    const me = await authenticate(request)
    const body = method === 'POST' ? await readBody(request) : {}
    const [section, id, action, extra] = path.split('/').slice(2)
    if (extra !== undefined) throw new HttpError(404, 'not found')

    if (section === 'me' && !id && method === 'GET') return json(await meInfo(me))
    if (section === 'board' && !id && method === 'GET') return json(await board(me))
    if (section === 'events' && !id && method === 'GET') return json(await events(me, url.searchParams))
    if (section === 'tasks') {
      if (!id && method === 'POST') return json(await createTask(me, body), 201)
      if (!id && method === 'GET') return json(await listTasks(url.searchParams))
      if (id && !action && method === 'GET') return json(await taskWithHistory(me, parseId(id)))
      if (id && action && method === 'POST') return json(await taskAction(me, parseId(id), action, body))
    }
    if (section === 'messages' && !id && method === 'POST') return json(await sendMessage(me, body), 201)
    if (section === 'members') {
      if (!id && method === 'POST') return json(await invite(me, body), 201)
      if (id && !action && method === 'DELETE') return json(await removeMember(me, id))
    }
    if (section === 'permissions') {
      if (!id && method === 'POST') return json(await permissionRequest(me, body), 201)
      if (id === 'verdict' && !action && method === 'POST') return json(await permissionVerdict(me, body))
    }
    throw new HttpError(404, 'not found')
  }

  // --- members -------------------------------------------------------------

  async function authenticate(request) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '')
    if (!match) throw new HttpError(401, 'missing bearer token')
    const member = await db.get('SELECT name, role, last_seen FROM members WHERE token_hash = ? AND revoked = 0', [await sha256(match[1])])
    if (!member) throw new HttpError(401, 'unknown or revoked token')

    // Presence: write last_seen at most every 30 s, and announce a member
    // who comes back after being away. One-off CLI commands send
    // "x-coop-presence: off": only a running Claude session counts as online.
    if (request.headers.get('x-coop-presence') === 'off') return member
    const last = member.last_seen ? Date.parse(member.last_seen) : 0
    if (now() - last >= SEEN_WRITE_MS) {
      member.last_seen = iso()
      await db.run('UPDATE members SET last_seen = ? WHERE name = ?', [member.last_seen, member.name])
      if (now() - last > ONLINE_MS) await addEvent(member, 'member_online', { text: `${member.name} is online` })
    }
    return member
  }

  async function activeMember(name, field = 'to') {
    const clean = String(name ?? '').trim().toLowerCase()
    const member = clean && (await db.get('SELECT name, role FROM members WHERE name = ? AND revoked = 0', [clean]))
    if (!member) throw new HttpError(404, `${field}: no crew member named "${clean}"`)
    return member
  }

  async function leadMember() {
    return db.get("SELECT name, role FROM members WHERE role = 'lead' AND revoked = 0")
  }

  async function meInfo(me) {
    const latest = await db.get('SELECT MAX(id) AS id FROM events')
    return { name: me.name, role: me.role, hub: hubName, version: VERSION, lead: (await leadMember())?.name ?? null, latest_event_id: latest?.id ?? 0 }
  }

  async function invite(me, body) {
    requireLead(me, 'invite people')
    const name = memberName(body.name)
    const existing = await db.get('SELECT role, revoked FROM members WHERE name = ?', [name])
    if (existing?.role === 'lead' && !existing.revoked) throw new HttpError(409, `"${name}" is the lead's name`)
    const active = existing && !existing.revoked
    if (!active) {
      const { n } = await db.get("SELECT COUNT(*) AS n FROM members WHERE role = 'worker' AND revoked = 0")
      if (n >= maxWorkers) throw new HttpError(409, `the crew is full (${maxWorkers} workers): remove someone first, or raise COOP_MAX_WORKERS on the hub`)
    }
    const token = newToken()
    await db.run(
      `INSERT INTO members (name, role, token_hash, created_at) VALUES (?, 'worker', ?, ?)
       ON CONFLICT(name) DO UPDATE SET role = 'worker', token_hash = excluded.token_hash, revoked = 0, last_seen = NULL`,
      [name, await sha256(token), iso()],
    )
    await addEvent(me, active ? 'member_token_rotated' : 'member_invited', {
      text: active ? `${name} got a new token (the old one stopped working)` : `${name} was invited to the crew`,
      data: { name },
    })
    return { name, role: 'worker', token, rotated: Boolean(active) }
  }

  async function removeMember(me, rawName) {
    requireLead(me, 'remove people')
    let decoded
    try {
      decoded = decodeURIComponent(rawName)
    } catch {
      throw new HttpError(400, 'bad member name')
    }
    const name = memberName(decoded)
    const member = await activeMember(name, 'name')
    if (member.role === 'lead') throw new HttpError(409, "the lead can't be removed")
    await db.run('UPDATE members SET revoked = 1, token_hash = ? WHERE name = ?', [`revoked:${name}:${now()}`, name])
    // Whatever they were holding goes back to the pool.
    const held = await db.all(`SELECT id FROM tasks WHERE assignee = ? AND status IN (${marks(HELD)})`, [name, ...HELD])
    await db.run(`UPDATE tasks SET status = 'open', assignee = NULL, updated_at = ? WHERE assignee = ? AND status IN (${marks(HELD)})`, [iso(), name, ...HELD])
    await addEvent(me, 'member_removed', { text: `${name} left the crew`, data: { name, released: held.map((t) => t.id) } })
    return { removed: name, released: held.map((t) => t.id) }
  }

  // --- board and events ----------------------------------------------------

  async function board(me) {
    const members = await db.all('SELECT name, role, last_seen FROM members WHERE revoked = 0 ORDER BY role, name')
    const tasks = await db.all(`SELECT * FROM tasks WHERE status IN (${marks(ACTIVE)}) ORDER BY id`, ACTIVE)
    const recentlyDone = await db.all("SELECT * FROM tasks WHERE status = 'done' ORDER BY updated_at DESC, id DESC LIMIT 5")
    const v = visibility(me, { includeOwn: true })
    const recent = await db.all(`SELECT * FROM events WHERE ${v.where} ORDER BY id DESC LIMIT 15`, v.params)
    return {
      hub: hubName,
      me: me.name,
      role: me.role,
      members: members.map((m) => ({
        name: m.name,
        role: m.role,
        online: Boolean(m.last_seen) && now() - Date.parse(m.last_seen) < ONLINE_MS,
        last_seen: m.last_seen,
        working_on: tasks.filter((t) => t.assignee === m.name && (t.status === 'in_progress' || t.status === 'blocked')).map((t) => t.id),
      })),
      tasks,
      recently_done: recentlyDone,
      recent: recent.reverse().map(eventOut),
    }
  }

  // Leads see everything. Workers see broadcasts and what's addressed to them.
  function visibility(me, { includeOwn = false } = {}) {
    if (me.role === 'lead') return includeOwn ? { where: '1 = 1', params: [] } : { where: 'actor != ?', params: [me.name] }
    return includeOwn
      ? { where: '(target IS NULL OR target = ? OR actor = ?)', params: [me.name, me.name] }
      : { where: 'actor != ? AND (target IS NULL OR target = ?)', params: [me.name, me.name] }
  }

  async function events(me, search) {
    const after = Math.max(0, Number.parseInt(search.get('after') ?? '0', 10) || 0)
    const limit = Math.min(200, Math.max(1, Number.parseInt(search.get('limit') ?? '100', 10) || 100))
    // Read the newest id first, so an event written during this request is
    // never skipped by the cursor.
    const latest = (await db.get('SELECT MAX(id) AS id FROM events'))?.id ?? 0
    const v = visibility(me)
    const rows = await db.all(`SELECT * FROM events WHERE id > ? AND id <= ? AND ${v.where} ORDER BY id LIMIT ?`, [after, latest, ...v.params, limit])
    const cursor = rows.length === limit ? rows.at(-1).id : Math.max(after, latest)
    return { events: rows.map(eventOut), cursor }
  }

  async function addEvent(actor, type, { target = null, taskId = null, text = '', data = {} } = {}) {
    const result = await db.run(
      'INSERT INTO events (ts, type, actor, actor_role, target, task_id, text, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [iso(), type, actor.name, actor.role, target, taskId, text, JSON.stringify(data)],
    )
    return result.lastId
  }

  // --- tasks ---------------------------------------------------------------

  async function getTask(id) {
    const task = await db.get('SELECT * FROM tasks WHERE id = ?', [id])
    if (!task) throw new HttpError(404, `no task #${id}`)
    return task
  }

  async function listTasks(search) {
    const status = search.get('status')
    const limit = Math.min(200, Math.max(1, Number.parseInt(search.get('limit') ?? '50', 10) || 50))
    if (status && !ACTIVE.concat('done', 'cancelled').includes(status)) throw new HttpError(400, `unknown status "${status}"`)
    const tasks = status
      ? await db.all('SELECT * FROM tasks WHERE status = ? ORDER BY id DESC LIMIT ?', [status, limit])
      : await db.all('SELECT * FROM tasks ORDER BY id DESC LIMIT ?', [limit])
    return { tasks }
  }

  async function taskWithHistory(me, id) {
    const task = await getTask(id)
    const v = visibility(me, { includeOwn: true })
    const history = await db.all(`SELECT * FROM events WHERE task_id = ? AND ${v.where} ORDER BY id`, [id, ...v.params])
    return { task, history: history.map(eventOut) }
  }

  async function createTask(me, body) {
    requireLead(me, 'create tasks')
    const title = str(body.title, 'title', LIMITS.title, true)
    const details = str(body.details, 'details', LIMITS.text)
    const scope = str(body.scope, 'scope', LIMITS.scope)
    const branch = str(body.branch, 'branch', LIMITS.branch)
    const priority = body.priority ?? 'normal'
    if (!PRIORITIES.includes(priority)) throw new HttpError(400, `priority must be one of ${PRIORITIES.join(', ')}`)
    const assignee = body.to ? (await activeMember(body.to)).name : null
    const created = iso()
    const { lastId: id } = await db.run(
      `INSERT INTO tasks (title, details, status, assignee, created_by, priority, scope, branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, details, assignee ? 'assigned' : 'open', assignee, me.name, priority, scope, branch, created, created],
    )
    if (!branch) await db.run('UPDATE tasks SET branch = ? WHERE id = ?', [branchName(id, title), id])
    const task = await getTask(id)
    await addEvent(me, 'task_created', { taskId: id, text: details, data: taskData(task) })
    return { task }
  }

  async function taskAction(me, id, action, body) {
    const spec = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null
    if (!spec) throw new HttpError(404, `unknown task action "${action}"`)
    const task = await getTask(id)
    const isLead = me.role === 'lead'

    if (spec.who === 'lead' && !isLead) throw new HttpError(403, `only the lead can ${action} tasks`)
    if (spec.who === 'assignee' && !isLead && task.assignee !== me.name) {
      throw new HttpError(403, `task #${id} isn't yours (${task.assignee ? `it's ${task.assignee}'s` : 'nobody has claimed it'})`)
    }
    if (spec.from && !spec.from.includes(task.status)) throw new HttpError(409, `task #${id} is ${task.status}, so it can't be ${pastTense(action)}`)

    const note = str(body.note, 'note', LIMITS.text, spec.needsNote)
    const changes = {}
    switch (action) {
      case 'claim':
        if (task.status === 'assigned' && task.assignee !== me.name) throw new HttpError(409, `task #${id} is assigned to ${task.assignee}`)
        changes.status = 'in_progress'
        changes.assignee = me.name
        break
      case 'release':
        changes.status = 'open'
        changes.assignee = null
        break
      case 'submit':
        changes.status = 'review'
        changes.summary = note
        if (body.branch) changes.branch = str(body.branch, 'branch', LIMITS.branch)
        if (body.pr_url) changes.pr_url = str(body.pr_url, 'pr_url', LIMITS.url)
        break
      case 'assign':
      case 'reopen': {
        const to = body.to ? (await activeMember(body.to)).name : null
        changes.assignee = to
        changes.status = to ? 'assigned' : 'open'
        break
      }
      default:
        if (spec.to) changes.status = spec.to
    }

    if (Object.keys(changes).length) {
      changes.updated_at = iso()
      const sets = Object.keys(changes).map((key) => `${key} = ?`).join(', ')
      // Only apply if nobody changed the task since we read it.
      const result = await db.run(`UPDATE tasks SET ${sets} WHERE id = ? AND status = ? AND assignee IS ?`, [...Object.values(changes), id, task.status, task.assignee])
      if (!result.changes) throw new HttpError(409, `task #${id} changed while you were updating it: check the board and try again`)
    } else {
      await db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', [iso(), id])
    }

    const updated = await getTask(id)
    await addEvent(me, spec.event, {
      taskId: id,
      text: note,
      data: { ...taskData(updated), previous_status: task.status, previous_assignee: task.assignee },
    })
    return { task: updated }
  }

  // --- messages and permission relay ----------------------------------------

  async function sendMessage(me, body) {
    const text = str(body.text, 'text', LIMITS.text, true)
    let to = null
    if (body.to) {
      const wanted = String(body.to).trim().toLowerCase()
      to = wanted === 'lead' ? (await leadMember())?.name : (await activeMember(wanted)).name
      if (to === me.name) throw new HttpError(400, "you can't message yourself")
    }
    const taskId = body.task_id ? (await getTask(parseId(String(body.task_id)))).id : null
    const id = await addEvent(me, 'message', { target: to, taskId, text, data: { to } })
    return { id, to }
  }

  async function permissionRequest(me, body) {
    if (me.role !== 'worker') throw new HttpError(403, 'only workers relay permission requests')
    const requestId = String(body.request_id ?? '')
    if (!REQUEST_ID_RE.test(requestId)) throw new HttpError(400, 'request_id must be five letters a-z without l')
    const lead = await leadMember()
    const id = await addEvent(me, 'permission_request', {
      target: lead.name,
      text: clip(body.description, 1_000),
      data: { request_id: requestId, tool_name: clip(body.tool_name, 100), input_preview: clip(body.input_preview, 4_000) },
    })
    return { id }
  }

  async function permissionVerdict(me, body) {
    requireLead(me, 'answer permission requests')
    const worker = memberName(body.worker)
    const requestId = String(body.request_id ?? '')
    const behavior = body.behavior
    if (behavior !== 'allow' && behavior !== 'deny') throw new HttpError(400, 'behavior must be allow or deny')
    const request = await db.get(
      "SELECT id FROM events WHERE type = 'permission_request' AND actor = ? AND json_extract(data, '$.request_id') = ? ORDER BY id DESC LIMIT 1",
      [worker, requestId],
    )
    if (!request) throw new HttpError(404, `no permission request "${requestId}" from ${worker}`)
    const answered = await db.get(
      "SELECT id FROM events WHERE type = 'permission_verdict' AND target = ? AND json_extract(data, '$.request_id') = ? AND id > ?",
      [worker, requestId, request.id],
    )
    if (answered) throw new HttpError(409, `permission request "${requestId}" was already answered`)
    const id = await addEvent(me, 'permission_verdict', { target: worker, text: behavior, data: { request_id: requestId, behavior } })
    return { id }
  }

  return { fetch }
}

// --- helpers ---------------------------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function readBody(request) {
  const raw = await request.text()
  if (raw.length > MAX_BODY) throw new HttpError(413, 'request body too large')
  if (!raw.trim()) return {}
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'body must be JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'body must be a JSON object')
  return value
}

function requireLead(me, what) {
  if (me.role !== 'lead') throw new HttpError(403, `only the lead can ${what}`)
}

function memberName(value) {
  const name = String(value ?? '').trim().toLowerCase()
  if (!NAME_RE.test(name)) throw new HttpError(400, 'names use lowercase letters, digits, - and _ (max 32 characters)')
  return name
}

function parseId(value) {
  const id = Number(String(value).replace(/^#/, ''))
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, `"${value}" is not a task number`)
  return id
}

function str(value, field, max, required = false) {
  if (value === undefined || value === null) value = ''
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`)
  value = value.trim()
  if (required && !value) throw new HttpError(400, `${field} is required`)
  if (value.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`)
  return value
}

function clip(value, max) {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function marks(list) {
  return list.map(() => '?').join(', ')
}

function taskData(task) {
  return {
    title: task.title,
    status: task.status,
    assignee: task.assignee,
    priority: task.priority,
    scope: task.scope,
    branch: task.branch,
    pr_url: task.pr_url,
  }
}

function eventOut(row) {
  let data = {}
  try {
    data = JSON.parse(row.data || '{}')
  } catch {}
  return { ...row, data }
}

function pastTense(action) {
  return { claim: 'claimed', submit: 'submitted', approve: 'approved', changes: 'sent back', assign: 'reassigned', cancel: 'cancelled', reopen: 'reopened', release: 'released', block: 'blocked', progress: 'updated' }[action] ?? action
}

// Words a shortened branch name shouldn't end on ("...-claude-md-for").
const DANGLING = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'of', 'or', 'the', 'to', 'with'])

export function branchName(id, title) {
  const words = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  // Whole words, up to 40 characters.
  const kept = []
  for (const word of words) {
    if ([...kept, word].join('-').length > 40) break
    kept.push(word)
  }
  if (kept.length < words.length) {
    while (kept.length > 1 && DANGLING.has(kept.at(-1))) kept.pop()
    if (!kept.length) kept.push(words[0].slice(0, 40))
  }
  const slug = kept.join('-')
  return `coop/${id}${slug ? `-${slug}` : ''}`
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return `coop_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}
