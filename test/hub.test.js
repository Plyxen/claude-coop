import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { branchName, createHub } from '../src/hub/app.js'
import { sqliteDatabase } from '../src/hub/sqlite.js'

const LEAD = 'coop_test-lead-token-0123456789'

async function setup({ maxWorkers = 3 } = {}) {
  let clock = Date.parse('2026-10-26T12:00:00Z')
  const db = await sqliteDatabase()
  const hub = createHub({ db, leadToken: LEAD, leadName: 'boss', hubName: 'testcrew', maxWorkers, now: () => clock })
  // Changes carry a fresh request id, like the current client's.
  async function call(token, method, path, body, headers = {}) {
    const fresh = method === 'GET' ? {} : { 'x-coop-request-id': randomUUID(), 'x-coop-timestamp': String(clock) }
    const response = await hub.fetch(
      new Request(`http://hub${path}`, {
        method,
        headers: { ...fresh, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
    return { status: response.status, body: await response.json() }
  }
  async function invite(name) {
    const { status, body } = await call(LEAD, 'POST', '/v1/members', { name })
    assert.equal(status, 201, JSON.stringify(body))
    return body.token
  }
  async function events(token, after = 0) {
    const { body } = await call(token, 'GET', `/v1/events?after=${after}`)
    return body.events
  }
  return { call, invite, events, tick: (ms) => (clock += ms) }
}

test('health is public, everything else needs a valid token', async () => {
  const { call } = await setup()
  const health = await call(null, 'GET', '/health')
  assert.equal(health.body.ok, true)
  assert.equal(JSON.stringify(health.body).includes('testcrew'), false, "the crew's name isn't public")
  assert.equal((await call(null, 'GET', '/v1/me')).status, 401)
  assert.equal((await call('coop_wrong', 'GET', '/v1/me')).status, 401)
  const me = await call(LEAD, 'GET', '/v1/me')
  assert.deepEqual([me.body.name, me.body.role, me.body.lead], ['boss', 'lead', 'boss'])
})

test('the lead invites workers; workers cannot invite; the crew has a size limit', async () => {
  const { call, invite } = await setup({ maxWorkers: 2 })
  const bob = await invite('bob')
  assert.match(bob, /^coop_/)
  assert.deepEqual((await call(bob, 'GET', '/v1/me')).body.role, 'worker')
  assert.equal((await call(bob, 'POST', '/v1/members', { name: 'eve' })).status, 403)
  await invite('anna')
  const full = await call(LEAD, 'POST', '/v1/members', { name: 'carl' })
  assert.equal(full.status, 409)
  assert.match(full.body.error, /full/)
  assert.equal((await call(LEAD, 'POST', '/v1/members', { name: 'Bad Name!' })).status, 400)

  // Inviting an existing worker again rotates their token.
  const again = await call(LEAD, 'POST', '/v1/members', { name: 'bob' })
  assert.equal(again.body.rotated, true)
  assert.equal((await call(bob, 'GET', '/v1/me')).status, 401)
  assert.equal((await call(again.body.token, 'GET', '/v1/me')).status, 200)
})

test('a task goes from assigned to done, and everyone hears about it', async () => {
  const { call, invite, events } = await setup()
  const bob = await invite('bob')
  const anna = await invite('anna')

  const created = await call(LEAD, 'POST', '/v1/tasks', { title: 'Add CSV export', details: 'Export the table.', to: 'bob', priority: 'high' })
  assert.equal(created.status, 201)
  const id = created.body.task.id
  assert.equal(created.body.task.status, 'assigned')
  assert.equal(created.body.task.branch, `coop/${id}-add-csv-export`)

  assert.equal((await call(anna, 'POST', `/v1/tasks/${id}/claim`)).status, 409, "anna can't take bob's task")
  assert.equal((await call(bob, 'POST', `/v1/tasks/${id}/submit`, { note: 'x' })).status, 409, 'must claim first')
  assert.equal((await call(bob, 'POST', `/v1/tasks/${id}/claim`)).body.task.status, 'in_progress')
  assert.equal((await call(anna, 'POST', `/v1/tasks/${id}/progress`, { note: 'hi' })).status, 403)
  assert.equal((await call(bob, 'POST', `/v1/tasks/${id}/progress`, {})).status, 400, 'progress needs a note')
  await call(bob, 'POST', `/v1/tasks/${id}/progress`, { note: 'half done' })
  const submitted = await call(bob, 'POST', `/v1/tasks/${id}/submit`, { note: 'Done, tests pass', pr_url: 'https://example.com/pr/1' })
  assert.equal(submitted.body.task.status, 'review')
  assert.equal(submitted.body.task.pr_url, 'https://example.com/pr/1')

  assert.equal((await call(bob, 'POST', `/v1/tasks/${id}/approve`)).status, 403, 'workers cannot approve')
  const back = await call(LEAD, 'POST', `/v1/tasks/${id}/changes`, { note: 'Add a header row' })
  assert.equal(back.body.task.status, 'in_progress')
  assert.equal(back.body.task.assignee, 'bob')
  await call(bob, 'POST', `/v1/tasks/${id}/submit`, { note: 'Header added' })
  assert.equal((await call(LEAD, 'POST', `/v1/tasks/${id}/approve`, { note: 'Nice' })).body.task.status, 'done')

  const leadSees = (await events(LEAD)).map((e) => e.type)
  assert.deepEqual(
    leadSees.filter((t) => t.startsWith('task_')),
    ['task_claimed', 'task_progress', 'task_submitted', 'task_submitted'],
    'the lead hears what workers do, not its own actions',
  )
  const bobSees = (await events(bob)).map((e) => e.type)
  assert.ok(bobSees.includes('task_created') && bobSees.includes('task_changes_requested') && bobSees.includes('task_approved'))
  assert.ok(!bobSees.includes('task_claimed'), "bob doesn't get his own events back")

  const { body } = await call(anna, 'GET', `/v1/tasks/${id}`)
  assert.equal(body.task.status, 'done')
  assert.ok(body.history.length >= 6)
})

test('only one worker wins an open task', async () => {
  const { call, invite } = await setup()
  const bob = await invite('bob')
  const anna = await invite('anna')
  const { body } = await call(LEAD, 'POST', '/v1/tasks', { title: 'Open job' })
  assert.equal(body.task.status, 'open')
  const results = await Promise.all([call(bob, 'POST', `/v1/tasks/${body.task.id}/claim`), call(anna, 'POST', `/v1/tasks/${body.task.id}/claim`)])
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
})

test('the lead can reassign, release, cancel and reopen tasks', async () => {
  const { call, invite } = await setup()
  await invite('bob')
  const anna = await invite('anna')
  const { body } = await call(LEAD, 'POST', '/v1/tasks', { title: 'Shuffle me', to: 'bob' })
  const id = body.task.id
  assert.equal((await call(LEAD, 'POST', `/v1/tasks/${id}/assign`, { to: 'anna' })).body.task.assignee, 'anna')
  assert.equal((await call(LEAD, 'POST', `/v1/tasks/${id}/assign`, { to: 'nobody' })).status, 404)
  await call(anna, 'POST', `/v1/tasks/${id}/claim`)
  const released = await call(anna, 'POST', `/v1/tasks/${id}/release`, { note: 'not my area' })
  assert.deepEqual([released.body.task.status, released.body.task.assignee], ['open', null])
  assert.equal((await call(LEAD, 'POST', `/v1/tasks/${id}/cancel`)).body.task.status, 'cancelled')
  assert.equal((await call(LEAD, 'POST', `/v1/tasks/${id}/cancel`)).status, 409)
  const reopened = await call(LEAD, 'POST', `/v1/tasks/${id}/reopen`, { to: 'bob' })
  assert.deepEqual([reopened.body.task.status, reopened.body.task.assignee], ['assigned', 'bob'])
  assert.equal((await call(LEAD, 'POST', `/v1/tasks/${id}/explode`)).status, 404)
})

test('messages reach who they are for', async () => {
  const { call, invite, events } = await setup()
  const bob = await invite('bob')
  const anna = await invite('anna')
  await call(LEAD, 'POST', '/v1/messages', { to: 'bob', text: 'just for bob' })
  await call(LEAD, 'POST', '/v1/messages', { text: 'for everyone' })
  await call(anna, 'POST', '/v1/messages', { to: 'lead', text: 'question for the lead' })
  assert.equal((await call(anna, 'POST', '/v1/messages', { to: 'anna', text: 'me' })).status, 400)

  const texts = async (token) => (await events(token)).filter((e) => e.type === 'message').map((e) => e.text)
  assert.deepEqual(await texts(bob), ['just for bob', 'for everyone'])
  assert.deepEqual(await texts(anna), ['for everyone'])
  assert.deepEqual(await texts(LEAD), ['question for the lead'])
})

test('permission requests go to the lead and the verdict back to the worker', async () => {
  const { call, invite, events } = await setup()
  const bob = await invite('bob')
  assert.equal((await call(LEAD, 'POST', '/v1/permissions', { request_id: 'abcde' })).status, 403)
  assert.equal((await call(bob, 'POST', '/v1/permissions', { request_id: 'abcdl' })).status, 400, 'ids never contain l')
  await call(bob, 'POST', '/v1/permissions', { request_id: 'abcde', tool_name: 'Bash', description: 'Run the tests', input_preview: '{"command":"npm test"}' })

  const request = (await events(LEAD)).find((e) => e.type === 'permission_request')
  assert.equal(request.data.request_id, 'abcde')
  assert.equal(request.data.tool_name, 'Bash')

  assert.equal((await call(bob, 'POST', '/v1/permissions/verdict', { worker: 'bob', request_id: 'abcde', behavior: 'allow' })).status, 403)
  assert.equal((await call(LEAD, 'POST', '/v1/permissions/verdict', { worker: 'bob', request_id: 'zzzzz', behavior: 'deny' })).status, 404)
  assert.equal((await call(LEAD, 'POST', '/v1/permissions/verdict', { worker: 'bob', request_id: 'abcde', behavior: 'deny' })).status, 200)
  assert.equal((await call(LEAD, 'POST', '/v1/permissions/verdict', { worker: 'bob', request_id: 'abcde', behavior: 'deny' })).status, 409)

  const verdict = (await events(bob)).find((e) => e.type === 'permission_verdict')
  assert.deepEqual(verdict.data, { request_id: 'abcde', behavior: 'deny' })
})

test('removing a worker revokes the token and frees their tasks', async () => {
  const { call, invite } = await setup()
  const bob = await invite('bob')
  const { body } = await call(LEAD, 'POST', '/v1/tasks', { title: 'Held', to: 'bob' })
  await call(bob, 'POST', `/v1/tasks/${body.task.id}/claim`)
  const removed = await call(LEAD, 'DELETE', '/v1/members/bob')
  assert.deepEqual(removed.body.released, [body.task.id])
  assert.equal((await call(bob, 'GET', '/v1/me')).status, 401)
  assert.equal((await call(LEAD, 'GET', `/v1/tasks/${body.task.id}`)).body.task.status, 'open')
  assert.equal((await call(LEAD, 'DELETE', '/v1/members/boss')).status, 409)
})

test('presence: the board shows who is online, and a returning member is announced', async () => {
  const { call, invite, events, tick } = await setup()
  const bob = await invite('bob')
  await call(bob, 'GET', '/v1/me')
  let board = (await call(LEAD, 'GET', '/v1/board')).body
  assert.equal(board.members.find((m) => m.name === 'bob').online, true)
  tick(5 * 60_000)
  board = (await call(LEAD, 'GET', '/v1/board')).body
  assert.equal(board.members.find((m) => m.name === 'bob').online, false)
  const before = (await events(LEAD)).filter((e) => e.type === 'member_online').length
  await call(bob, 'GET', '/v1/me')
  assert.equal((await events(LEAD)).filter((e) => e.type === 'member_online').length, before + 1)
})

test('presence: requests with x-coop-presence off (the CLI) do not count', async () => {
  const { call, invite, events } = await setup()
  const bob = await invite('bob')
  const cli = { 'x-coop-presence': 'off' }
  const bobOnline = async () => (await call(LEAD, 'GET', '/v1/board')).body.members.find((m) => m.name === 'bob').online
  const bobAnnounced = async () => (await events(LEAD)).filter((e) => e.type === 'member_online' && e.actor === 'bob').length

  assert.equal((await call(bob, 'GET', '/v1/me', undefined, cli)).status, 200)
  assert.equal((await call(bob, 'GET', '/v1/board', undefined, cli)).status, 200)
  assert.equal(await bobOnline(), false)
  assert.equal(await bobAnnounced(), 0)

  await call(bob, 'GET', '/v1/events?after=0')
  assert.equal(await bobOnline(), true)
  assert.equal(await bobAnnounced(), 1)
})

test('the event cursor pages through without skipping', async () => {
  const { call, invite } = await setup()
  const bob = await invite('bob')
  for (let i = 0; i < 7; i++) await call(LEAD, 'POST', '/v1/messages', { text: `m${i}` })
  const seen = []
  let cursor = 0
  for (let page = 0; page < 10; page++) {
    const { body } = await call(bob, 'GET', `/v1/events?after=${cursor}&limit=3`)
    seen.push(...body.events.filter((e) => e.type === 'message').map((e) => e.text))
    if (body.cursor === cursor) break
    cursor = body.cursor
  }
  assert.deepEqual(seen, ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'])
})

test('bad input is refused with a clear error', async () => {
  const { call } = await setup()
  assert.equal((await call(LEAD, 'POST', '/v1/tasks', {})).status, 400)
  assert.equal((await call(LEAD, 'POST', '/v1/tasks', { title: 'x'.repeat(201) })).status, 400)
  assert.equal((await call(LEAD, 'POST', '/v1/tasks', { title: 'ok', priority: 'urgent' })).status, 400)
  assert.equal((await call(LEAD, 'GET', '/v1/tasks/abc')).status, 400)
  assert.equal((await call(LEAD, 'GET', '/v1/tasks/999')).status, 404)
  assert.equal((await call(LEAD, 'GET', '/v1/nothing')).status, 404)
})

test('branch names are short, ascii and safe', () => {
  assert.equal(branchName(12, 'Crème brûlée façade: naïve über-fix!'), 'coop/12-creme-brulee-facade-naive-uber-fix')
  assert.equal(branchName(3, '!!!'), 'coop/3')
  assert.equal(branchName(4, 'a'.repeat(100)), `coop/4-${'a'.repeat(40)}`)
})

test('long titles are shortened at a word, not mid-word or on "for"', () => {
  assert.equal(branchName(1, 'Update "Working together" in CLAUDE.md for claude-coop'), 'coop/1-update-working-together-in-claude-md')
  assert.equal(branchName(2, 'Translate the dashboard settings page into Hungarian'), 'coop/2-translate-the-dashboard-settings-page')
  assert.equal(branchName(5, 'Add CSV export of the monthly report to the dashboard'), 'coop/5-add-csv-export-of-the-monthly-report')
  // Titles that fit are left alone, even if they end on a short word.
  assert.equal(branchName(6, 'Fix sign in'), 'coop/6-fix-sign-in')
  assert.equal(branchName(7, 'What is this for'), 'coop/7-what-is-this-for')
})
