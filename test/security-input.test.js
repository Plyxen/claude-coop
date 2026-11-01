// Hostile input at the hub: validation, limits, the audit log, alerts, retention.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findSecrets, redactSecrets } from '../src/secrets.js'
import { branchProblem, cleanText, constantTimeEqual, hostKind, httpsUrlProblem, isProtectedBranch, neutralizeMarkup, parseHubUrl } from '../src/validate.js'
import { LEAD, hubForTest } from './helpers.js'

const DAY = 86_400_000
const GITHUB_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`
const AWS_KEY = `AKIA${'ABCDEFGH23456789'}`

test('malicious branch names are refused', () => {
  const bad = ['main', 'MASTER', 'HEAD', 'trunk', 'refs/heads/main', 'origin/main', '--force', '-f', '--upload-pack=x', '../../evil', 'a/../b', 'a b', 'a;rm -rf /', 'a$(id)', 'a`id`', 'a|b', 'a&b', 'a\nb', 'x.lock', 'x/', 'x.', '/x', 'x//y', 'a@{1}', '.hidden', 'a/.b', 'a~1', 'a^1', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', '', 'x'.repeat(201), 'ünicode']
  for (const name of bad) assert.ok(branchProblem(name), `should refuse ${JSON.stringify(name)}`)
  for (const value of [null, undefined, 1, {}, []]) assert.ok(branchProblem(value))
  for (const name of ['coop/12-fix-login', 'feature/a.b_c-d', 'v1.2.3-rc1']) assert.equal(branchProblem(name), null, name)
})

test('the hub applies those branch rules', async () => {
  const { call, invite } = await hubForTest()
  const bob = await invite('bob')
  assert.equal((await call(LEAD, 'POST', '/v1/tasks', { title: 'x', branch: 'main' })).status, 400)
  assert.equal((await call(LEAD, 'POST', '/v1/tasks', { title: 'x', branch: '--force' })).status, 400)
  assert.equal((await call(LEAD, 'POST', '/v1/tasks', { title: 'x', branch: 5 })).status, 400)
  const { body } = await call(LEAD, 'POST', '/v1/tasks', { title: 'x; rm -rf / $(id) --force', to: 'bob' })
  assert.match(body.task.branch, /^coop\/1-[a-z0-9-]+$/, 'a generated branch name can hold nothing dangerous')
  await call(bob, 'POST', `/v1/tasks/${body.task.id}/claim`, {})
  assert.equal((await call(bob, 'POST', `/v1/tasks/${body.task.id}/submit`, { note: 'done', branch: 'master' })).status, 400)
})

test('pull request links must be plain https', async () => {
  const bad = ['http://github.com/a/b/pull/1', 'javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@github.com/x', 'https://a b', 'https://a\nb', 'not a url', '', 'https://' + 'x'.repeat(500)]
  for (const url of bad) assert.ok(httpsUrlProblem(url), url.slice(0, 30))
  assert.equal(httpsUrlProblem('https://github.com/a/b/pull/1'), null)

  const { call, invite } = await hubForTest()
  const bob = await invite('bob')
  const { body } = await call(LEAD, 'POST', '/v1/tasks', { title: 'x', to: 'bob' })
  await call(bob, 'POST', `/v1/tasks/${body.task.id}/claim`, {})
  assert.equal((await call(bob, 'POST', `/v1/tasks/${body.task.id}/submit`, { note: 'done', pr_url: 'javascript:alert(1)' })).status, 400)
})

test('protected branches, however they are written', () => {
  for (const name of ['main', 'Main', 'refs/heads/main', 'origin/master', 'HEAD', 'trunk']) assert.equal(isProtectedBranch(name), true, name)
  assert.equal(isProtectedBranch('main-fix'), false)
  assert.equal(isProtectedBranch('coop/1-main'), false)
})

test('malformed and oversized bodies are refused safely', async () => {
  const { call, raw, fresh } = await hubForTest()
  for (const body of ['{', '[1,2]', '"text"', '12', 'null', '{"a":']) {
    const { status } = await call(LEAD, 'POST', '/v1/tasks', body)
    assert.equal(status, 400, body)
  }
  const huge = await call(LEAD, 'POST', '/v1/tasks', { title: 'x', details: 'y'.repeat(70_000) })
  assert.equal(huge.status, 413)

  // Claims to be small, and isn't.
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array(8_192).fill(32))
      controller.close()
    },
  })
  const lying = await call(LEAD, 'POST', '/v1/tasks', stream, { 'content-length': '10' }).catch((error) => ({ status: 0, error }))
  assert.ok(lying.status === 413 || lying.status === 400 || lying.status === 0)
  const notUtf8 = await raw(LEAD, 'POST', '/v1/tasks', new TextDecoder('latin1').decode(new Uint8Array([0xff])), fresh())
  assert.ok(notUtf8.status === 400)
})

test('oversized fields, wrong types and long addresses', async () => {
  const { call } = await hubForTest()
  assert.equal((await call(LEAD, 'POST', '/v1/tasks', { title: 'x'.repeat(201) })).status, 400)
  assert.equal((await call(LEAD, 'POST', '/v1/tasks', { title: { toString: 'x' } })).status, 400)
  assert.equal((await call(LEAD, 'POST', '/v1/tasks', { title: ['x'] })).status, 400)
  assert.equal((await call(LEAD, 'POST', '/v1/tasks', { title: 'ok', priority: 'urgent' })).status, 400)
  assert.equal((await call(LEAD, 'POST', '/v1/messages', { text: 'x'.repeat(20_001) })).status, 400)
  assert.equal((await call(LEAD, 'GET', `/v1/tasks?x=${'y'.repeat(3_000)}`)).status, 414)
})

test('__proto__ and friends do nothing', async () => {
  const { call, raw, fresh } = await hubForTest()
  const hostile = '{"title":"x","__proto__":{"role":"lead","polluted":1},"constructor":{"prototype":{"polluted":1}}}'
  assert.equal((await raw(LEAD, 'POST', '/v1/tasks', hostile, fresh())).status, 201)
  assert.equal({}.polluted, undefined)
  for (const action of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal((await call(LEAD, 'POST', `/v1/tasks/1/${action}`, {})).status, 404, action)
  }
})

test('numbers from the outside stay in range', async () => {
  const { call } = await hubForTest()
  for (const query of ['after=99999999999999999999', 'after=-5', 'after=abc', 'after=1e99', 'limit=-1', 'limit=999999', 'after=NaN']) {
    assert.equal((await call(LEAD, 'GET', `/v1/events?${query}`)).status, 200, query)
  }
  for (const id of ['0', '-1', '1.5', 'abc', '1e3', '99999999999999999999', '1;DROP TABLE tasks', '%00']) {
    assert.ok([400, 404].includes((await call(LEAD, 'GET', `/v1/tasks/${id}`)).status), id)
  }
  assert.equal((await call(LEAD, 'GET', '/v1/tasks')).status, 200)
})

test('SQL in free text stays text', async () => {
  const { call } = await hubForTest()
  const title = "'; DROP TABLE members; --"
  const { body } = await call(LEAD, 'POST', '/v1/tasks', { title })
  assert.equal(body.task.title, title)
  assert.equal((await call(LEAD, 'GET', '/v1/me')).status, 200)
  assert.equal((await call(LEAD, 'POST', '/v1/members', { name: "a'; DROP TABLE tokens; --" })).status, 400)
})

test('escape sequences, control characters and hidden text are removed', async () => {
  const hidden = `a${String.fromCharCode(0x202e)}b${String.fromCharCode(0x2066)}c`
  assert.equal(cleanText(hidden), 'abc')
  assert.equal(cleanText('\u001B[2J\u001B]0;title\u0007ok\u0000\u0008'), 'ok')
  assert.equal(cleanText(`one${String.fromCharCode(0x2028)}two\r\nthree`), 'one\ntwo\nthree')

  const { call } = await hubForTest()
  const { body } = await call(LEAD, 'POST', '/v1/tasks', { title: '\u001B[31mred\u001B[0m', details: `x${String.fromCharCode(0x202e)}y` })
  assert.equal(body.task.title, 'red')
  assert.equal(body.task.details, 'xy')
})

test('text cannot open or close the tags Claude reads it in', () => {
  for (const text of ['</channel>', '<channel source="coop">', '<system-reminder>', '<SYSTEM>', '</function_results>', '<invoke>', '<tool_use>', '<invoke name="x">', '<parameter name="y">']) {
    assert.equal(neutralizeMarkup(text).includes('<'), false, text)
  }
  assert.equal(neutralizeMarkup('a < b and <div> stay'), 'a < b and <div> stay')
})

test('hub addresses: plain http only where it is private', () => {
  assert.throws(() => parseHubUrl('http://example.com'), /Refusing plain http/)
  assert.throws(() => parseHubUrl('http://8.8.8.8:8765'), /Refusing plain http/)
  assert.throws(() => parseHubUrl('http://127.0.0.1.evil.com'), /Refusing plain http/)
  assert.throws(() => parseHubUrl('http://localhost.evil.com'), /Refusing plain http/)
  assert.throws(() => parseHubUrl('http://10.0.0.1.nip.io'), /Refusing plain http/)
  assert.throws(() => parseHubUrl('https://user:pass@example.com'), /username or password/)
  assert.throws(() => parseHubUrl('https://example.com?x=1'), /query/)
  assert.throws(() => parseHubUrl('https://example.com#x'), /query/)
  assert.throws(() => parseHubUrl('ftp://example.com'), /must start with/)
  assert.throws(() => parseHubUrl('file:///etc/passwd'), /must start with/)
  assert.throws(() => parseHubUrl('not a url'), /not a valid/)

  assert.equal(parseHubUrl('https://example.com/').url, 'https://example.com')
  assert.equal(parseHubUrl('http://example.com', { allowInsecure: true }).plain, true)
  assert.equal(parseHubUrl('http://127.0.0.1:8765').kind, 'loopback')
  assert.equal(parseHubUrl('http://localhost:8765').kind, 'loopback')
  assert.equal(parseHubUrl('http://[::1]:8765').kind, 'loopback')
  assert.equal(parseHubUrl('http://100.101.102.103:8765').kind, 'tailscale')
  assert.equal(parseHubUrl('http://my-pc.tail1234.ts.net:8765').kind, 'tailscale')
  assert.equal(parseHubUrl('http://192.168.1.20:8765').kind, 'private')
  assert.equal(parseHubUrl('http://10.1.2.3').kind, 'private')
  assert.equal(parseHubUrl('http://my-desktop:8765').kind, 'private')
  assert.equal(hostKind('172.32.0.1'), 'public')
  assert.equal(hostKind('100.128.0.1'), 'public')
})

test('constant-time comparison gives the right answers', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true)
  assert.equal(constantTimeEqual('abc', 'abd'), false)
  assert.equal(constantTimeEqual('abc', 'abcd'), false)
  assert.equal(constantTimeEqual(undefined, undefined), false)
  assert.equal(constantTimeEqual('abc', 1), false)
})

// --- secrets -----------------------------------------------------------------

test('common secrets are recognised and removed', () => {
  const samples = {
    'github-token': GITHUB_TOKEN,
    'aws-access-key': AWS_KEY,
    'aws-secret-key': `aws_secret_access_key = ${'wJalrXUtnFEMI/K7MDENG/bPxRfiCY'}${'EXAMPLEKEY'}`,
    'anthropic-key': `sk-ant-${'api03-abcdefghij1234567890'}`,
    'openai-key': `sk-${'abcdefghij1234567890abcdefghij12'}`,
    'slack-token': `xoxb-${'123456789012-abcdefgh'}`,
    'stripe-key': `sk_live_${'abcdefghij123456'}`,
    'google-key': `AIza${'abcdefghij1234567890abcdefghij12345'}`,
    'coop-token': `coop_${'abcdefghij1234567890abcd'}`,
    jwt: `eyJhbGciOiJI.eyJzdWIiOiIx.${'abcdefghij12'}`,
    'database-url': 'postgres://admin:hunter2secret@db.internal:5432/app',
    'private-key': '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    assignment: 'password = "correct-horse-battery"',
  }
  for (const [kind, sample] of Object.entries(samples)) {
    const { text, kinds } = redactSecrets(`before ${sample} after`)
    assert.ok(kinds.includes(kind), `${kind} not found in ${sample}`)
    assert.ok(text.startsWith('before'), kind)
    assert.equal(text.includes(sample), false, `${kind} was not removed`)
  }
})

test('ordinary text is left alone', () => {
  const fine = ['the password field is required', 'password = process.env.DB_PASSWORD', 'api_key: <your key>', 'secret: ${SECRET}', 'token_count = 12345678', 'See sk-learn docs', 'const password = undefined', 'git commit abc123def456', 'https://example.com/path', 'AKIA is how AWS keys start', 'password: changeme', 'API_KEY=your-api-key-here']
  for (const text of fine) assert.deepEqual(findSecrets(text), [], text)
})

test('secret patterns stay fast on hostile input', () => {
  const inputs = [`-----BEGIN ${'A '.repeat(20_000)}`, 'password='.repeat(5_000), `${'a'.repeat(100_000)}@`, `postgres://${'a:'.repeat(20_000)}`, 'eyJ'.repeat(30_000), `${'sk-'.repeat(30_000)}`, `-----BEGIN PRIVATE KEY-----${'x'.repeat(200_000)}`, `password${' '.repeat(100_000)}=`]
  for (const input of inputs) {
    const started = performance.now()
    redactSecrets(input)
    const took = performance.now() - started
    assert.ok(took < 500, `took ${Math.round(took)} ms on ${input.slice(0, 30)}...`)
  }
})

