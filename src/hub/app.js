// The hub: a small JSON API that holds the crew, the task board and an event
// log. It only uses Web APIs (Request, Response, crypto.subtle), so the same
// code runs on Cloudflare Workers (cloudflare.js) and on Node (node.js).
//
// Everything a client sends is treated as hostile, including what a lead's
// Claude sends with the lead's token. Rules live here, not in what Claude is told.
import { redactSecrets } from '../secrets.js'
import { RESERVED_NAMES, branchProblem, cleanText, constantTimeEqual, httpsUrlProblem, isCrewName, isMemberName } from '../validate.js'
import { classifyRisk } from './risk.js'
import { migrate } from './schema.js'

export const VERSION = '0.2.0'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const ONLINE_MS = 90_000
const SEEN_WRITE_MS = 30_000
const TOKEN_USE_WRITE_MS = 5 * MINUTE
const AWAY_MS = 15 * MINUTE
const MAX_BODY = 64 * 1024
const MAX_URL = 2_048
const MAX_SKEW_MS = 5 * MINUTE
const REQUEST_ID_RE = /^[a-km-z]{5}$/
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const APPROVAL_KEY_RE = /^[0-9a-f]{64}$/
const APPROVAL_SALT_RE = /^[0-9a-f]{32,128}$/
const APPROVAL_KDF_RE = /^scrypt:\d{1,8}:\d{1,3}:\d{1,3}$/
const PRIORITIES = ['low', 'normal', 'high']
const ACTIVE = ['open', 'assigned', 'in_progress', 'blocked', 'review']
const HELD = ['assigned', 'in_progress', 'blocked']
const LIMITS = { title: 200, text: 20_000, scope: 2_000, label: 60 }
const MAX_ACTIVE_TASKS = 2_000
const MAX_PENDING_PERMISSIONS = 20
const APPROVAL_ATTEMPTS = 5
const APPROVAL_WINDOW = 15 * MINUTE

// Per member and generous: normal crew work stays far below these. Reads count
// separately, in memory, so that polling never costs a database write.
const RATE_LIMITS = {
  task_create: [120, HOUR],
  task_action: [600, HOUR],
  message: [240, HOUR],
  permission: [120, HOUR],
  member: [30, HOUR],
  token: [30, HOUR],
}
// Counted in memory, so that a flood costs no database writes. On Cloudflare each
// isolate counts for itself, which makes these approximate.
const MAX_READS_PER_MINUTE = 600
const MAX_WRITES_PER_MINUTE = 120
const MAX_AUTH_FAILURES_PER_MINUTE = 20
// Past these, what's refused is still refused, but no longer logged.
const MAX_AUTH_FAILURES_LOGGED_PER_MINUTE = 10
const MAX_REFUSALS_LOGGED_PER_MINUTE = 30

// What each role may do. The hub checks this on every request: hiding a tool
// from a Claude or a command from the CLI is never what keeps someone out.
// Anyone with a token may also list, rotate and revoke their own tokens.
const CAN = {
  lead: new Set(['read', 'work', 'message', 'manage_tasks', 'manage_members', 'manage_tokens', 'answer_permissions', 'read_audit', 'configure']),
  worker: new Set(['read', 'work', 'message', 'ask_permission']),
  observer: new Set(['read']),
}

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

// What gets the lead's attention, and after how many in the window. Alert text
// only ever holds counts and names that passed validation.
const ALERTS = {
  auth_failure: { threshold: 10, windowMs: 10 * MINUTE, text: (who) => `Repeated failed sign-ins (source ${who}).` },
  revoked_token: { threshold: 3, windowMs: 10 * MINUTE, text: (who) => `A revoked or expired token of ${who} is still being used.` },
  forbidden: { threshold: 10, windowMs: 10 * MINUTE, text: (who) => `${who} keeps trying things their role doesn't allow.` },
  bad_input: { threshold: 30, windowMs: 10 * MINUTE, text: (who) => `${who} keeps sending malformed or refused input.` },
  replay: { threshold: 3, windowMs: 10 * MINUTE, text: (who) => `Requests from ${who} were replayed.` },
  rate_limited: { threshold: 3, windowMs: 10 * MINUTE, text: (who) => `${who} keeps hitting rate limits: unusual volume.` },
  approval_failure: { threshold: 3, windowMs: APPROVAL_WINDOW, text: (who) => `Wrong approval passphrase, tried with ${who}'s token. If that wasn't a person typing it, treat the lead token as exposed.` },
  secret_redacted: { threshold: 1, windowMs: HOUR, text: (who) => `Something that looked like a secret was removed from what ${who} sent. Check whether it needs rotating.` },
}

const DEFAULT_CODES = { 400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 410: 'expired', 413: 'too_large', 414: 'too_large', 429: 'rate_limited' }

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {{ code?: string, retryAfter?: number, quiet?: boolean }} [details]
   */
  constructor(status, message, { code, retryAfter, quiet = false } = {}) {
    super(message)
    this.status = status
    this.code = code ?? DEFAULT_CODES[status] ?? 'error'
    this.retryAfter = retryAfter
    this.quiet = quiet
  }
}

