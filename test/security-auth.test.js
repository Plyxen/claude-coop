// Authentication, tokens, roles and replay protection, against the real hub code.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHub, sha256 } from '../src/hub/app.js'
import { migrate } from '../src/hub/schema.js'
import { sqliteDatabase } from '../src/hub/sqlite.js'
import { KEY, LEAD, hubForTest } from './helpers.js'

const DAY = 86_400_000

test('tokens are long, random and stored only as hashes', async () => {
  const { db, invite } = await hubForTest()
  const a = await invite('anna')
  const b = await invite('bob')
  assert.notEqual(a, b)
  assert.ok(a.length >= 32, 'at least 24 random bytes')
  const dump = JSON.stringify([await db.all('SELECT * FROM tokens'), await db.all('SELECT * FROM members'), await db.all('SELECT * FROM events'), await db.all('SELECT * FROM audit_log'), await db.all('SELECT * FROM request_log')])
  for (const secret of [a, b, LEAD]) assert.equal(dump.includes(secret), false, 'no raw token anywhere in the database')
  assert.ok(dump.includes(await sha256(a)))
})

test('valid, unknown, malformed and missing tokens', async () => {
  const { call, raw, invite } = await hubForTest()
  const bob = await invite('bob')
  assert.equal((await call(bob, 'GET', '/v1/me')).status, 200)
  assert.equal((await call('coop_nope', 'GET', '/v1/me')).status, 401)
  assert.equal((await call(null, 'GET', '/v1/me')).status, 401)
  for (const header of ['Basic abc', 'Bearer', 'Bearer a b', `Bearer ${'x'.repeat(600)}`, bob]) {
    assert.equal((await raw(null, 'GET', '/v1/me', undefined, { authorization: header })).status, 401, header.slice(0, 20))
  }
})

test('the lead token is checked by hash, and needs to be long', async () => {
  const db = await sqliteDatabase()
  assert.throws(() => createHub({ db, leadToken: 'short' }), /at least 24/)
  const hub = createHub({ db, leadTokenHash: await sha256(LEAD), leadName: 'boss', hubName: 'crew' })
  const me = await hub.fetch(new Request('http://hub/v1/me', { headers: { authorization: `Bearer ${LEAD}` } }))
  assert.equal((await me.json()).role, 'lead')
})

test('a token expires, and the error says so', async () => {
  const { call, invite, tick, audit } = await hubForTest({ tokenTtlDays: 30 })
  const bob = await invite('bob')
  const me = await call(bob, 'GET', '/v1/me')
  assert.ok(me.body.token.expires_at)
  tick(29 * DAY)
  assert.equal((await call(bob, 'GET', '/v1/me')).status, 200)
  tick(2 * DAY)
  const late = await call(bob, 'GET', '/v1/me')
  assert.equal(late.status, 401)
  assert.equal(late.body.code, 'token_expired')
  assert.ok((await audit('auth_failure')).some((e) => e.detail.reason === 'expired' && e.target === 'bob'))
})

test('rotating replaces the token at once, with a new expiry', async () => {
  const { call, invite, tick, audit } = await hubForTest({ tokenTtlDays: 30 })
  const bob = await invite('bob')
  tick(20 * DAY)
  const rotated = await call(bob, 'POST', '/v1/tokens/rotate', {})
  assert.equal(rotated.status, 200)
  assert.notEqual(rotated.body.token, bob)
  assert.equal((await call(bob, 'GET', '/v1/me')).status, 401, 'the old one stopped working')
  tick(20 * DAY)
  assert.equal((await call(rotated.body.token, 'GET', '/v1/me')).status, 200, 'the new one has its own 30 days')
  assert.equal((await audit('token_rotated')).length, 1)
})

test('one device can be revoked alone; revoke-all stops them all', async () => {
  const { call, invite, audit } = await hubForTest()
  const pc = await invite('bob')
  const laptop = await invite('bob', { device: 'laptop' })
  assert.equal((await call(pc, 'GET', '/v1/me')).status, 200, 'a second device leaves the first working')
  assert.equal((await call(laptop, 'GET', '/v1/me')).status, 200)

  const { tokens } = (await call(LEAD, 'GET', '/v1/tokens?member=bob')).body
  assert.equal(tokens.length, 2)
  assert.ok(tokens.every((t) => !('token_hash' in t)), 'hashes are not handed out')
  const laptopId = tokens.find((t) => t.label === 'laptop').id

  assert.equal((await call(LEAD, 'DELETE', `/v1/tokens/${laptopId}`)).status, 200)
  assert.equal((await call(laptop, 'GET', '/v1/me')).status, 401, 'revocation is immediate')
  assert.equal((await call(pc, 'GET', '/v1/me')).status, 200, 'and only that device')

  const all = await call(LEAD, 'POST', '/v1/tokens/revoke-all', { member: 'bob' })
  assert.equal(all.body.revoked, 1)
  assert.equal((await call(pc, 'GET', '/v1/me')).status, 401)
  assert.equal((await audit('tokens_revoked_all')).length, 1)
  assert.equal((await audit('token_revoked')).length, 1)
})

