// Seeded fuzzing. Each run repeats exactly, so a failure can be reproduced: the
// failing input is in the assertion message, and COOP_FUZZ_SEED picks another
// sequence. The property in each case: never a crash, never a 500, and nothing
// that gets through breaks the rule the parser is there for.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commandProblem, prePushProblem, toolProblem } from '../src/guard.js'
import { classifyRisk } from '../src/hub/risk.js'
import { describeEvent, formatBoard } from '../src/format.js'
import { isWellFormedEvent, metaFor, pushText } from '../src/mcp/messages.js'
import { lexicalPathProblem, pathProblem } from '../src/paths.js'
import { redactSecrets } from '../src/secrets.js'
import { branchProblem, cleanText, hostKind, httpsUrlProblem, neutralizeMarkup, parseHubUrl } from '../src/validate.js'
import { LEAD, hubForTest, seededRandom } from './helpers.js'

const SEED = Number(process.env.COOP_FUZZ_SEED) || 20261101
const ROUNDS = Number(process.env.COOP_FUZZ_ROUNDS) || 400

const uri = (text) => encodeURI(text.toWellFormed())

const FRAGMENTS = ['', ' ', '..', '../', '..\\', '/', '\\', '\\\\', '//', ':', ';', '|', '&', '&&', '$(id)', '`id`', '"', "'", '<', '>', '</channel>', '<system>', '%00', '\0', '\n', '\r\n', '\t', '\u001B[2J', '\u0007', '\u007F', '\u0085', '__proto__', 'constructor', 'prototype', 'null', 'undefined', 'NaN', '-1', '0', '1e999', '99999999999999999999', 'main', 'HEAD', 'refs/heads/main', '--force', '-f', '--upload-pack=x', 'C:', 'C:\\', 'CON', 'NUL', 'com1', '.', '~', '~/.ssh/id_rsa', '$HOME', '%USERPROFILE%', 'é', '日本語', '🤖', 'a', 'A', 'abcde', 'bob', 'boss', 'coop_', 'Bearer ', 'x'.repeat(300), String.fromCharCode(0x202e), String.fromCharCode(0x2028), String.fromCharCode(0xd800), String.fromCharCode(0xfeff), '{', '}', '[', ']', '=', '?', '#', '*', '@', '@{1}', 'password=', 'ghp_']

function fuzzString(random, max = 6) {
  let text = ''
  for (let i = random.int(max + 1); i > 0; i--) text += random.pick(FRAGMENTS)
  return text
}

function fuzzValue(random, depth = 0) {
  switch (random.int(depth > 2 ? 6 : 9)) {
    case 0:
      return null
    case 1:
      return random() < 0.5
    case 2:
      return random.pick([0, -1, 1.5, 1e308, Number.MAX_SAFE_INTEGER, 2 ** 53])
    case 3:
    case 4:
    case 5:
      return fuzzString(random)
    case 6:
      return Array.from({ length: random.int(4) }, () => fuzzValue(random, depth + 1))
    default: {
      const entries = Array.from({ length: random.int(4) }, () => [random.pick(['title', 'name', 'to', 'text', 'note', '__proto__', 'constructor', 'toString', 'valueOf', 'role', 'branch', fuzzString(random, 2)]), fuzzValue(random, depth + 1)])
      return Object.fromEntries(entries)
    }
  }
}