test('the hub takes secrets out of what it stores, and tells the lead', async () => {
  const { call, invite, db, audit, eventsFor, ask } = await hubForTest()
  const bob = await invite('bob')
  const { body } = await call(LEAD, 'POST', '/v1/tasks', { title: 'x', details: `use ${GITHUB_TOKEN} to log in` })
  assert.equal(body.task.details.includes(GITHUB_TOKEN), false)
  await call(bob, 'POST', '/v1/messages', { text: `here is the key ${AWS_KEY}` })
  await ask(bob, 'abcde', { input_preview: `curl -H "Authorization: token ${GITHUB_TOKEN}"` })

  const everything = JSON.stringify([await db.all('SELECT * FROM events'), await db.all('SELECT * FROM tasks'), await db.all('SELECT * FROM permission_requests'), await db.all('SELECT * FROM audit_log'), await db.all('SELECT * FROM request_log')])
  assert.equal(everything.includes(GITHUB_TOKEN), false)
  assert.equal(everything.includes(AWS_KEY), false)
  const logged = await audit('secret_redacted')
  assert.ok(logged.length >= 3)
  assert.ok(logged.some((e) => e.detail.kinds.includes('github-token')))
  assert.ok((await eventsFor(LEAD)).some((e) => e.type === 'security_alert' && /secret/.test(e.text)))
})