test('workers manage only their own tokens', async () => {
  const { call, invite } = await hubForTest()
  const bob = await invite('bob')
  const anna = await invite('anna')
  const annaId = (await call(anna, 'GET', '/v1/tokens')).body.tokens[0].id

  assert.equal((await call(bob, 'GET', '/v1/tokens?member=anna')).status, 403)
  assert.equal((await call(bob, 'DELETE', `/v1/tokens/${annaId}`)).status, 404, "someone else's token looks like it isn't there")
  assert.equal((await call(bob, 'POST', '/v1/tokens/revoke-all', { member: 'anna' })).status, 403)
  assert.equal((await call(anna, 'GET', '/v1/me')).status, 200)

  const mine = (await call(bob, 'GET', '/v1/tokens')).body.tokens
  assert.equal(mine.length, 1)
  assert.equal(mine[0].current, true)
  assert.equal((await call(bob, 'POST', '/v1/tokens/revoke-all', {})).body.revoked, 1)
  assert.equal((await call(bob, 'GET', '/v1/me')).status, 401)
})

test("the lead's token can't be rotated or revoked through the API", async () => {
  const { call } = await hubForTest()
  const leadId = (await call(LEAD, 'GET', '/v1/me')).body.token.id
  assert.equal((await call(LEAD, 'POST', '/v1/tokens/rotate', {})).status, 409)
  assert.equal((await call(LEAD, 'DELETE', `/v1/tokens/${leadId}`)).status, 409)
  assert.equal((await call(LEAD, 'POST', '/v1/tokens/revoke-all', {})).status, 409)
  assert.equal((await call(LEAD, 'GET', '/v1/me')).status, 200)
})

test('removing a member stops every token and open request at once', async () => {
  const { call, invite, ask, answer } = await hubForTest()
  const pc = await invite('bob')
  const laptop = await invite('bob', { device: 'laptop' })
  await ask(pc, 'abcde')
  assert.equal((await call(LEAD, 'DELETE', '/v1/members/bob')).status, 200)
  assert.equal((await call(pc, 'GET', '/v1/me')).status, 401)
  assert.equal((await call(laptop, 'GET', '/v1/me')).status, 401)
  assert.equal((await answer('bob', 'abcde', 'deny')).status, 410)
})

test('a changed lead token retires the old one', async () => {
  const db = await sqliteDatabase()
  const start = (leadToken) => createHub({ db, leadToken, leadName: 'boss', hubName: 'crew' })
  const asLead = async (hub, token) => (await hub.fetch(new Request('http://hub/v1/me', { headers: { authorization: `Bearer ${token}` } }))).status
  const OLD = 'coop_first-lead-token-0123456789'
  const NEW = 'coop_second-lead-token-012345678'
  assert.equal(await asLead(start(OLD), OLD), 200)
  const next = start(NEW)
  assert.equal(await asLead(next, NEW), 200)
  assert.equal(await asLead(next, OLD), 401)
})

test('failed sign-ins are limited per source, but a valid token still gets in', async () => {
  const { call, audit, invite, eventsFor } = await hubForTest()
  const bob = await invite('bob')
  const statuses = []
  for (let i = 0; i < 25; i++) statuses.push((await call(`coop_guess${i}`, 'GET', '/v1/me')).status)
  assert.equal(statuses.slice(0, 20).every((s) => s === 401), true)
  assert.equal(statuses.at(-1), 429)
  assert.equal((await call(bob, 'GET', '/v1/me')).status, 200, 'an attacker on the same tunnel locks nobody out')

  const logged = (await audit('auth_failure')).length
  for (let i = 0; i < 20; i++) await call(`coop_more${i}`, 'GET', '/v1/me')
  assert.equal((await audit('auth_failure')).length, logged, 'past the limit, failures cost no database writes')
  assert.ok((await eventsFor(LEAD)).some((e) => e.type === 'security_alert' && /failed sign-ins/.test(e.text)))
  const dump = JSON.stringify(await audit())
  assert.equal(dump.includes('coop_guess'), false, 'wrong tokens are not logged either')
})

