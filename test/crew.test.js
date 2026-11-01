// End to end: a real hub, the CLI, and one MCP server per crew member,
// each driven the way Claude Code drives it (stdio MCP client).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { VERSION } from '../src/hub/app.js'
import { startNodeHub } from '../src/hub/node.js'
import { toolsFor } from '../src/mcp/tools.js'

const BIN = fileURLToPath(new URL('../bin/coop.js', import.meta.url))
const LEAD_TOKEN = 'coop_crew-test-lead-token-0123456789'
const run = promisify(execFile)

let home
let hub
const sessions = []

async function coop(...args) {
  return coopWith({}, ...args)
}

async function coopWith(env, ...args) {
  const { stdout } = await run(process.execPath, [BIN, ...args], { env: { ...process.env, COOP_HOME: home, ...env } })
  return stdout
}

// Connect like Claude Code does, and collect what the server pushes.
async function session(profile) {
  const client = new Client({ name: 'test-claude', version: '1.0.0' })
  const pushed = []
  client.fallbackNotificationHandler = async (notification) => {
    pushed.push(notification)
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp', '--profile', profile],
    env: { ...process.env, COOP_HOME: home, COOP_POLL_MS: '200' },
    stderr: 'pipe',
  })
  await client.connect(transport)
  sessions.push(client)

  // Several events can arrive in one batched push, so a push can match more
  // than one wait, but each wait key only once.
  async function waitFor(match, key) {
    const deadline = Date.now() + 10_000
    for (;;) {
      const found = pushed.find((n) => !n.used?.has(key) && match(n))
      if (found) {
        ;(found.used ??= new Set()).add(key)
        return found
      }
      if (Date.now() > deadline) throw new Error(`no ${key} for ${profile}; got ${JSON.stringify(pushed.map((n) => [n.method, n.params?.meta]))}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const channel = (event) =>
    waitFor((n) => {
      if (n.method !== 'notifications/claude/channel') return false
      const { meta, content } = n.params
      return meta.event === event || meta.events?.split(' ').includes(event) || content.includes(event)
    }, event)
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    return { text: result.content[0].text, error: Boolean(result.isError) }
  }
  return { client, pushed, waitFor, channel, call }
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'coop-test-'))
  hub = await startNodeHub({ port: 0, leadToken: LEAD_TOKEN, leadName: 'boss', hubName: 'Test Crew', log: () => {} })
})

after(async () => {
  for (const client of sessions) await client.close().catch(() => {})
  await hub?.close()
  rmSync(home, { recursive: true, force: true })
})

test('a lead and two workers run a task end to end', async () => {
  // Setup through the CLI, as people would do it.
  assert.match(await coop('join', '--hub', hub.url, '--token', LEAD_TOKEN, '--profile', 'boss'), /Joined crew "Test Crew" as boss \(lead\)/)
  const tokenOf = (text) => /--token (\S+)/.exec(text)[1]
  const bobInvite = await coop('invite', 'bob', '--profile', 'boss')
  const annaInvite = await coop('invite', 'anna', '--profile', 'boss')
  assert.match(bobInvite, /coop join --hub/)
  await coop('join', '--hub', hub.url, '--token', tokenOf(bobInvite), '--profile', 'bob')
  await coop('join', '--hub', hub.url, '--token', tokenOf(annaInvite), '--profile', 'anna')
  assert.match(await coop('profiles'), /bob: bob \(worker\)/)
  // Joining and running CLI commands doesn't count as being online.
  assert.match(await coop('status', '--profile', 'boss'), /○ bob: offline \(last seen never\)/)

  const lead = await session('boss')
  const bob = await session('bob')
  const anna = await session('anna')

  const leadTools = (await lead.client.listTools()).tools.map((t) => t.name)
  const workerTools = (await bob.client.listTools()).tools.map((t) => t.name)
  assert.ok(leadTools.includes('coop_assign') && leadTools.includes('coop_review') && !leadTools.includes('coop_claim'))
  assert.ok(workerTools.includes('coop_claim') && workerTools.includes('coop_submit') && !workerTools.includes('coop_assign'))

  // The lead assigns a task to bob; bob's session gets it pushed.
  const assigned = await lead.call('coop_assign', { title: 'Add CSV export', details: 'Export the orders table as CSV.', to: 'bob', scope: 'src/export/' })
  assert.match(assigned.text, /Created #1 "Add CSV export" for bob/)
  const newTask = await bob.channel('task_created')
  assert.match(newTask.params.content, /New task for you: #1 "Add CSV export"/)
  assert.match(newTask.params.content, /Export the orders table as CSV/)
  assert.equal(newTask.params.meta.from_role, 'lead')

  // bob claims, reports and submits; the lead hears each step.
  assert.match((await bob.call('coop_claim', { id: 1 })).text, /It's yours/)
  await lead.channel('task_claimed')
  await bob.call('coop_progress', { id: 1, note: 'Export works, writing tests' })
  await lead.channel('task_progress')
  await bob.call('coop_submit', { id: 1, summary: 'CSV export added, npm test passes', pr_url: 'https://example.com/pr/7' })
  const submitted = await lead.channel('task_submitted')
  assert.match(submitted.params.content, /https:\/\/example.com\/pr\/7/)

  // Changes requested, then approved.
  await lead.call('coop_review', { id: 1, decision: 'changes', feedback: 'Add a header row' })
  assert.match((await bob.channel('task_changes_requested')).params.content, /Add a header row/)
  await bob.call('coop_submit', { id: 1, summary: 'Header row added' })
  await lead.channel('task_submitted')
  assert.match((await lead.call('coop_review', { id: 1, decision: 'approve' })).text, /done on the board; merging it is a separate step/)
  assert.match((await bob.channel('task_approved')).params.content, /Approved your task #1/)
  assert.match((await anna.channel('task_approved')).params.content, /Pull the latest main/, 'other workers hear about merged work')

  // An open task: both workers hear about it, only one gets it.
  await lead.call('coop_assign', { title: 'Translate the FAQ', details: 'All of it.' })
  await bob.channel('Open task: #2')
  await anna.channel('Open task: #2')
  assert.equal((await anna.call('coop_claim', { id: 2 })).error, false)
  const late = await bob.call('coop_claim', { id: 2 })
  assert.equal(late.error, true)
  assert.match(late.text, /in_progress/)

  // Questions and answers.
  await anna.call('coop_send', { text: 'Formal or informal tone?', task_id: 2 })
  assert.match((await lead.channel('message')).params.content, /\[worker anna\] → you \(about #2\): Formal or informal tone\?/)
  await lead.call('coop_send', { to: 'anna', text: 'Informal.' })
  assert.match((await anna.channel('message')).params.content, /Informal/)

  // The board shows the crew.
  const board = (await lead.call('coop_status')).text
  assert.match(board, /● bob: online/)
  assert.match(board, /anna: online, working on #2/)
  assert.match(board, /Recently done: #1 Add CSV export \(bob\)/)
})

test('permission prompts on a worker are relayed to the lead and answered', async () => {
  const lead = sessions[0]
  const bob = sessions[1]
  // Claude Code sends this to a channel that declared claude/channel/permission.
  await bob.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id: 'qwert', tool_name: 'Bash', description: 'Run the test suite', input_preview: '{"command":"npm test"}' },
  })
  // Read it on the lead side.
  const deadline = Date.now() + 10_000
  let request
  while (!request && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const result = await lead.callTool({ name: 'coop_inbox', arguments: {} })
    if (result.content[0].text.includes('asks permission')) request = result.content[0].text
  }
  assert.ok(request, 'the lead got the permission request')
  assert.match(request, /\[worker bob\] asks permission to use Bash: Run the test suite/)
  assert.match(request, /npm test/)
  assert.match(request, /Request id: qwert/)
  assert.match(request, /may not be waiting, and may already have run/, "the lead isn't told the task is paused")

  const verdict = new Promise((resolve) => {
    const previous = bob.fallbackNotificationHandler
    bob.fallbackNotificationHandler = async (notification) => {
      if (notification.method === 'notifications/claude/channel/permission') resolve(notification.params)
      return previous?.(notification)
    }
  })
  // The lead's Claude can't say yes, whatever it is told. It can say no.
  const refused = await lead.callTool({ name: 'coop_permission', arguments: { worker: 'bob', request_id: 'qwert', decision: 'allow' } })
  assert.equal(refused.isError, true)
  assert.match(refused.content[0].text, /coop approve bob qwert/)
  const answer = await lead.callTool({ name: 'coop_permission', arguments: { worker: 'bob', request_id: 'qwert', decision: 'deny' } })
  assert.equal(answer.isError, undefined)
  assert.deepEqual(await verdict, { request_id: 'qwert', behavior: 'deny' })
})

test("approving a task doesn't announce a merge when there may be nothing to merge", async () => {
  const review = toolsFor('lead').find((tool) => tool.name === 'coop_review')
  const client = { taskAction: async () => ({ task: { title: 'Check something' } }) }
  assert.match(await review.run({ client }, { id: 1, decision: 'approve' }), /done on the board\. If it left a branch/)
})

test('coop approve needs a person at a terminal, and the hub needs the passphrase', async () => {
  // Spawned here without a terminal, the way a Claude's shell tool runs things.
  await assert.rejects(coop('approve', 'bob', 'abcde', '--profile', 'boss'), /needs a person at a terminal/)
  await assert.rejects(coop('approvals', 'setup', '--profile', 'boss'), /needs a person at a terminal/)
  // A status that doesn't exist is caught here, instead of landing in the audit log as refused input.
  await assert.rejects(coop('permissions', '--status', 'all', '--profile', 'boss'), /Unknown status "all"\. Use one of: pending, allowed, denied, expired/)
  // And the MCP server has no way to mint a credential into the conversation.
  const tools = (await sessions[0].listTools()).tools.map((t) => t.name)
  assert.ok(!tools.includes('coop_invite'))
})

test('coop_inbox works for sessions without channels', async () => {
  const lead = sessions[0]
  const anna = sessions[2]
  // Drain what anna already has.
  await anna.callTool({ name: 'coop_inbox', arguments: {} })
  const waiting = anna.callTool({ name: 'coop_inbox', arguments: { wait_seconds: 10 } })
  await new Promise((resolve) => setTimeout(resolve, 300))
  await lead.callTool({ name: 'coop_send', arguments: { text: 'Lunch break in 10' } })
  const result = await waiting
  assert.match(result.content[0].text, /Lunch break in 10/)
})

test('coop start builds the right claude command line', async () => {
  const worker = await coop('start', '--profile', 'bob', '--dry-run', '--claude', 'claude')
  assert.match(worker, /--dangerously-load-development-channels server:coop/)
  assert.match(worker, /--permission-mode auto/)
  assert.match(worker, /Start as a claude-code-multi-pc worker/)
  assert.ok(worker.indexOf('server:coop') < worker.indexOf('--name'), 'list options are followed by another option')
  const lead = await coop('start', '--profile', 'boss', '--dry-run', '--claude', 'claude', '--', '--model', 'opus')
  assert.doesNotMatch(lead, /--permission-mode/)
  assert.match(lead.trim(), /--model opus$/)
})

test('coop start reopens the same Claude session instead of adding new ones', async () => {
  const claudeHome = mkdtempSync(join(tmpdir(), 'coop-claude-'))
  const start = (...extra) => coopWith({ CLAUDE_CONFIG_DIR: claudeHome }, 'start', '--profile', 'bob', '--dry-run', '--claude', 'claude', ...extra)
  const idAfter = (flag, text) => new RegExp(`${flag} ([0-9a-f-]{36})`).exec(text)?.[1]
  // What a real coop start remembers, next to a transcript Claude Code would have written.
  const id = randomUUID()
  mkdirSync(join(claudeHome, 'projects', 'some-folder'), { recursive: true })
  writeFileSync(join(claudeHome, 'projects', 'some-folder', `${id}.jsonl`), '')
  mkdirSync(join(home, 'run'), { recursive: true })
  const remember = (fields = {}) => writeFileSync(join(home, 'run', 'bob.session.json'), JSON.stringify({ id, cwd: process.cwd(), version: VERSION, ...fields }))
  try {
    assert.ok(idAfter('--session-id', await start()), 'nothing remembered: a new session')
    remember()
    assert.equal(idAfter('--resume', await start()), id)
    const fresh = idAfter('--session-id', await start('--new'))
    assert.ok(fresh && fresh !== id, '--new starts a fresh session')
    remember({ version: '0.0.1' })
    assert.ok(idAfter('--session-id', await start()), 'after an update: a new session')
    remember({ id: randomUUID() })
    assert.ok(idAfter('--session-id', await start()), 'no transcript left: a new session')
    remember({ pid: process.pid })
    const open = await start()
    assert.match(open, /still looks open/)
    assert.ok(idAfter('--session-id', open), 'never two windows on one session')
    remember()
    assert.doesNotMatch(await start('--', '--continue'), /--session-id|--resume /, 'your own session flags win')
  } finally {
    rmSync(claudeHome, { recursive: true, force: true })
  }
})

test('coop update compares with the latest version and leaves git clones to git', async () => {
  // Stands in for package.json on GitHub.
  let latest = '0.0.1'
  const github = createServer((request, response) => response.end(JSON.stringify({ name: 'claude-code-multi-pc', version: latest })))
  await new Promise((resolve) => github.listen(0, '127.0.0.1', resolve))
  const env = { COOP_UPDATE_URL: `http://127.0.0.1:${github.address().port}/package.json` }
  try {
    assert.match(await coopWith(env, 'update'), /is up to date/)
    latest = '99.0.0'
    assert.match(await coopWith(env, 'update', '--check'), /coop 99\.0\.0 is out \(you have .*\)\. Run coop update/)
    // Tests run from a git clone, where update must point at git pull and not run npm.
    if (existsSync(new URL('../.git', import.meta.url))) assert.match(await coopWith(env, 'update'), /update it there with git pull/)
  } finally {
    github.close()
  }
})