test('API: hostile bodies and paths never cause a 500 or a crash', { timeout: 120_000 }, async () => {
  const random = seededRandom(SEED)
  const { raw, call, invite, fresh } = await hubForTest({ rateLimits: Object.fromEntries(['task_create', 'task_action', 'message', 'permission', 'member', 'token'].map((k) => [k, [1e9, 3_600_000]])) })
  let worker = await invite('bob')
  await call(LEAD, 'POST', '/v1/tasks', { title: 'target' })
  const PATHS = ['/v1/tasks', '/v1/tasks/1/claim', '/v1/tasks/1/submit', '/v1/tasks/1/assign', '/v1/tasks/1/comment', '/v1/messages', '/v1/members', '/v1/permissions', '/v1/permissions/verdict', '/v1/tokens/rotate', '/v1/tokens/revoke-all', '/v1/approvals/setup']
  const before = console.error
  const internal = []
  console.error = (...args) => internal.push(args.join(' '))
  try {
    for (let round = 0; round < ROUNDS; round++) {
      // A lucky round can rotate or revoke the worker's own token: that's allowed, so get a new one.
      if ((await call(worker, 'GET', '/v1/me')).status === 401) worker = await invite('bob')
      const token = random.pick([LEAD, worker, worker, 'coop_nope', null])
      const path = random() < 0.8 ? random.pick(PATHS) : `/v1/${uri(fuzzString(random, 3))}`
      const method = random.pick(['POST', 'POST', 'POST', 'GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'])
      const body = ['GET', 'OPTIONS'].includes(method) ? undefined : random() < 0.2 ? fuzzString(random) : JSON.stringify(fuzzValue(random))
      const headers = random() < 0.8 ? fresh() : { 'x-coop-request-id': uri(fuzzString(random, 2)).slice(0, 100), 'x-coop-timestamp': uri(fuzzString(random, 1)).slice(0, 50) }
      let response
      try {
        response = await raw(token, method, path, body, method === 'GET' ? {} : headers)
      } catch (error) {
        if (error instanceof TypeError) continue // The Request constructor refused it first: it never reached the hub.
        throw error
      }
      assert.notEqual(response.status, 500, `round ${round}: ${method} ${path} ${body?.slice(0, 200)} -> ${internal.at(-1)}`)
      assert.ok(response.status < 500, `round ${round}: got ${response.status}`)
      const text = await response.text()
      assert.equal(/\bat .+:\d+:\d+/.test(text), false, `a stack trace? ${text.slice(0, 200)}`)
    }
  } finally {
    console.error = before
  }
  assert.deepEqual(internal, [])
  assert.equal({}.polluted, undefined)
  assert.equal((await call(LEAD, 'GET', '/v1/me')).body.role, 'lead', 'the lead is still the lead')
})

test('API: whatever is stored can be read back and shown', async () => {
  const random = seededRandom(SEED + 1)
  const { call } = await hubForTest({ rateLimits: Object.fromEntries(['task_create', 'task_action', 'message', 'permission', 'member', 'token'].map((k) => [k, [1e9, 3_600_000]])) })
  for (let round = 0; round < 100; round++) {
    await call(LEAD, 'POST', '/v1/tasks', { title: `t ${fuzzString(random, 4)}`.slice(0, 200), details: fuzzString(random), scope: fuzzString(random, 2) })
    await call(LEAD, 'POST', '/v1/messages', { text: `m ${fuzzString(random)}` })
  }
  const { body: board, status } = await call(LEAD, 'GET', '/v1/board')
  assert.equal(status, 200)
  const shown = formatBoard(board)
  assert.equal(shown.includes('\u001B'), false, 'no escape sequences reach a terminal')
  for (const event of board.recent) assert.equal(typeof describeEvent(event), 'string')
  const { body: all } = await call(LEAD, 'GET', '/v1/events?after=0&limit=200')
  const { body: mine } = await call(LEAD, 'GET', '/v1/tasks?limit=200')
  assert.equal(JSON.stringify(mine.tasks).includes('\u0000'), false)
  assert.ok(all.events)
})

test('parsers: branch names, URLs, hub addresses', () => {
  const random = seededRandom(SEED + 2)
  for (let round = 0; round < ROUNDS * 5; round++) {
    const text = fuzzString(random)
    if (branchProblem(text) === null) {
      assert.match(text, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/, `branch ${JSON.stringify(text)}`)
      assert.equal(text.includes('..'), false, text)
      assert.notEqual(text.toLowerCase(), 'main')
    }
    if (httpsUrlProblem(`https://${text}`) === null) assert.equal(new URL(`https://${text}`).protocol, 'https:')
    assert.equal(httpsUrlProblem(`javascript:${text}`) === null, false, text)

    for (const scheme of ['http://', 'https://', '']) {
      try {
        const { url, kind, plain } = parseHubUrl(`${scheme}${text}`)
        assert.ok(url.startsWith('http'))
        assert.ok(!plain || kind !== 'public', `plain http to a public host: ${scheme}${text}`)
      } catch (error) {
        assert.ok(typeof error.message === 'string' && !/[\u0000-\u0008\u001B]/.test(error.message), JSON.stringify(error.message))
      }
    }
    assert.ok(['loopback', 'tailscale', 'private', 'public'].includes(hostKind(text)))
  }
})