test('polling writes nothing to the database', async () => {
  const { call, invite, db } = await hubForTest()
  const bob = await invite('bob')
  await call(bob, 'GET', '/v1/events?after=0')
  const writes = async () => {
    const counts = await Promise.all(['audit_log', 'events', 'rate_limits', 'request_log'].map((t) => db.get(`SELECT COUNT(*) AS n FROM ${t}`)))
    return counts.map((c) => c.n).join()
  }
  const before = await writes()
  for (let i = 0; i < 20; i++) await call(bob, 'GET', '/v1/events?after=0')
  assert.equal(await writes(), before)
})

// --- roles -------------------------------------------------------------------

test('each role can do what the table says, enforced by the hub', async () => {
  const { call, invite } = await hubForTest()
  const worker = await invite('bob')
  const observer = await invite('olive', { role: 'observer' })
  const { body: created } = await call(LEAD, 'POST', '/v1/tasks', { title: 'open task' })
  const task = created.task.id

  // [what, method, path, body, lead, worker, observer]: true means allowed.
  const table = [
    ['read the board', 'GET', '/v1/board', undefined, true, true, true],
    ['read a task', 'GET', `/v1/tasks/${task}`, undefined, true, true, true],
    ['read the audit log', 'GET', '/v1/audit', undefined, true, false, false],
    ['read the approval settings', 'GET', '/v1/approvals', undefined, true, false, false],
    ['create a task', 'POST', '/v1/tasks', { title: 'x' }, true, false, false],
    ['send a message', 'POST', '/v1/messages', { text: 'hi', to: 'lead-does-not-exist' }, null, null, false],
    ['invite someone', 'POST', '/v1/members', { name: 'newbie' }, true, false, false],
    ['remove someone', 'DELETE', '/v1/members/nobody', undefined, null, false, false],
    ['answer a permission request', 'POST', '/v1/permissions/verdict', { worker: 'bob', request_id: 'zzzzz', behavior: 'deny' }, null, false, false],
    ['ask for permission', 'POST', '/v1/permissions', { request_id: 'qwert', tool_name: 'Bash' }, false, true, false],
    ['set the approval passphrase', 'POST', '/v1/approvals/setup', { key: KEY, salt: 'c'.repeat(32), kdf: 'scrypt:32768:8:1' }, null, false, false],
    ['approve a task', 'POST', `/v1/tasks/${task}/approve`, {}, null, false, false],
    ['cancel a task', 'POST', `/v1/tasks/${task}/cancel`, {}, null, false, false],
  ]
  const verdicts = { lead: LEAD, worker, observer }
  for (const [what, method, path, body, ...expected] of table) {
    for (const [i, role] of ['lead', 'worker', 'observer'].entries()) {
      if (expected[i] === null) continue
      const { status } = await call(verdicts[role], method, path, body)
      if (expected[i]) assert.ok(status < 400, `${role} should be able to ${what}, got ${status}`)
      else assert.equal(status, 403, `${role} must not be able to ${what}, got ${status}`)
    }
  }
})

test('an observer can read and nothing else', async () => {
  const { call, invite } = await hubForTest()
  const olive = await invite('olive', { role: 'observer' })
  const { body } = await call(LEAD, 'POST', '/v1/tasks', { title: 'one' })
  for (const action of ['claim', 'progress', 'block', 'submit', 'release', 'comment']) {
    assert.equal((await call(olive, 'POST', `/v1/tasks/${body.task.id}/${action}`, { note: 'x' })).status, 403, action)
  }
  assert.equal((await call(olive, 'POST', '/v1/messages', { text: 'hi' })).status, 403)
  assert.equal((await call(olive, 'GET', '/v1/permissions')).status, 403)
})

test('nobody can raise their own role', async () => {
  const { call, invite } = await hubForTest()
  const bob = await invite('bob')
  assert.equal((await call(bob, 'POST', '/v1/members', { name: 'bob', role: 'lead' })).status, 403)
  assert.equal((await call(LEAD, 'POST', '/v1/members', { name: 'bob', role: 'lead' })).status, 400, 'not even the lead can make a second lead')
  assert.equal((await call(LEAD, 'POST', '/v1/members', { name: 'boss' })).status, 409, "and nobody can be invited under the lead's name")
  assert.equal((await call(bob, 'GET', '/v1/me')).body.role, 'worker')
})

test('reserved names are refused, so nobody can pass as the hub', async () => {
  const { call } = await hubForTest()
  for (const name of ['lead', 'hub', 'system', 'all', 'coop', 'root']) {
    assert.equal((await call(LEAD, 'POST', '/v1/members', { name })).status, 400, name)
  }
})