// --- limits ------------------------------------------------------------------

test('rate limits apply per member and answer with Retry-After', async () => {
  const { call, invite, tick } = await hubForTest({ rateLimits: { task_create: [3, 3_600_000], task_action: [100, 3_600_000], message: [2, 3_600_000], permission: [100, 3_600_000], member: [100, 3_600_000], token: [100, 3_600_000] } })
  const bob = await invite('bob')
  const anna = await invite('anna')
  for (let i = 0; i < 3; i++) assert.equal((await call(LEAD, 'POST', '/v1/tasks', { title: `t${i}` })).status, 201)
  const over = await call(LEAD, 'POST', '/v1/tasks', { title: 'one too many' })
  assert.equal(over.status, 429)
  assert.ok(Number(over.headers.get('retry-after')) > 0)

  await call(bob, 'POST', '/v1/messages', { text: '1' })
  await call(bob, 'POST', '/v1/messages', { text: '2' })
  assert.equal((await call(bob, 'POST', '/v1/messages', { text: '3' })).status, 429)
  assert.equal((await call(anna, 'POST', '/v1/messages', { text: '1' })).status, 201, "one member's flood doesn't silence another")
  tick(3_600_000)
  assert.equal((await call(bob, 'POST', '/v1/messages', { text: '4' })).status, 201, 'and it recovers')
})