test('text: cleaning and neutralising hold whatever comes in', () => {
  const random = seededRandom(SEED + 3)
  for (let round = 0; round < ROUNDS * 5; round++) {
    const text = fuzzString(random, 10)
    const clean = cleanText(text)
    assert.equal(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(clean), false, JSON.stringify(text))
    assert.equal(cleanText(clean), clean, 'cleaning twice changes nothing')
    const safe = neutralizeMarkup(clean)
    assert.equal(/<\/?(?:channel|system|function|antml|tool|invoke|parameter)/i.test(safe), false, JSON.stringify(text))
    const { text: redacted, kinds } = redactSecrets(text)
    assert.equal(typeof redacted, 'string')
    assert.ok(Array.isArray(kinds))
    assert.equal(redactSecrets(redacted).kinds.includes('github-token'), false)
    assert.ok(['high', 'medium', 'low'].includes(classifyRisk(text, fuzzString(random), fuzzString(random))))
  }
})

test('text: markup split up by control characters does not come back together', () => {
  for (const text of ['</chan\u0000nel>', '<\u001B[0m/channel>', `<${String.fromCharCode(0x202e)}/channel>`, '<sys\u0007tem>', '<\u0000system-reminder>']) {
    const safe = neutralizeMarkup(cleanText(text))
    assert.equal(/<\/?(?:channel|system)/i.test(safe), false, JSON.stringify(text))
  }
})

test('messages: malformed events are filtered out, the rest stay inside their tag', () => {
  const random = seededRandom(SEED + 4)
  for (let round = 0; round < ROUNDS; round++) {
    const event = fuzzValue(random)
    assert.equal(typeof isWellFormedEvent(event), 'boolean')
    const shaped = { id: round + 1, ts: '2026-01-01T00:00:00.000Z', type: random.pick(['message', 'task_created', 'permission_request', 'security_alert', 'task_comment', fuzzString(random, 1)]), actor: fuzzString(random, 2) || 'bob', actor_role: random.pick(['lead', 'worker', 'system', fuzzString(random, 1)]), target: null, task_id: random.pick([null, 1]), text: fuzzString(random, 8), data: { title: fuzzString(random, 3), request_id: fuzzString(random, 1), tool_name: fuzzString(random, 2), input_preview: fuzzString(random, 3), to: fuzzString(random, 1) } }
    if (!isWellFormedEvent(shaped)) continue
    for (const role of ['lead', 'worker']) {
      const combined = JSON.stringify([pushText(shaped, { name: 'p', member: 'me', role, lead: 'boss', crew: 'c' }), metaFor(shaped)])
      assert.equal(/<\/channel/i.test(combined), false, JSON.stringify(shaped))
      assert.equal(combined.includes('\\u001b'), false, JSON.stringify(shaped))
    }
  }
})