test('workers see their own and broadcast events, not what others are told', async () => {
  const { call, invite, eventsFor, ask } = await hubForTest()
  const bob = await invite('bob')
  const anna = await invite('anna')
  await call(LEAD, 'POST', '/v1/messages', { to: 'anna', text: 'just for anna' })
  await ask(bob, 'abcde')
  const seen = await eventsFor(bob)
  assert.equal(seen.some((e) => e.text === 'just for anna'), false)
  assert.ok((await eventsFor(anna)).some((e) => e.text === 'just for anna'))
  assert.equal((await eventsFor(anna)).some((e) => e.type === 'permission_request'), false)
  assert.equal((await call(anna, 'GET', '/v1/permissions')).body.requests.length, 0, "and not another worker's permission requests")
})

// --- replay ------------------------------------------------------------------

test('a repeated request runs once, and gets the first answer back', async () => {
  const { call, now } = await hubForTest()
  const headers = { 'x-coop-request-id': 'same-request-id-1', 'x-coop-timestamp': String(now()) }
  const first = await call(LEAD, 'POST', '/v1/tasks', { title: 'only once' }, headers)
  const again = await call(LEAD, 'POST', '/v1/tasks', { title: 'only once' }, headers)
  assert.equal(first.status, 201)
  assert.equal(again.status, 201)
  assert.equal(again.body.task.id, first.body.task.id)
  assert.equal(again.headers.get('x-coop-replayed'), '1')
  assert.equal((await call(LEAD, 'GET', '/v1/tasks')).body.tasks.length, 1)
})

test('a repeated sensitive request is refused, and no token is kept for it', async () => {
  const { call, now, db, audit } = await hubForTest()
  const headers = { 'x-coop-request-id': 'same-invite-id-01', 'x-coop-timestamp': String(now()) }
  const first = await call(LEAD, 'POST', '/v1/members', { name: 'bob' }, headers)
  assert.equal(first.status, 201)
  const again = await call(LEAD, 'POST', '/v1/members', { name: 'bob' }, headers)
  assert.equal(again.status, 409)
  assert.equal(again.body.code, 'replay')
  assert.equal(again.text.includes('coop_'), false)
  const stored = await db.all('SELECT * FROM request_log')
  assert.equal(JSON.stringify(stored).includes(first.body.token), false)
  assert.equal((await call(first.body.token, 'GET', '/v1/me')).status, 200, 'and the first token still works')
  assert.equal((await audit('replay_detected')).length, 1)
})

test('sensitive requests need a request id and a fresh timestamp', async () => {
  const { raw, now } = await hubForTest()
  const post = (path, body, headers = {}) => raw(LEAD, 'POST', path, body, headers)
  for (const [path, body] of [
    ['/v1/members', { name: 'bob' }],
    ['/v1/tokens/revoke-all', { member: 'bob' }],
    ['/v1/approvals/setup', { key: KEY, salt: 'c'.repeat(32), kdf: 'scrypt:32768:8:1' }],
    ['/v1/permissions/verdict', { worker: 'bob', request_id: 'abcde', behavior: 'deny' }],
  ]) {
    const missing = await post(path, body)
    assert.equal(missing.status, 400, path)
    assert.equal((await missing.json()).code, 'request_id_required')
    const old = await post(path, body, { 'x-coop-request-id': 'some-request-id-1', 'x-coop-timestamp': String(now() - 6 * 60_000) })
    assert.equal((await old.json()).code, 'stale_request', path)
    const future = await post(path, body, { 'x-coop-request-id': 'some-request-id-2', 'x-coop-timestamp': String(now() + 6 * 60_000) })
    assert.equal((await future.json()).code, 'stale_request', path)
    const none = await post(path, body, { 'x-coop-request-id': 'some-request-id-3' })
    assert.equal((await none.json()).code, 'stale_request', path)
  }
  const bad = await post('/v1/members', { name: 'bob' }, { 'x-coop-request-id': 'has spaces!', 'x-coop-timestamp': String(now()) })
  assert.equal(bad.status, 400)
})