test('reads have a limit that costs no writes', async () => {
  const { call, invite } = await hubForTest()
  const bob = await invite('bob')
  let last
  for (let i = 0; i < 602; i++) last = await call(bob, 'GET', '/v1/events?after=0')
  assert.equal(last.status, 429)
  assert.equal((await call(LEAD, 'GET', '/v1/me')).status, 200, 'other members are unaffected')
})

const rowCounts = async (db) => (await Promise.all(['audit_log', 'events', 'rate_limits', 'request_log'].map((t) => db.get(`SELECT COUNT(*) AS n FROM ${t}`)))).map((c) => c.n).join()

test('a flood of changes is cut off before it costs database writes', async () => {
  const { call, invite, db, tick, audit } = await hubForTest({ maxWritesPerMinute: 5 })
  const bob = await invite('bob')
  const anna = await invite('anna')
  for (let i = 0; i < 5; i++) assert.equal((await call(bob, 'POST', '/v1/messages', { text: `m${i}` })).status, 201)
  const first = await call(bob, 'POST', '/v1/messages', { text: 'one too many' })
  assert.equal(first.status, 429)
  assert.ok(Number(first.headers.get('retry-after')) > 0)
  assert.equal((await audit('rate_limited')).filter((e) => e.actor === 'bob').length, 1, 'the first one over gets logged')

  const before = await rowCounts(db)
  for (let i = 0; i < 40; i++) assert.equal((await call(bob, 'POST', '/v1/tasks', { title: 'flood' })).status, 429)
  assert.equal(await rowCounts(db), before, 'the rest cost nothing')

  assert.equal((await call(anna, 'POST', '/v1/messages', { text: 'hi' })).status, 201, "one member's flood doesn't silence another")
  tick(60_000)
  assert.equal((await call(bob, 'POST', '/v1/messages', { text: 'back' })).status, 201, 'and it recovers')
})