test('paths: whatever passes is really inside the project', () => {
  const random = seededRandom(SEED + 5)
  const base = mkdtempSync(join(tmpdir(), 'coop-fuzz-'))
  writeFileSync(join(base, 'x'), 'x')
  try {
    for (let round = 0; round < ROUNDS * 2; round++) {
      const candidate = fuzzString(random, 5)
      for (const platform of ['win32', 'linux']) {
        const problem = lexicalPathProblem(candidate, platform)
        assert.ok(problem === null || typeof problem === 'string')
        if (problem === null && platform === 'win32') {
          assert.equal(candidate.includes('\0'), false)
          assert.equal(/^[\\/]{2}/.test(candidate), false, JSON.stringify(candidate))
        }
      }
      const result = pathProblem(candidate, { root: base })
      if (result === null && /^\.\.(?:[\\/]|$)/.test(candidate) && !/\.\.[\\/]\.\./.test(candidate)) {
        assert.fail(`climbed out with ${JSON.stringify(candidate)}`)
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('guard: hostile tool calls are answered, never crash', () => {
  const random = seededRandom(SEED + 6)
  const base = mkdtempSync(join(tmpdir(), 'coop-fuzz-'))
  try {
    for (let round = 0; round < ROUNDS * 2; round++) {
      const tool_name = random.pick(['Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS', 'NotebookEdit', fuzzString(random, 1)])
      const input = random() < 0.1 ? fuzzValue(random) : { tool_name, tool_input: random() < 0.1 ? fuzzValue(random) : { command: random() < 0.5 ? fuzzString(random) : fuzzValue(random), file_path: fuzzValue(random), path: fuzzString(random, 2), pattern: fuzzString(random, 3), notebook_path: fuzzString(random, 1) }, cwd: random() < 0.9 ? base : fuzzString(random, 1) }
      for (const role of ['worker', 'lead']) {
        const result = toolProblem(input, { role, projectDir: base, home: base, temp: base, claudeDir: base })
        assert.ok(result === null || typeof result === 'string')
      }
      const command = fuzzString(random, 6)
      for (const role of ['worker', 'lead']) {
        const result = commandProblem(command, role)
        assert.ok(result === null || typeof result === 'string')
      }
    }
    for (let round = 0; round < 50; round++) {
      const stdin = random() < 0.5 ? fuzzString(random) : `refs/heads/x ${'0'.repeat(40)} refs/heads/${fuzzString(random, 1)} ${'0'.repeat(40)}\n`
      const result = prePushProblem(stdin, { cwd: base, remote: 'origin' })
      assert.ok(result === null || typeof result === 'string')
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('guard: known ways to write "push to main" are all caught, in any spelling of the rest', () => {
  const random = seededRandom(SEED + 7)
  for (let round = 0; round < ROUNDS; round++) {
    const spacing = () => random.pick([' ', '  ', '\t'])
    const flag = random.pick(['', '-u', '--set-upstream', '-v', '--quiet'])
    const destination = random.pick(['main', 'master', 'HEAD:main', 'x:main', '+main', 'x:refs/heads/main', 'HEAD:refs/heads/master'])
    const prefix = random.pick(['', 'cd x && ', 'true; ', 'false || '])
    const command = `${prefix}git${spacing()}push${spacing()}${flag}${spacing()}origin${spacing()}${destination}`
    assert.ok(commandProblem(command, 'worker'), command)
  }
})

test('auth: hostile authorization headers never get in and never crash', async () => {
  const random = seededRandom(SEED + 8)
  const { raw, call } = await hubForTest({ address: 'fuzz-auth' })
  let refused = 0
  for (let round = 0; round < ROUNDS; round++) {
    const value = random.pick(['Bearer ', 'bearer ', 'BEARER ', '', 'Basic ', 'Token ']) + fuzzString(random, 3)
    let response
    try {
      response = await raw(null, 'GET', '/v1/me', undefined, { authorization: value })
    } catch (error) {
      if (error instanceof TypeError) continue // Not a legal header: it never reached the hub.
      throw error
    }
    assert.ok(response.status === 401 || response.status === 429, `${JSON.stringify(value)} -> ${response.status}`)
    refused++
    await response.text()
  }
  assert.ok(refused > 50)
  assert.equal((await call(LEAD, 'GET', '/v1/me')).status, 200)
})

test('config: a hostile profile name never reaches the file system or the prototype', async () => {
  const { getProfile } = await import('../src/config.js')
  const random = seededRandom(SEED + 9)
  const home = mkdtempSync(join(tmpdir(), 'coop-fuzz-'))
  const previous = process.env.COOP_HOME
  process.env.COOP_HOME = home
  writeFileSync(join(home, 'config.json'), JSON.stringify({ default: 'real', profiles: { real: { hub: 'https://x', token: 't', member: 'bob', role: 'worker', lead: 'boss', crew: 'c' } } }))
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const name = `${random.pick(['', '../', '__proto__', 'constructor', 'REAL'])}${fuzzString(random, 2)}x`
      assert.throws(() => getProfile(name), /profile/i, JSON.stringify(name))
    }
    assert.equal(getProfile('real').member, 'bob')
  } finally {
    if (previous === undefined) delete process.env.COOP_HOME
    else process.env.COOP_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