/** @param {Record<string, any>} options */
export function createHub({
  db,
  leadToken,
  leadTokenHash,
  leadName = 'lead',
  hubName = 'coop',
  maxWorkers = 8,
  tokenTtlDays = 90,
  retentionDays = 90,
  permissionTtlMs = 10 * MINUTE,
  rateLimits = RATE_LIMITS,
  maxWritesPerMinute = MAX_WRITES_PER_MINUTE,
  clientAddress = (request) => request.headers.get('x-coop-client-address'),
  now = () => Date.now(),
}) {
  if (!leadTokenHash && (!leadToken || leadToken.length < 24)) throw new Error('The lead token (COOP_LEAD_TOKEN) must be set and at least 24 characters long. `coop token` prints a good one.')
  if (!isMemberName(leadName)) throw new Error(`Lead name "${cleanText(leadName)}" is not valid: use lowercase letters, digits, - and _ (max 32).`)
  if (!isCrewName(hubName)) throw new Error('The crew name is not valid: use letters, digits, spaces and . _ - (max 64).')

  let ready
  let nextMaintenance = 0
  const reads = new Map()
  const writes = new Map()
  const authFailures = new Map()
  const refusals = new Map()
  const iso = (time = now()) => new Date(time).toISOString()

  async function init() {
    await migrate(db)
    const hash = leadTokenHash ?? (await sha256(leadToken))
    const current = await db.get(
      `SELECT t.id FROM tokens t JOIN members m ON m.name = t.member
       WHERE t.token_hash = ? AND t.member = ? AND t.revoked_at IS NULL AND m.role = 'lead' AND m.revoked = 0`,
      [hash, leadName],
    )
    if (current) return
    // One lead, one lead token: retire any earlier lead and anyone else holding
    // this token, then make sure this one exists.
    const at = iso()
    await db.batch([
      ["UPDATE members SET revoked = 1 WHERE role = 'lead' AND name != ?", [leadName]],
      [
        `UPDATE tokens SET revoked_at = ? WHERE revoked_at IS NULL
         AND (member = ? OR member IN (SELECT name FROM members WHERE role = 'lead' AND name != ?))`,
        [at, leadName, leadName],
      ],
      ['UPDATE members SET revoked = 1 WHERE name IN (SELECT member FROM tokens WHERE token_hash = ?) AND name != ?', [hash, leadName]],
      ['DELETE FROM tokens WHERE token_hash = ?', [hash]],
      [
        `INSERT INTO members (name, role, token_hash, created_at) VALUES (?, 'lead', ?, ?)
         ON CONFLICT(name) DO UPDATE SET role = 'lead', revoked = 0`,
        [leadName, `member:${leadName}`, at],
      ],
      ["INSERT INTO tokens (id, member, token_hash, label, created_at, created_by) VALUES (?, ?, ?, 'lead', ?, 'hub')", [newTokenId(), leadName, hash, at]],
    ])
  }

  async function fetch(request) {
    const ctx = { requestId: crypto.randomUUID(), me: null, address: clientAddress(request) ?? 'unknown' }
    let response
    try {
      ready ??= init().catch((error) => {
        ready = undefined
        throw error
      })
      await ready
      response = await route(request, ctx)
    } catch (error) {
      response = await failure(error, ctx)
    }
    response.headers.set('x-request-id', ctx.requestId)
    return response
  }

  // Remote clients get a stable category and a safe sentence. Details stay in
  // the hub's own log, under the request id.
  async function failure(error, ctx) {
    if (!(error instanceof HttpError)) {
      console.error(`[hub] request ${ctx.requestId} failed:`, error)
      return json({ error: 'internal error', code: 'internal', request_id: ctx.requestId }, 500)
    }
    if (!error.quiet) {
      try {
        await recordRefusal(error, ctx)
      } catch (recordError) {
        console.error(`[hub] couldn't record refused request ${ctx.requestId}:`, recordError)
      }
    }
    return json({ error: error.message, code: error.code }, error.status, error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {})
  }

  async function recordRefusal(error, ctx) {
    if (![400, 403, 413, 414, 429].includes(error.status)) return
    const subject = ctx.me?.name ?? (await sourceOf(ctx))
    if (tally(refusals, subject) > MAX_REFUSALS_LOGGED_PER_MINUTE) return
    if (error.status === 403) {
      await audit(ctx, 'access_denied', { result: 'denied', detail: { code: error.code } })
      await note('forbidden', subject, ctx)
    } else if (error.status === 400 || error.status === 413 || error.status === 414) {
      await audit(ctx, 'input_rejected', { result: 'denied', detail: { code: error.code } })
      await note('bad_input', subject, ctx)
    } else if (error.status === 429) {
      await audit(ctx, 'rate_limited', { result: 'denied' })
      await note('rate_limited', subject, ctx)
    }
  }

  async function route(request, ctx) {
    // Before sign-in, so it isn't logged: that would be a free database write for anyone.
    if (request.url.length > MAX_URL) throw new HttpError(414, 'request address too long', { quiet: true })
    const url = new URL(request.url)
    const path = trimSlashes(url.pathname) || '/'
    const method = request.method

    if (method === 'GET' && (path === '/' || path === '/health')) return json({ ok: true, service: 'claude-code-multi-pc' })
    if (!path.startsWith('/v1/')) throw new HttpError(404, 'not found', { quiet: true })

    const me = await authenticate(request, ctx)
    ctx.me = me
    await maintain(ctx)
    if (method === 'GET') limitReads(me)
    else limitWrites(me)
    const body = method === 'POST' ? await readBody(request) : {}
    const [section, id, action, extra] = path.split('/').slice(2)
    if (extra !== undefined) throw new HttpError(404, 'not found')

    if (method === 'GET') return get(me, ctx, url.searchParams, section, id, action)
    return replayGuarded(request, ctx, { section, id }, () => change(me, ctx, method, section, id, action, body))
  }

  async function get(me, ctx, search, section, id, action) {
    if (section === 'me' && !id) return json(await meInfo(me))
    if (section === 'board' && !id) return json(await board(me))
    if (section === 'events' && !id) return json(await events(me, search))
    if (section === 'tasks' && !id) return json(await listTasks(search))
    if (section === 'tasks' && !action) return json(await taskWithHistory(me, parseId(id)))
    if (section === 'tokens' && !id) return json(await listTokens(me, search))
    if (section === 'permissions' && !id) return json(await listPermissions(me, search))
    if (section === 'approvals' && !id) return json(await approvalStatus(me))
    if (section === 'audit' && !id) return json(await auditEntries(me, search))
    throw new HttpError(404, 'not found')
  }

  async function change(me, ctx, method, section, id, action, body) {
    if (method === 'POST') {
      if (section === 'tasks' && !id) return json(await createTask(me, ctx, body), 201)
      if (section === 'tasks' && id && action) return json(await taskAction(me, ctx, parseId(id), action, body))
      if (section === 'messages' && !id) return json(await sendMessage(me, ctx, body), 201)
      if (section === 'members' && !id) return json(await invite(me, ctx, body), 201)
      if (section === 'permissions' && !id) return json(await permissionRequest(me, ctx, body), 201)
      if (section === 'permissions' && id === 'verdict' && !action) return json(await permissionVerdict(me, ctx, body))
      if (section === 'tokens' && id === 'rotate' && !action) return json(await rotateOwnToken(me, ctx))
      if (section === 'tokens' && id === 'revoke-all' && !action) return json(await revokeAllTokens(me, ctx, body))
      if (section === 'approvals' && id === 'setup' && !action) return json(await approvalSetup(me, ctx, body))
    }
    if (method === 'DELETE') {
      if (section === 'members' && id && !action) return json(await removeMember(me, ctx, id))
      if (section === 'tokens' && id && !action) return json(await revokeToken(me, ctx, id))
    }
    throw new HttpError(404, 'not found')
  }

  // --- replay protection ---------------------------------------------------

  // Clients send a unique x-coop-request-id and x-coop-timestamp with changes.
  // A repeat doesn't run twice: it gets the first answer back, or a refusal
  // when that answer held a secret. Sensitive operations refuse to run without
  // them. Older workers' routine calls don't send them and still work: the task
  // state machine stops those from applying twice.
  async function replayGuarded(request, ctx, { section, id }, run) {
    const sensitive = ['members', 'tokens', 'approvals'].includes(section) || (section === 'permissions' && id === 'verdict')
    const requestId = request.headers.get('x-coop-request-id')
    if (!requestId) {
      if (sensitive) throw new HttpError(400, 'this request needs x-coop-request-id and x-coop-timestamp: update coop', { code: 'request_id_required' })
      return run()
    }
    if (!CLIENT_REQUEST_ID_RE.test(requestId)) throw new HttpError(400, 'x-coop-request-id must be 8 to 64 letters, digits, - or _')
    ctx.requestId = requestId
    const stamp = Number(request.headers.get('x-coop-timestamp'))
    if (Number.isFinite(stamp) && stamp > 0 ? Math.abs(now() - stamp) > MAX_SKEW_MS : sensitive) {
      throw new HttpError(400, "this request is too old, or this PC's clock is off by more than 5 minutes", { code: 'stale_request' })
    }

    const member = ctx.me.name
    const { changes } = await db.run('INSERT OR IGNORE INTO request_log (member, request_id, created_at) VALUES (?, ?, ?)', [member, requestId, iso()])
    if (!changes) {
      await audit(ctx, 'replay_detected', { result: 'denied' })
      await note('replay', member, ctx)
      const first = await db.get('SELECT status, response FROM request_log WHERE member = ? AND request_id = ?', [member, requestId])
      if (first?.response) return new Response(first.response, { status: first.status, headers: { ...JSON_HEADERS, 'x-coop-replayed': '1' } })
      throw new HttpError(409, 'this request was already processed', { code: 'replay', quiet: true })
    }
    try {
      const response = await run()
      // A response with a token in it is never kept, not even for a day.
      if (sensitive) await db.run('UPDATE request_log SET status = ? WHERE member = ? AND request_id = ?', [response.status, member, requestId])
      else await db.run('UPDATE request_log SET status = ?, response = ? WHERE member = ? AND request_id = ?', [response.status, await response.clone().text(), member, requestId])
      return response
    } catch (error) {
      // It didn't happen, so the client may try it again.
      await db.run('DELETE FROM request_log WHERE member = ? AND request_id = ?', [member, requestId])
      throw error
    }
  }

  // --- rate limits, alerts and the audit log ---------------------------------

  // Counts in fixed windows. The update is atomic, so concurrent requests on
  // other isolates count too.
  async function hit(key, windowMs) {
    const start = now() - (now() % windowMs)
    const row = await db.get(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END, window_start = excluded.window_start
       RETURNING count`,
      [key, start],
    )
    return { count: row.count, retryAfter: Math.max(1, Math.ceil((start + windowMs - now()) / 1000)) }
  }

  async function limit(me, name) {
    const [max, windowMs] = rateLimits[name]
    const { count, retryAfter } = await hit(`limit:${name}:${me.name}`, windowMs)
    if (count > max) throw new HttpError(429, `too many requests, try again in ${retryAfter} seconds`, { retryAfter })
  }

  function tally(counts, key) {
    const minute = Math.floor(now() / MINUTE)
    let entry = counts.get(key)
    if (entry?.minute !== minute) {
      if (counts.size > 10_000) counts.clear()
      entry = { minute, count: 0 }
      counts.set(key, entry)
    }
    return ++entry.count
  }

  function limitReads(me) {
    if (tally(reads, me.name) > MAX_READS_PER_MINUTE) throw new HttpError(429, 'too many requests, try again in a minute', { retryAfter: 60 })
  }

  // Every change costs writes, even one that gets refused. This stops a flood
  // first. Only the first request over the limit gets logged.
  function limitWrites(me) {
    const count = tally(writes, me.name)
    if (count > maxWritesPerMinute) throw new HttpError(429, 'too many requests, try again in a minute', { retryAfter: 60, quiet: count > maxWritesPerMinute + 1 })
  }

  async function note(kind, subject, ctx) {
    const spec = ALERTS[kind]
    const { count } = await hit(`note:${kind}:${subject}`, spec.windowMs)
    if (count !== spec.threshold) return
    const lead = await leadMember()
    const text = spec.text(subject)
    await addEvent({ name: 'hub', role: 'system' }, 'security_alert', { target: lead?.name ?? null, text, data: { kind, subject } })
    await audit(ctx, 'security_alert', { target: subject, detail: { kind, count } })
  }

  // Structured and never holding tokens, keys or request bodies.
  async function audit(ctx, type, { target = null, result = 'ok', detail = {} } = {}) {
    await db.run('INSERT INTO audit_log (ts, type, actor, actor_role, target, request_id, source, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      iso(),
      type,
      ctx.me?.name ?? null,
      ctx.me?.role ?? null,
      target,
      ctx.requestId,
      await sourceOf(ctx),
      result,
      JSON.stringify(detail),
    ])
  }

  // A hash, so the log can tell sources apart without keeping addresses.
  async function sourceOf(ctx) {
    ctx.source ??= (await sha256(`coop-source:${ctx.address}`)).slice(0, 12)
    return ctx.source
  }

  async function auditEntries(me, search) {
    requireCan(me, 'read_audit', 'read the audit log')
    const after = boundedInt(search.get('after'), 0, 0)
    const count = boundedInt(search.get('limit'), 100, 1, 500)
    const type = search.get('type')
    if (type && !/^[a-z_]{1,40}$/.test(type)) throw new HttpError(400, 'unknown event type')
    const rows = type
      ? await db.all('SELECT * FROM audit_log WHERE id > ? AND type = ? ORDER BY id DESC LIMIT ?', [after, type, count])
      : await db.all('SELECT * FROM audit_log WHERE id > ? ORDER BY id DESC LIMIT ?', [after, count])
    return { entries: rows.map((row) => ({ ...row, detail: parseJson(row.detail) })) }
  }

  // Housekeeping, at most hourly, on whichever request comes along: Workers have
  // no background loop here. A failure must not fail the request that ran it.
  async function maintain(ctx) {
    if (now() < nextMaintenance) return
    nextMaintenance = now() + HOUR
    try {
      const last = Number((await getSetting('last_maintenance')) ?? 0)
      if (now() - last < HOUR) return
      await setSetting('last_maintenance', String(now()))
      await expireDuePermissions()
      await db.run('DELETE FROM request_log WHERE created_at < ?', [iso(now() - DAY)])
      await db.run('DELETE FROM rate_limits WHERE window_start < ?', [now() - DAY])
      if (retentionDays > 0) {
        const cutoff = iso(now() - retentionDays * DAY)
        await db.run('DELETE FROM events WHERE ts < ?', [cutoff])
        await db.run('DELETE FROM audit_log WHERE ts < ?', [cutoff])
        await db.run('DELETE FROM permission_requests WHERE created_at < ?', [cutoff])
        await db.run("DELETE FROM tasks WHERE updated_at < ? AND status IN ('done', 'cancelled')", [cutoff])
        await db.run('DELETE FROM tokens WHERE revoked_at IS NOT NULL AND revoked_at < ?', [cutoff])
      }
    } catch (error) {
      console.error(`[hub] maintenance failed during request ${ctx.requestId}:`, error)
    }
  }

  async function getSetting(key) {
    return (await db.get('SELECT value FROM settings WHERE key = ?', [key]))?.value
  }

  async function setSetting(key, value) {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
  }

  // --- authentication --------------------------------------------------------

  async function authenticate(request, ctx) {
    const match = /^Bearer\s+(\S{1,512})\s*$/i.exec(request.headers.get('authorization') ?? '')
    if (!match) {
      await authFailed(ctx, 'missing')
      throw new HttpError(401, 'missing bearer token')
    }
    // Looked up by hash, so timing can't be steered toward a token. A valid
    // token gets through even if others from the same address keep failing:
    // behind a tunnel, every member can share one.
    const row = await db.get(
      `SELECT t.id AS token_id, t.label AS token_label, t.expires_at, t.revoked_at, t.last_used_at, m.name, m.role, m.last_seen, m.revoked AS member_revoked
       FROM tokens t JOIN members m ON m.name = t.member WHERE t.token_hash = ?`,
      [await sha256(match[1])],
    )
    if (!row || row.revoked_at || row.member_revoked) {
      await authFailed(ctx, row ? 'revoked' : 'unknown', row?.name)
      throw new HttpError(401, 'unknown or revoked token', { quiet: true })
    }
    if (row.expires_at && Date.parse(row.expires_at) <= now()) {
      await authFailed(ctx, 'expired', row.name)
      throw new HttpError(401, 'this token has expired: ask your lead for a new one', { code: 'token_expired', quiet: true })
    }
    const member = {
      name: row.name,
      role: row.role,
      last_seen: row.last_seen,
      token_id: row.token_id,
      token_label: row.token_label,
      token_expires_at: row.expires_at,
    }

    // Bookkeeping never costs a valid member their answer: if the database can't
    // take writes right now (a used-up quota, say), reads keep working.
    try {
      await recordUse(request, ctx, member, row.last_used_at)
    } catch (error) {
      console.error(`[hub] couldn't record a sign-in (${ctx.requestId}):`, error)
    }
    return member
  }

  async function recordUse(request, ctx, member, lastUsedAt) {
    // Every few minutes is plenty for "last used", and polling keeps this running
    // all day, so it stays off the database's write quota as far as it can.
    const lastUsed = lastUsedAt ? Date.parse(lastUsedAt) : 0
    if (now() - lastUsed >= TOKEN_USE_WRITE_MS) {
      await db.run('UPDATE tokens SET last_used_at = ? WHERE id = ?', [iso(), member.token_id])
      if (now() - lastUsed > AWAY_MS) await audit({ ...ctx, me: member }, 'auth_success', { detail: { token: member.token_id } })
    }

    // Presence: write last_seen at most every 30 s, and announce a member
    // who comes back after being away. One-off CLI commands send
    // "x-coop-presence: off": only a running Claude session counts as online.
    if (request.headers.get('x-coop-presence') === 'off') return
    const last = member.last_seen ? Date.parse(member.last_seen) : 0
    if (now() - last >= SEEN_WRITE_MS) {
      member.last_seen = iso()
      await db.run('UPDATE members SET last_seen = ? WHERE name = ?', [member.last_seen, member.name])
      if (now() - last > ONLINE_MS) await addEvent(member, 'member_online', { text: `${member.name} is online` })
    }
  }

  // This is about the database's write quota, not about guessing: at 192 random
  // bits no rate would make guessing work. Only the first few failures a minute
  // from one source get logged, and past the limit nothing is even looked up again.
  async function authFailed(ctx, reason, memberName) {
    const source = await sourceOf(ctx)
    const count = tally(authFailures, source)
    if (count > MAX_AUTH_FAILURES_PER_MINUTE) throw new HttpError(429, 'too many failed sign-ins, try again in a minute', { retryAfter: 60, quiet: true })
    if (count > MAX_AUTH_FAILURES_LOGGED_PER_MINUTE) return
    // The request is refused whether or not this can be written down.
    try {
      await audit(ctx, 'auth_failure', { target: memberName ?? null, result: 'denied', detail: { reason } })
      if (memberName) await note('revoked_token', memberName, ctx)
      else if (reason === 'unknown') await note('auth_failure', source, ctx)
    } catch (error) {
      console.error(`[hub] couldn't record a failed sign-in (${ctx.requestId}):`, error)
    }
  }

  function tokenRecord(member, label, createdBy) {
    const token = newToken()
    const id = newTokenId()
    const expires_at = tokenTtlDays > 0 ? iso(now() + tokenTtlDays * DAY) : null
    return {
      id,
      token,
      expires_at,
      insert: async () => [
        'INSERT INTO tokens (id, member, token_hash, label, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, member, await sha256(token), label, iso(), createdBy, expires_at],
      ],
    }
  }

  async function listTokens(me, search) {
    const wanted = search.get('member')
    if (wanted && wanted !== me.name) requireCan(me, 'manage_tokens', "see other people's tokens")
    const isAll = me.role === 'lead' && !wanted
    const rows = isAll
      ? await db.all('SELECT id, member, label, created_at, created_by, expires_at, last_used_at, revoked_at FROM tokens ORDER BY member, created_at')
      : await db.all('SELECT id, member, label, created_at, created_by, expires_at, last_used_at, revoked_at FROM tokens WHERE member = ? ORDER BY created_at', [wanted ? memberName(wanted) : me.name])
    return { tokens: rows.map((row) => ({ ...row, current: row.id === me.token_id })) }
  }

  // Replaces the token this request used. The old one stops working at once, and
  // the new one gets a fresh expiry.
  async function rotateOwnToken(me, ctx) {
    if (me.role === 'lead') throw new HttpError(409, "the lead token comes from the hub's configuration: change it there (see docs/security.md)")
    await limit(me, 'token')
    const record = tokenRecord(me.name, me.token_label, me.name)
    await db.batch([await record.insert(), ['UPDATE tokens SET revoked_at = ? WHERE id = ?', [iso(), me.token_id]]])
    await audit(ctx, 'token_rotated', { target: me.name, detail: { old: me.token_id, new: record.id } })
    const lead = await leadMember()
    await addEvent(me, 'member_token_rotated', { target: lead?.name ?? null, text: `${me.name} rotated their token`, data: { name: me.name } })
    return { token: record.token, id: record.id, expires_at: record.expires_at }
  }

  async function revokeToken(me, ctx, rawId) {
    await limit(me, 'token')
    const id = String(rawId)
    if (!/^tok_[0-9a-f]{16}$/.test(id)) throw new HttpError(400, 'that is not a token id')
    const row = await db.get('SELECT t.id, t.member, t.revoked_at, m.role FROM tokens t JOIN members m ON m.name = t.member WHERE t.id = ?', [id])
    if (!row || (row.member !== me.name && !CAN[me.role].has('manage_tokens'))) throw new HttpError(404, `no token ${id}`)
    if (row.role === 'lead') throw new HttpError(409, "the lead token comes from the hub's configuration: change it there (see docs/security.md)")
    await db.run('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [iso(), id])
    await audit(ctx, 'token_revoked', { target: row.member, detail: { token: id } })
    return { revoked: id, member: row.member }
  }

  async function revokeAllTokens(me, ctx, body) {
    await limit(me, 'token')
    const name = body.member === undefined ? me.name : memberName(body.member)
    if (name !== me.name) requireCan(me, 'manage_tokens', "revoke other people's tokens")
    const member = await db.get('SELECT role FROM members WHERE name = ?', [name])
    if (!member) throw new HttpError(404, `no crew member named "${name}"`)
    if (member.role === 'lead') throw new HttpError(409, "the lead token comes from the hub's configuration: change it there (see docs/security.md)")
    const { changes } = await db.run('UPDATE tokens SET revoked_at = ? WHERE member = ? AND revoked_at IS NULL', [iso(), name])
    await audit(ctx, 'tokens_revoked_all', { target: name, detail: { count: changes } })
    return { member: name, revoked: changes }
  }

  // --- the human gate --------------------------------------------------------

  // The lead's Claude holds the lead's token, so that token alone can't stand
  // for "a person decided this". Granting something (approving a permission
  // request, minting a credential) also takes a key derived from a passphrase
  // only a person knows. It's typed at `coop approve` and stored nowhere on the
  // PC. Refusing and revoking never need it, so a person is never slowed down
  // from shutting something off.
  async function requireHuman(me, ctx, body, what, { mandatory = false } = {}) {
    const stored = await getSetting('approval_key_hash')
    if (!stored) {
      if (mandatory) throw new HttpError(403, `to ${what}, the lead's person first has to set an approval passphrase: run coop approvals setup in a terminal`, { code: 'approval_setup_required' })
      return 'lead-token'
    }
    await checkApprovalKey(ctx, body.approval_key, stored, `to ${what}, a person has to confirm with the approval passphrase (coop approve, or coop invite, in their own terminal)`)
    return 'approval-passphrase'
  }

  async function checkApprovalKey(ctx, key, stored, missingMessage) {
    const name = ctx.me.name
    const key_ = `approval:${name}`
    const start = now() - (now() % APPROVAL_WINDOW)
    const seen = await db.get('SELECT count, window_start FROM rate_limits WHERE key = ?', [key_])
    if (seen?.window_start === start && seen.count >= APPROVAL_ATTEMPTS) {
      throw new HttpError(429, 'too many wrong passphrases: approvals are locked for up to 15 minutes', { retryAfter: Math.ceil((start + APPROVAL_WINDOW - now()) / 1000), code: 'approval_locked' })
    }
    if (key === undefined || key === null || key === '') throw new HttpError(403, missingMessage, { code: 'approval_required' })
    if (typeof key !== 'string' || !APPROVAL_KEY_RE.test(key) || !constantTimeEqual(await sha256(key), stored)) {
      await hit(key_, APPROVAL_WINDOW)
      await audit(ctx, 'approval_failed', { result: 'denied' })
      await note('approval_failure', name, ctx)
      throw new HttpError(403, 'wrong approval passphrase', { code: 'approval_invalid', quiet: true })
    }
  }

  async function approvalStatus(me) {
    requireCan(me, 'configure', 'see the approval settings')
    const [hash, salt, kdf, setAt] = await Promise.all(['approval_key_hash', 'approval_salt', 'approval_kdf', 'approval_set_at'].map(getSetting))
    return { configured: Boolean(hash), salt: salt ?? null, kdf: kdf ?? null, set_at: setAt ?? null }
  }

  async function approvalSetup(me, ctx, body) {
    requireCan(me, 'configure', 'set the approval passphrase')
    await limit(me, 'token')
    if (typeof body.key !== 'string' || !APPROVAL_KEY_RE.test(body.key)) throw new HttpError(400, 'key must be 64 hex characters')
    if (typeof body.salt !== 'string' || !APPROVAL_SALT_RE.test(body.salt)) throw new HttpError(400, 'salt must be hex')
    if (typeof body.kdf !== 'string' || !APPROVAL_KDF_RE.test(body.kdf)) throw new HttpError(400, 'kdf must look like scrypt:N:r:p')
    const stored = await getSetting('approval_key_hash')
    // Changing it takes the old one, so whatever holds only the lead token
    // can't replace a passphrase a person already set.
    if (stored) await checkApprovalKey(ctx, body.previous_key, stored, 'changing the approval passphrase takes the current one')
    const at = iso()
    await db.batch(
      [
        ['approval_key_hash', await sha256(body.key)],
        ['approval_salt', body.salt],
        ['approval_kdf', body.kdf],
        ['approval_set_at', at],
      ].map(([key, value]) => ['INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]]),
    )
    await audit(ctx, 'security_config_changed', { detail: { setting: 'approval_passphrase', replaced: Boolean(stored) } })
    await addEvent({ name: 'hub', role: 'system' }, 'security_alert', {
      target: me.name,
      text: stored ? 'The approval passphrase was changed.' : 'An approval passphrase was set. If your person did not just do this, the lead token is exposed.',
      data: { kind: 'approval_passphrase_set', subject: me.name },
    })
    return { configured: true, set_at: at }
  }

  // --- members -------------------------------------------------------------

  async function activeMember(name, field = 'to') {
    const clean = memberName(name)
    const member = await db.get('SELECT name, role FROM members WHERE name = ? AND revoked = 0', [clean])
    if (!member) throw new HttpError(404, `${field}: no crew member named "${clean}"`)
    return member
  }

  async function leadMember() {
    return db.get("SELECT name, role FROM members WHERE role = 'lead' AND revoked = 0")
  }

  async function meInfo(me) {
    const latest = await db.get('SELECT MAX(id) AS id FROM events')
    return {
      name: me.name,
      role: me.role,
      hub: hubName,
      version: VERSION,
      lead: (await leadMember())?.name ?? null,
      latest_event_id: latest?.id ?? 0,
      token: { id: me.token_id, label: me.token_label, expires_at: me.token_expires_at },
    }
  }

  // Inviting someone who's already in the crew replaces their tokens, unless
  // "device" asks for one more token, for another PC of theirs.
  async function invite(me, ctx, body) {
    requireCan(me, 'manage_members', 'invite people')
    await limit(me, 'member')
    const name = memberName(body.name)
    if (RESERVED_NAMES.includes(name)) throw new HttpError(400, `"${name}" means something else to coop: pick another name`)
    const role = body.role ?? null
    if (role !== null && role !== 'worker' && role !== 'observer') throw new HttpError(400, 'role must be worker or observer')
    const device = body.device === undefined ? '' : str(body.device, 'device', LIMITS.label, true)
    const existing = await db.get('SELECT role, revoked FROM members WHERE name = ?', [name])
    if (existing?.role === 'lead' && !existing.revoked) throw new HttpError(409, `"${name}" is the lead's name`)
    const active = Boolean(existing && !existing.revoked)
    if (device && !active) throw new HttpError(404, `no crew member named "${name}"`)
    const via = await requireHuman(me, ctx, body, 'invite people')
    if (!active) {
      const { n } = await db.get("SELECT COUNT(*) AS n FROM members WHERE role != 'lead' AND revoked = 0")
      if (n >= maxWorkers) throw new HttpError(409, `the crew is full (${maxWorkers} workers): remove someone first, or raise COOP_MAX_WORKERS on the hub`)
    }
    const finalRole = role ?? (active ? existing.role : 'worker')
    const record = tokenRecord(name, device || 'invite', me.name)
    const at = iso()
    await db.batch([
      ...(device ? [] : [['UPDATE tokens SET revoked_at = ? WHERE member = ? AND revoked_at IS NULL', [at, name]]]),
      [
        `INSERT INTO members (name, role, token_hash, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET role = excluded.role, revoked = 0${device ? '' : ', last_seen = NULL'}`,
        [name, finalRole, `member:${name}`, at],
      ],
      await record.insert(),
    ])
    const rotated = active && !device
    await audit(ctx, device ? 'token_created' : rotated ? 'token_rotated' : 'member_added', { target: name, detail: { role: finalRole, token: record.id, via, device: device || undefined } })
    if (active && existing.role !== finalRole) await audit(ctx, 'role_changed', { target: name, detail: { from: existing.role, to: finalRole } })
    if (!device) {
      await addEvent(me, rotated ? 'member_token_rotated' : 'member_invited', {
        text: rotated ? `${name} got a new token (the old one stopped working)` : `${name} was invited to the crew`,
        data: { name },
      })
    }
    return { name, role: finalRole, token: record.token, rotated, token_id: record.id, expires_at: record.expires_at }
  }

  async function removeMember(me, ctx, rawName) {
    requireCan(me, 'manage_members', 'remove people')
    await limit(me, 'member')
    let decoded
    try {
      decoded = decodeURIComponent(rawName)
    } catch {
      throw new HttpError(400, 'bad member name')
    }
    const name = memberName(decoded)
    const member = await activeMember(name, 'name')
    if (member.role === 'lead') throw new HttpError(409, "the lead can't be removed")
    const at = iso()
    const held = await db.all(`SELECT id FROM tasks WHERE assignee = ? AND status IN (${marks(HELD)})`, [name, ...HELD])
    // Everything they could use stops working in one step.
    await db.batch([
      ['UPDATE members SET revoked = 1 WHERE name = ?', [name]],
      ['UPDATE tokens SET revoked_at = ? WHERE member = ? AND revoked_at IS NULL', [at, name]],
      ["UPDATE permission_requests SET status = 'expired' WHERE worker = ? AND status = 'pending'", [name]],
      // Whatever they were holding goes back to the pool.
      [`UPDATE tasks SET status = 'open', assignee = NULL, updated_at = ? WHERE assignee = ? AND status IN (${marks(HELD)})`, [at, name, ...HELD]],
    ])
    await audit(ctx, 'member_removed', { target: name, detail: { released: held.map((t) => t.id) } })
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
    const result = {
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
    if (me.role === 'lead') {
      await expireDuePermissions()
      result.pending_permissions = (await db.get("SELECT COUNT(*) AS n FROM permission_requests WHERE status = 'pending'")).n
      result.security_alerts = (await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE type = 'security_alert' AND ts > ?", [iso(now() - DAY)])).n
    }
    return result
  }

  // Leads see everything. Everyone else sees broadcasts and what's addressed to them.
  function visibility(me, { includeOwn = false } = {}) {
    if (me.role === 'lead') return includeOwn ? { where: '1 = 1', params: [] } : { where: 'actor != ?', params: [me.name] }
    return includeOwn
      ? { where: '(target IS NULL OR target = ? OR actor = ?)', params: [me.name, me.name] }
      : { where: 'actor != ? AND (target IS NULL OR target = ?)', params: [me.name, me.name] }
  }

  async function events(me, search) {
    const after = boundedInt(search.get('after'), 0, 0)
    const limit = boundedInt(search.get('limit'), 100, 1, 200)
    // Read the newest id first, so an event written during this request is
    // never skipped by the cursor.
    const latest = (await db.get('SELECT MAX(id) AS id FROM events'))?.id ?? 0
    const v = visibility(me)
    const rows = await db.all(`SELECT * FROM events WHERE id > ? AND id <= ? AND ${v.where} ORDER BY id LIMIT ?`, [after, latest, ...v.params, limit])
    const cursor = rows.length === limit ? rows.at(-1).id : Math.max(after, latest)
    return { events: rows.map(eventOut), cursor, latest_event_id: latest }
  }

  async function addEvent(actor, type, { target = null, taskId = null, text = '', data = {} } = {}) {
    const result = await db.run(
      'INSERT INTO events (ts, type, actor, actor_role, target, task_id, text, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [iso(), type, actor.name, actor.role, target, taskId, text, JSON.stringify(data)],
    )
    return result.lastId
  }

  // Cleans a free-text field and takes out what looks like a secret. An extra
  // layer, not a promise: see docs/security-guarantees.md.
  async function safeText(me, ctx, value, field, max, required = false) {
    const { text, kinds } = redactSecrets(str(value, field, max, required))
    if (kinds.length) {
      await audit(ctx, 'secret_redacted', { detail: { field, kinds } })
      await note('secret_redacted', me.name, ctx)
    }
    return text
  }

  // --- tasks ---------------------------------------------------------------

  async function getTask(id) {
    const task = await db.get('SELECT * FROM tasks WHERE id = ?', [id])
    if (!task) throw new HttpError(404, `no task #${id}`)
    return task
  }

  async function listTasks(search) {
    const status = search.get('status')
    const limit = boundedInt(search.get('limit'), 50, 1, 200)
    if (status && !ACTIVE.concat('done', 'cancelled').includes(status)) throw new HttpError(400, 'unknown status')
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

  async function createTask(me, ctx, body) {
    requireCan(me, 'manage_tasks', 'create tasks')
    await limit(me, 'task_create')
    const title = await safeText(me, ctx, body.title, 'title', LIMITS.title, true)
    const details = await safeText(me, ctx, body.details, 'details', LIMITS.text)
    const scope = await safeText(me, ctx, body.scope, 'scope', LIMITS.scope)
    const branch = branchField(body.branch)
    const priority = body.priority ?? 'normal'
    if (!PRIORITIES.includes(priority)) throw new HttpError(400, `priority must be one of ${PRIORITIES.join(', ')}`)
    const assignee = body.to ? (await activeMember(body.to)).name : null
    const { n } = await db.get(`SELECT COUNT(*) AS n FROM tasks WHERE status IN (${marks(ACTIVE)})`, ACTIVE)
    if (n >= MAX_ACTIVE_TASKS) throw new HttpError(409, `the board already holds ${MAX_ACTIVE_TASKS} active tasks: finish or cancel some first`)
    const created = iso()
    const { lastId: id } = await db.run(
      `INSERT INTO tasks (title, details, status, assignee, created_by, priority, scope, branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, details, assignee ? 'assigned' : 'open', assignee, me.name, priority, scope, branch, created, created],
    )
    if (!branch) await db.run('UPDATE tasks SET branch = ? WHERE id = ?', [branchName(id, title), id])
    const task = await getTask(id)
    await addEvent(me, 'task_created', { taskId: id, text: details, data: taskData(task) })
    await audit(ctx, 'task_created', { target: assignee, detail: { task: id } })
    return { task }
  }

  async function taskAction(me, ctx, id, action, body) {
    const spec = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null
    if (!spec) throw new HttpError(404, 'unknown task action')
    const task = await getTask(id)
    const isLead = me.role === 'lead'

    if (!CAN[me.role].has('work')) throw new HttpError(403, 'observers can only read')
    if (spec.who === 'lead' && !isLead) throw new HttpError(403, `only the lead can ${action} tasks`)
    if (spec.who === 'assignee' && !isLead && task.assignee !== me.name) {
      throw new HttpError(403, `task #${id} isn't yours (${task.assignee ? `it's ${task.assignee}'s` : 'nobody has claimed it'})`)
    }
    if (spec.from && !spec.from.includes(task.status)) throw new HttpError(409, `task #${id} is ${task.status}, so it can't be ${pastTense(action)}`)
    await limit(me, 'task_action')

    const note_ = await safeText(me, ctx, body.note, 'note', LIMITS.text, spec.needsNote)
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
        changes.summary = note_
        if (body.branch) changes.branch = branchField(body.branch)
        if (body.pr_url) changes.pr_url = urlField(body.pr_url)
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
      text: note_,
      data: { ...taskData(updated), previous_status: task.status, previous_assignee: task.assignee },
    })
    if (action === 'claim' || action === 'assign' || action === 'approve' || action === 'cancel') await audit(ctx, spec.event, { target: updated.assignee, detail: { task: id } })
    return { task: updated }
  }

  // --- messages and permission relay ----------------------------------------

  async function sendMessage(me, ctx, body) {
    requireCan(me, 'message', 'send messages')
    await limit(me, 'message')
    const text = await safeText(me, ctx, body.text, 'text', LIMITS.text, true)
    let to = null
    if (body.to) {
      if (typeof body.to !== 'string') throw new HttpError(400, 'to must be a name')
      const wanted = body.to.trim().toLowerCase()
      to = wanted === 'lead' ? (await leadMember())?.name : (await activeMember(wanted)).name
      if (to === me.name) throw new HttpError(400, "you can't message yourself")
    }
    const taskId = body.task_id ? (await getTask(parseId(body.task_id))).id : null
    const id = await addEvent(me, 'message', { target: to, taskId, text, data: { to } })
    return { id, to }
  }

  // Housekeeping for what's listed. An answer checks the time for itself, so a
  // request this couldn't mark as expired still can't be approved.
  async function expireDuePermissions() {
    try {
      await db.run("UPDATE permission_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?", [iso()])
    } catch (error) {
      console.error('[hub] could not expire old permission requests:', error)
    }
  }

  async function permissionRequest(me, ctx, body) {
    if (!CAN[me.role].has('ask_permission')) throw new HttpError(403, 'only workers relay permission requests')
    const requestId = String(body.request_id ?? '')
    if (!REQUEST_ID_RE.test(requestId)) throw new HttpError(400, 'request_id must be five letters a-z without l')
    await limit(me, 'permission')
    await expireDuePermissions()

    const existing = await db.get('SELECT status, expires_at FROM permission_requests WHERE worker = ? AND request_id = ?', [me.name, requestId])
    if (existing) {
      // A resend while it's open is harmless. Reusing an answered id isn't: it
      // could look like the old answer applies to a new request.
      if (existing.status === 'pending') return { duplicate: true, expires_at: existing.expires_at }
      throw new HttpError(409, `permission request "${requestId}" was already answered`, { code: 'replay' })
    }
    const { n } = await db.get("SELECT COUNT(*) AS n FROM permission_requests WHERE worker = ? AND status = 'pending'", [me.name])
    if (n >= MAX_PENDING_PERMISSIONS) throw new HttpError(429, 'too many open permission requests', { retryAfter: 60 })

    const toolName = clip(cleanText(body.tool_name ?? ''), 100)
    const description = await safeText(me, ctx, clip(body.description, 1_000), 'description', 1_001)
    const preview = await safeText(me, ctx, clip(body.input_preview, 4_000), 'input_preview', 4_001)
    const cwd = await safeText(me, ctx, clip(body.cwd, 300), 'cwd', 301)
    const risk = classifyRisk(toolName, preview, description)
    // The task comes from the board, not from what the worker says it's doing.
    const task = await db.get("SELECT id FROM tasks WHERE assignee = ? AND status = 'in_progress' ORDER BY updated_at DESC LIMIT 1", [me.name])
    const expiresAt = iso(now() + permissionTtlMs)
    await db.run(
      `INSERT INTO permission_requests (worker, request_id, tool_name, description, input_preview, cwd, task_id, risk, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [me.name, requestId, toolName, description, preview, cwd, task?.id ?? null, risk, iso(), expiresAt],
    )
    const lead = await leadMember()
    const id = await addEvent(me, 'permission_request', {
      target: lead.name,
      taskId: task?.id ?? null,
      text: description,
      data: { request_id: requestId, tool_name: toolName, input_preview: preview, cwd, risk, expires_at: expiresAt },
    })
    await audit(ctx, 'permission_requested', { target: lead.name, detail: { request_id: requestId, tool: toolName, risk } })
    return { id, expires_at: expiresAt, risk }
  }

  async function listPermissions(me, search) {
    const status = search.get('status') ?? 'pending'
    if (!['pending', 'allowed', 'denied', 'expired'].includes(status)) throw new HttpError(400, 'unknown status')
    const count = boundedInt(search.get('limit'), 50, 1, 200)
    if (me.role !== 'lead' && !CAN[me.role].has('ask_permission')) throw new HttpError(403, 'only the lead can see permission requests')
    await expireDuePermissions()
    const requests =
      me.role === 'lead'
        ? await db.all('SELECT * FROM permission_requests WHERE status = ? ORDER BY id DESC LIMIT ?', [status, count])
        : await db.all('SELECT * FROM permission_requests WHERE status = ? AND worker = ? ORDER BY id DESC LIMIT ?', [status, me.name, count])
    return { requests }
  }

  // Answers one open request, once, within its time, from someone allowed to.
  // A "yes" also needs the person: see requireHuman.
  async function permissionVerdict(me, ctx, body) {
    requireCan(me, 'answer_permissions', 'answer permission requests')
    const worker = memberName(body.worker)
    const requestId = String(body.request_id ?? '')
    if (!REQUEST_ID_RE.test(requestId)) throw new HttpError(404, `no permission request from ${worker} with that id`)
    const behavior = body.behavior
    if (behavior !== 'allow' && behavior !== 'deny') throw new HttpError(400, 'behavior must be allow or deny')
    const request = await db.get('SELECT id, status, expires_at FROM permission_requests WHERE worker = ? AND request_id = ?', [worker, requestId])
    if (!request) throw new HttpError(404, `no permission request "${requestId}" from ${worker}`)
    if (request.status === 'expired' || (request.status === 'pending' && Date.parse(request.expires_at) <= now())) {
      await db.run("UPDATE permission_requests SET status = 'expired' WHERE id = ? AND status = 'pending'", [request.id])
      await audit(ctx, 'permission_stale_answer', { target: worker, result: 'denied', detail: { request_id: requestId } })
      throw new HttpError(410, `permission request "${requestId}" has expired`)
    }
    if (request.status !== 'pending') {
      await audit(ctx, 'replay_detected', { target: worker, result: 'denied', detail: { request_id: requestId } })
      await note('replay', me.name, ctx)
      throw new HttpError(409, `permission request "${requestId}" was already answered`, { code: 'replay', quiet: true })
    }
    const via = behavior === 'allow' ? await requireHuman(me, ctx, body, 'approve a permission request', { mandatory: true }) : 'lead-token'

    // The status check makes this the one and only answer, whoever else is racing.
    const answered = await db.run(
      "UPDATE permission_requests SET status = ?, decided_at = ?, decided_by = ?, decided_via = ? WHERE id = ? AND status = 'pending' AND expires_at > ?",
      [behavior === 'allow' ? 'allowed' : 'denied', iso(), me.name, via, request.id, iso()],
    )
    if (!answered.changes) throw new HttpError(409, `permission request "${requestId}" was already answered`, { code: 'replay', quiet: true })
    const id = await addEvent(me, 'permission_verdict', { target: worker, text: behavior, data: { request_id: requestId, behavior } })
    await audit(ctx, behavior === 'allow' ? 'permission_approved' : 'permission_rejected', { target: worker, detail: { request_id: requestId, via } })
    return { id }
  }

  return { fetch }
}

// --- helpers ---------------------------------------------------------------

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } })
}

// Reads no more than MAX_BODY bytes, however much is on its way.
async function readBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw new HttpError(413, 'request body too large')
  const chunks = []
  let size = 0
  if (request.body) {
    const reader = request.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => {})
        throw new HttpError(413, 'request body too large')
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let raw
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new HttpError(400, 'body must be UTF-8')
  }
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

function requireCan(me, permission, what) {
  if (!CAN[me.role].has(permission)) throw new HttpError(403, `only the lead can ${what}`)
}

function memberName(value) {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!isMemberName(name)) throw new HttpError(400, 'names use lowercase letters, digits, - and _ (max 32 characters)')
  return name
}

function parseId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new HttpError(400, 'that is not a task number')
  const text = String(value)
  if (!/^#?[1-9][0-9]{0,14}$/.test(text)) throw new HttpError(400, 'that is not a task number')
  return Number(text.replace(/^#/, ''))
}

function boundedInt(value, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const number = Number.parseInt(value ?? '', 10)
  if (!Number.isSafeInteger(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function trimSlashes(path) {
  let end = path.length
  while (end > 0 && path[end - 1] === '/') end--
  return path.slice(0, end)
}

function str(value, field, max, required = false) {
  if (value === undefined || value === null) value = ''
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`)
  const text = cleanText(value).trim()
  if (required && !text) throw new HttpError(400, `${field} is required`)
  if (text.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`)
  return text
}

function branchField(value) {
  if (value === undefined || value === null || value === '') return ''
  const problem = branchProblem(typeof value === 'string' ? value.trim() : value)
  if (problem) throw new HttpError(400, `branch ${problem}`)
  return value.trim()
}

function urlField(value) {
  const problem = httpsUrlProblem(typeof value === 'string' ? value.trim() : value)
  if (problem) throw new HttpError(400, `pr_url ${problem}`)
  return value.trim()
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

function parseJson(text) {
  try {
    return JSON.parse(text || '{}')
  } catch {
    return {}
  }
}

function eventOut(row) {
  return { ...row, data: parseJson(row.data) }
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

function newTokenId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `tok_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}