test('refusals stop being logged past a limit, and are still refused', async () => {
  const { call, invite, audit, eventsFor } = await hubForTest()
  const bob = await invite('bob')
  for (let i = 0; i < 60; i++) assert.equal((await call(bob, 'POST', '/v1/tasks', { title: 'not yours to make' })).status, 403)
  assert.equal((await audit('access_denied')).length, 30)
  assert.ok((await eventsFor(LEAD)).some((e) => e.type === 'security_alert' && e.data.kind === 'forbidden'), 'and the lead has already been told')
})

test('failed sign-ins past the logged limit are refused without a write', async () => {
  const { call, db } = await hubForTest({ address: 'noisy' })
  for (let i = 0; i < 10; i++) assert.equal((await call(`coop_guess${i}`, 'GET', '/v1/me')).status, 401)
  const before = await rowCounts(db)
  for (let i = 0; i < 10; i++) assert.equal((await call(`coop_more${i}`, 'GET', '/v1/me')).status, 401, 'still a plain refusal')
  assert.equal((await call('coop_last', 'GET', '/v1/me')).status, 429)
  assert.equal(await rowCounts(db), before)
})

test('an oversized address costs no write before sign-in', async () => {
  const { raw, db } = await hubForTest()
  await raw(LEAD, 'GET', '/v1/me')
  const before = await rowCounts(db)
  for (let i = 0; i < 5; i++) assert.equal((await raw(null, 'GET', `/v1/tasks?x=${'y'.repeat(3_000)}`)).status, 414)
  assert.equal(await rowCounts(db), before)
})