test("an older worker client's routine calls still work without request ids", async () => {
  const { raw, call, invite } = await hubForTest()
  const bob = await invite('bob')
  const { body } = await call(LEAD, 'POST', '/v1/tasks', { title: 'for bob' })
  const old = (path, data) => raw(bob, 'POST', path, data)
  assert.equal((await old(`/v1/tasks/${body.task.id}/claim`, {})).status, 200)
  assert.equal((await old(`/v1/tasks/${body.task.id}/claim`, {})).status, 409, 'the task state stops a second claim')
  assert.equal((await old('/v1/messages', { text: 'hello' })).status, 201)
  assert.equal((await old('/v1/permissions', { request_id: 'abcde', tool_name: 'Bash' })).status, 201)
  assert.equal((await old('/v1/members', { name: 'eve' })).status, 400, 'but they get nothing sensitive that way')
})

test('a failed request can be tried again with the same id', async () => {
  const { call, now } = await hubForTest()
  const headers = { 'x-coop-request-id': 'retry-after-error', 'x-coop-timestamp': String(now()) }
  assert.equal((await call(LEAD, 'POST', '/v1/tasks', { title: '' }, headers)).status, 400)
  assert.equal((await call(LEAD, 'POST', '/v1/tasks', { title: 'fixed' }, headers)).status, 201)
})

test("one member's request id doesn't collide with another's", async () => {
  const { call, invite, now } = await hubForTest()
  const bob = await invite('bob')
  const anna = await invite('anna')
  const headers = { 'x-coop-request-id': 'shared-request-id', 'x-coop-timestamp': String(now()) }
  assert.equal((await call(bob, 'POST', '/v1/messages', { text: 'a' }, headers)).status, 201)
  const other = await call(anna, 'POST', '/v1/messages', { text: 'b' }, headers)
  assert.equal(other.status, 201)
  assert.equal(other.headers.get('x-coop-replayed'), null)
})

test('two workers claiming one task: one wins', async () => {
  const { call, invite } = await hubForTest()
  const bob = await invite('bob')
  const anna = await invite('anna')
  const { body } = await call(LEAD, 'POST', '/v1/tasks', { title: 'one task' })
  const claims = await Promise.all([bob, anna].map((token) => call(token, 'POST', `/v1/tasks/${body.task.id}/claim`, {})))
  assert.deepEqual(claims.map((c) => c.status).sort(), [200, 409])
})

// --- upgrade from 0.1 --------------------------------------------------------

async function oldHubDatabase() {
  const db = await sqliteDatabase()
  await db.run(`CREATE TABLE members (name TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('lead', 'worker')), token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen TEXT, revoked INTEGER NOT NULL DEFAULT 0)`)
  await db.run(`CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, assignee TEXT, created_by TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', scope TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '', pr_url TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
  await db.run(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, actor_role TEXT NOT NULL, target TEXT, task_id INTEGER, text TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}')`)
  const at = '2026-01-01T00:00:00.000Z'
  await db.run('INSERT INTO members (name, role, token_hash, created_at) VALUES (?, ?, ?, ?)', ['boss', 'lead', await sha256(LEAD), at])
  await db.run('INSERT INTO members (name, role, token_hash, created_at) VALUES (?, ?, ?, ?)', ['bob', 'worker', await sha256('coop_old-worker-token-0123456789'), at])
  await db.run('INSERT INTO members (name, role, token_hash, created_at, revoked) VALUES (?, ?, ?, ?, 1)', ['gone', 'worker', await sha256('coop_removed-worker-token-01234'), at])
  await db.run("INSERT INTO tasks (title, status, created_by, created_at, updated_at) VALUES ('kept', 'open', 'boss', ?, ?)", [at, at])
  return db
}

test('a 0.1 hub database upgrades in place', async () => {
  const db = await oldHubDatabase()
  const { call, invite } = await hubForTest({ db })

  const old = await call('coop_old-worker-token-0123456789', 'GET', '/v1/me')
  assert.equal(old.status, 200, 'an existing worker keeps working')
  assert.equal(old.body.token.label, 'migrated')
  assert.equal(old.body.token.expires_at, null, 'with no expiry, since nobody could renew it unannounced')
  assert.equal((await call('coop_removed-worker-token-01234', 'GET', '/v1/me')).status, 401, 'a removed worker stays removed')
  assert.equal((await call(LEAD, 'GET', '/v1/me')).body.role, 'lead')
  assert.equal((await call(LEAD, 'GET', '/v1/tasks')).body.tasks.length, 1, 'and the data is still there')

  const members = await db.all('SELECT token_hash FROM members')
  assert.ok(members.every((m) => m.token_hash.startsWith('member:')), 'no credential left in the old column')
  assert.ok(await invite('olive', { role: 'observer' }), 'the new role works')

  await migrate(db)
  assert.equal((await call('coop_old-worker-token-0123456789', 'GET', '/v1/me')).status, 200, 'and migrating twice changes nothing')
})
