// Shared setup for the hub's security tests: an in-memory hub with a clock the
// test controls, and a way to send it exactly the request the test means to.
import { randomUUID } from 'node:crypto'
import { createHub } from '../src/hub/app.js'
import { sqliteDatabase } from '../src/hub/sqlite.js'

export const LEAD = 'coop_test-lead-token-0123456789'
export const KEY = 'a'.repeat(64)
export const OTHER_KEY = 'b'.repeat(64)
export const START = Date.parse('2026-10-26T12:00:00Z')

export async function hubForTest(options = {}) {
  let clock = START
  const db = options.db ?? (await sqliteDatabase())
  // The clock stands still in these tests, so the per-minute cap on changes is left to the test that's about it.
  const hub = createHub({ db, leadToken: LEAD, leadName: 'boss', hubName: 'testcrew', maxWorkers: 8, maxWritesPerMinute: 1e9, clientAddress: () => options.address ?? '203.0.113.7', now: () => clock, ...options })

  // A change sends a fresh request id unless the test passes its own headers.
  async function raw(token, method, path, body, headers = {}) {
    return hub.fetch(
      new Request(`http://hub${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
    )
  }
  const fresh = () => ({ 'x-coop-request-id': randomUUID(), 'x-coop-timestamp': String(clock) })
  async function call(token, method, path, body, headers) {
    const response = await raw(token, method, path, body, { ...(method === 'GET' ? {} : fresh()), ...headers })
    const text = await response.text()
    let parsed = {}
    try {
      parsed = JSON.parse(text)
    } catch {}
    return { status: response.status, body: parsed, text, headers: response.headers }
  }
  async function invite(name, extra = {}) {
    const { status, body } = await call(LEAD, 'POST', '/v1/members', { name, ...extra })
    if (status !== 201) throw new Error(`invite ${name}: ${status} ${JSON.stringify(body)}`)
    return body.token
  }
  async function setPassphrase(key = KEY) {
    const { status, body } = await call(LEAD, 'POST', '/v1/approvals/setup', { key, salt: 'c'.repeat(32), kdf: 'scrypt:32768:8:1' })
    if (status !== 200) throw new Error(`approval setup: ${status} ${JSON.stringify(body)}`)
  }
  const ask = (token, request_id, extra = {}) => call(token, 'POST', '/v1/permissions', { request_id, tool_name: 'Bash', description: 'run a command', input_preview: 'npm test', cwd: '~/project', ...extra })
  const answer = (worker, request_id, behavior, extra = {}, token = LEAD) => call(token, 'POST', '/v1/permissions/verdict', { worker, request_id, behavior, ...extra })
  async function audit(type) {
    const { body } = await call(LEAD, 'GET', `/v1/audit?limit=500${type ? `&type=${type}` : ''}`)
    return body.entries
  }
  async function eventsFor(token, after = 0) {
    return (await call(token, 'GET', `/v1/events?after=${after}&limit=200`)).body.events
  }
  return { db, hub, raw, call, invite, setPassphrase, ask, answer, audit, eventsFor, fresh, tick: (ms) => (clock += ms), now: () => clock }
}

// Small and seeded, so that a failing fuzz run can be repeated exactly.
export function seededRandom(seed) {
  let state = seed >>> 0 || 1
  const next = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 2 ** 32
  }
  next.int = (max) => Math.floor(next() * max)
  next.pick = (list) => list[next.int(list.length)]
  return next
}