test('the board and the crew have upper bounds', async () => {
  const { call } = await hubForTest({ maxWorkers: 1 })
  assert.equal((await call(LEAD, 'POST', '/v1/members', { name: 'one' })).status, 201)
  assert.equal((await call(LEAD, 'POST', '/v1/members', { name: 'two' })).status, 409)
})

// --- audit log, alerts, errors ------------------------------------------------

test('the audit log records who did what, and holds no secrets', async () => {
  const { call, invite, audit, setPassphrase, ask, answer } = await hubForTest()
  const bob = await invite('bob')
  await setPassphrase()
  const anna = (await call(LEAD, 'POST', '/v1/members', { name: 'anna', approval_key: 'a'.repeat(64) })).body.token
  const { body } = await call(LEAD, 'POST', '/v1/tasks', { title: 'x', to: 'bob' })
  await call(bob, 'POST', `/v1/tasks/${body.task.id}/claim`, {})
  await ask(bob, 'abcde')
  await answer('bob', 'abcde', 'deny')
  await call(bob, 'POST', '/v1/members', { name: 'eve' })
  await call(bob, 'POST', '/v1/tasks/1/claim', { note: 5 })
  await call('coop_wrong-token-value', 'GET', '/v1/me')
  await call(LEAD, 'POST', '/v1/tokens/revoke-all', { member: 'anna' })
  await call(LEAD, 'DELETE', '/v1/members/anna')

  const entries = await audit()
  const types = new Set(entries.map((e) => e.type))
  for (const type of ['member_added', 'security_config_changed', 'task_created', 'task_claimed', 'permission_requested', 'permission_rejected', 'access_denied', 'auth_failure', 'tokens_revoked_all', 'member_removed']) {
    assert.ok(types.has(type), `no ${type} in ${[...types]}`)
  }
  const denied = entries.find((e) => e.type === 'access_denied')
  assert.equal(denied.actor, 'bob')
  assert.equal(denied.result, 'denied')
  assert.ok(denied.request_id && denied.ts && denied.source)

  const dump = JSON.stringify(entries)
  for (const secret of [LEAD, bob, anna, 'coop_wrong-token-value', 'a'.repeat(64), '203.0.113.7']) {
    assert.equal(dump.includes(secret), false, `audit log contains ${secret.slice(0, 12)}`)
  }
})

test('audit log filters and access', async () => {
  const { call, invite } = await hubForTest()
  const bob = await invite('bob')
  assert.equal((await call(bob, 'GET', '/v1/audit')).status, 403)
  assert.equal((await call(LEAD, 'GET', "/v1/audit?type=x'y")).status, 400)
  const { body } = await call(LEAD, 'GET', '/v1/audit?type=member_added&limit=1')
  assert.equal(body.entries.length, 1)
  assert.equal(body.entries[0].target, 'bob')
})

test('suspicious patterns reach the lead as alerts, once per window', async () => {
  const { call, invite, eventsFor } = await hubForTest()
  const bob = await invite('bob')
  for (let i = 0; i < 12; i++) await call(bob, 'POST', '/v1/members', { name: `eve${i}` })
  const alerts = (await eventsFor(LEAD)).filter((e) => e.type === 'security_alert' && e.data.kind === 'forbidden')
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].actor, 'hub')
  assert.equal(alerts[0].actor_role, 'system')
  assert.equal(alerts[0].target, 'boss')
  assert.equal((await eventsFor(bob)).some((e) => e.type === 'security_alert'), false, 'and only the lead hears')
  assert.ok((await call(LEAD, 'GET', '/v1/board')).body.security_alerts >= 1)
})

test('a revoked token still being used raises an alert', async () => {
  const { call, invite, eventsFor } = await hubForTest()
  const bob = await invite('bob')
  await call(LEAD, 'POST', '/v1/tokens/revoke-all', { member: 'bob' })
  for (let i = 0; i < 3; i++) await call(bob, 'GET', '/v1/me')
  assert.ok((await eventsFor(LEAD)).some((e) => e.data.kind === 'revoked_token' && e.data.subject === 'bob'))
})

test('errors have a stable shape and leak nothing', async () => {
  const { call, db, hub } = await hubForTest()
  const denied = await call('coop_nope', 'GET', '/v1/me')
  assert.equal(denied.body.code, 'unauthorized')
  assert.ok(denied.headers.get('x-request-id'))

  const quiet = console.error
  const logged = []
  console.error = (...args) => logged.push(args.join(' '))
  const original = db.get
  db.get = async () => {
    throw new Error('SQLITE_ERROR near C:\\secret\\path\\hub.db')
  }
  try {
    const response = await hub.fetch(new Request('http://hub/v1/me', { headers: { authorization: `Bearer ${LEAD}` } }))
    const text = await response.text()
    assert.equal(response.status, 500)
    assert.equal(JSON.parse(text).code, 'internal')
    assert.equal(text.includes('SQLITE'), false)
    assert.equal(text.includes('secret'), false)
    assert.ok(JSON.parse(text).request_id, 'with an id to find it in the local log')
    assert.ok(logged.some((line) => line.includes('SQLITE')), 'the detail stays in the local log')
  } finally {
    db.get = original
    console.error = quiet
  }
})

test('health says nothing about the crew', async () => {
  const { call } = await hubForTest()
  const { body, headers } = await call(null, 'GET', '/health')
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'service'])
  assert.equal(headers.get('x-content-type-options'), 'nosniff')
  assert.equal(headers.get('cache-control'), 'no-store')
})

// --- retention ---------------------------------------------------------------

test('old data is removed; active work and members are kept', async () => {
  const { call, invite, tick, db } = await hubForTest({ retentionDays: 30, tokenTtlDays: 0 })
  const bob = await invite('bob')
  const { body: open } = await call(LEAD, 'POST', '/v1/tasks', { title: 'still open' })
  const { body: done } = await call(LEAD, 'POST', '/v1/tasks', { title: 'cancelled long ago' })
  await call(LEAD, 'POST', `/v1/tasks/${done.task.id}/cancel`, {})
  await call(bob, 'POST', '/v1/messages', { text: 'old news' })
  tick(40 * DAY)
  await call(LEAD, 'GET', '/v1/me')
  const ids = (await db.all('SELECT id FROM tasks')).map((t) => t.id)
  assert.deepEqual(ids, [open.task.id])
  assert.equal((await db.all("SELECT * FROM events WHERE text = 'old news'")).length, 0)
  assert.equal((await call(bob, 'GET', '/v1/me')).status, 200)
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM request_log WHERE created_at < '2026-11-01'")).n, 0)
})

test('retention 0 keeps everything', async () => {
  const { call, tick, db } = await hubForTest({ retentionDays: 0 })
  await call(LEAD, 'POST', '/v1/messages', { text: 'keep me' })
  tick(400 * DAY)
  await call(LEAD, 'GET', '/v1/me')
  assert.equal((await db.all("SELECT * FROM events WHERE text = 'keep me'")).length, 1)
})
