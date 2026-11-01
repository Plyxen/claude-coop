#!/usr/bin/env node
// claude-code-multi-pc command line. `coop help` lists the commands.
import { existsSync, mkdirSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// Claude Code lets a tool call through when its hook fails with anything other
// than exit code 2, so whatever goes wrong in a guard, even loading coop, blocks.
if (process.argv[2] === 'guard') {
  try {
    const { runGuard } = await import('../src/guard-cli.js')
    process.exit(runGuard(process.argv.slice(3)))
  } catch (error) {
    writeSync(2, `coop guard could not check this, so it is blocked: ${error.message}\n`)
    process.exit(2)
  }
}

// node:sqlite prints an ExperimentalWarning on import; keep the CLI quiet.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') console.error(warning)
})

const { HubClient } = await import('../src/client.js')
const config = await import('../src/config.js')
const { ago, formatBoard } = await import('../src/format.js')
const { VERSION, newToken, sha256 } = await import('../src/hub/app.js')
const { INSTALL_COMMAND, REPO, inviteText } = await import('../src/meta.js')
const { ROLES, cleanText, hostKind, isCrewName, isMemberName, parseHubUrl } = await import('../src/validate.js')

// CLI commands are one-off, so they don't count as being online.
const hubClient = (profile) => new HubClient({ ...profile, presence: false })

const HELP = `claude-code-multi-pc ${VERSION}: one lead Claude, a crew of worker Claudes on other PCs.

Lead
  coop hub [--port 8765] [--host 127.0.0.1] [--data DIR] [--lead-name NAME] [--crew NAME]
           [--public-bind] [--token-ttl-days 90] [--retention-days 90]
           [--rotate-lead-token] [--reset-approval]
                                  Run a self-hosted hub (or deploy one to Cloudflare: see docs)
  coop invite NAME [--observer] [--device LABEL]
                                  Invite a friend's Claude as a worker; prints what to send them.
                                  --observer can only read. --device adds a token for another PC
  coop remove NAME                Remove a worker; their unfinished tasks go back to the pool
  coop approvals setup            Set the passphrase that only a person can use to approve things
  coop approvals status           Show whether one is set
  coop permissions [--status S]   List workers' permission requests (default: the open ones)
  coop approve WORKER ID          Approve one, in your own terminal, with your passphrase
  coop deny WORKER ID             Refuse one
  coop audit [--type T] [--limit N] [--alerts]
                                  Read the hub's security log

Everyone
  coop join --hub URL [--token TOKEN] [--profile NAME] [--insecure-dev-mode]
                                  Save a crew profile on this PC (tokens stay in ~/.claude-coop).
                                  Without --token it asks, so the token stays out of your shell history
  coop audit --local [--limit N]  What coop's guard blocked on this PC
  coop start [--new] [--permission-mode MODE] [--worktree] [--no-relay] [--sandbox] [--prompt TEXT] [--dry-run] [-- CLAUDE ARGS]
                                  Start Claude Code in this folder, connected to the crew. Reopens
                                  your last coop session here; --new starts a fresh one.
                                  --sandbox confines shell commands where the OS allows it (not native Windows)
  coop status                     Show the crew board
  coop tokens [--member NAME]     List tokens: yours, or everyone's for the lead
  coop tokens rotate              Replace this PC's token, and save the new one
  coop tokens revoke ID           Stop one token working, right away
  coop tokens revoke-all [--member NAME]
                                  Stop all of someone's tokens working
  coop doctor                     Check this PC's setup
  coop update [--check]           Update coop to the latest version (--check: only look)
  coop profiles                   List your crew profiles
  coop use PROFILE                Make a profile the default

Other
  coop token                      Print a new random lead token
  coop mcp                        Run the MCP server (coop start does this for you)
  coop guard                      The checks coop start installs (Claude Code and git run these)

Most commands take --profile NAME to pick a crew other than your default.`

const [command = 'help', ...rest] = process.argv.slice(2)

const commands = {
  help: async () => console.log(HELP),
  '--help': async () => console.log(HELP),
  '-h': async () => console.log(HELP),
  version: async () => console.log(VERSION),
  '--version': async () => console.log(VERSION),
  hub,
  join,
  invite,
  remove,
  start,
  status,
  doctor,
  update,
  profiles,
  use,
  token: async () => console.log(newToken()),
  tokens,
  approvals,
  permissions,
  approve,
  deny,
  audit,
  mcp,
}

try {
  if (!Object.hasOwn(commands, command)) throw new Error(`Unknown command "${cleanText(command)}". Run coop help.`)
  await commands[command](rest)
} catch (error) {
  // A route the hub has never heard of, rather than a thing it couldn't find.
  const hint = error.status === 404 && error.message === 'not found' ? ' This hub may be older than this coop: update the hub first.' : ''
  console.error(`coop: ${cleanText(error.message)}${hint}`)
  process.exitCode = 1
}

/** @returns {Record<string, any>} */
function options(args, spec, { positionals = 0 } = {}) {
  const { values, positionals: found } = parseArgs({ args, options: { profile: { type: 'string' }, ...spec }, allowPositionals: true })
  if (found.length > positionals) throw new Error(`Unexpected argument "${cleanText(found[positionals])}". Run coop help.`)
  return { ...values, _: found }
}

function wholeNumber(value, fallback, name) {
  if (value === undefined || value === '') return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a whole number, 0 or more.`)
  return number
}

async function hub(args) {
  const opts = options(args, {
    port: { type: 'string' },
    host: { type: 'string' },
    data: { type: 'string' },
    'lead-name': { type: 'string' },
    crew: { type: 'string' },
    'public-bind': { type: 'boolean' },
    'token-ttl-days': { type: 'string' },
    'retention-days': { type: 'string' },
    'rotate-lead-token': { type: 'boolean' },
    'reset-approval': { type: 'boolean' },
  })
  const { startNodeHub } = await import('../src/hub/node.js')
  const dataDir = opts.data ?? joinPath(config.coopHome(), 'hub')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const dbPath = joinPath(dataDir, 'hub.db')

  if (opts['reset-approval']) return resetApproval(dbPath)

  // Listening beyond this PC is a choice, and on a public address it's one to
  // make out loud: this server speaks plain http.
  const host = opts.host ?? '127.0.0.1'
  const reach = host === '0.0.0.0' || host === '::' ? 'everywhere' : hostKind(host)
  if ((reach === 'everywhere' || reach === 'public') && !opts['public-bind']) {
    throw new Error(`Refusing to listen on ${host}: that can expose this hub, in plain http, to every network this PC is on. Use your Tailscale address (coop hub --host <tailscale ip>), or keep it on 127.0.0.1 behind an https tunnel or reverse proxy. If you have a firewall or proxy in front and mean it, add --public-bind.`)
  }
  if (reach === 'everywhere' || reach === 'public' || reach === 'private') {
    console.error(`Warning: this hub speaks plain http on ${host}. Anyone who can see that network traffic can read tokens. See docs/self-hosting.md.`)
  }

  // Only a hash of the lead token stays here: the hub needs nothing more to
  // check it, so nothing in this folder can be used to sign in. A token from an
  // older version, kept in the clear, gets replaced by its hash on the way past.
  const hashFile = joinPath(dataDir, 'lead-token.sha256')
  const oldTokenFile = joinPath(dataDir, 'lead-token')
  const nameFile = joinPath(dataDir, 'lead-name')
  const leadToken = process.env.COOP_LEAD_TOKEN
  let leadTokenHash
  let shownToken = null
  if (!leadToken) {
    if (existsSync(oldTokenFile) && !existsSync(hashFile)) {
      config.writePrivate(hashFile, `${await sha256(readFileSync(oldTokenFile, 'utf8').trim())}\n`)
      console.log('The lead token file was replaced by a hash of the token. Your token still works, but this folder no longer holds a copy of it.')
    }
    if (existsSync(oldTokenFile)) rmSync(oldTokenFile)
    if (!opts['rotate-lead-token'] && existsSync(hashFile)) leadTokenHash = readFileSync(hashFile, 'utf8').trim()
    if (!leadTokenHash) {
      shownToken = newToken()
      leadTokenHash = await sha256(shownToken)
      config.writePrivate(hashFile, `${leadTokenHash}\n`)
    }
  } else if (opts['rotate-lead-token']) {
    throw new Error('COOP_LEAD_TOKEN is set, so the lead token comes from there: change it there instead.')
  }
  let leadName = opts['lead-name'] ?? process.env.COOP_LEAD_NAME
  if (leadName) config.writePrivate(nameFile, `${leadName}\n`)
  else leadName = existsSync(nameFile) ? readFileSync(nameFile, 'utf8').trim() : 'lead'

  const server = await startNodeHub({
    port: Number(opts.port ?? process.env.PORT ?? 8765),
    host,
    dbPath,
    leadToken,
    leadTokenHash: leadToken ? undefined : leadTokenHash,
    leadName,
    hubName: opts.crew ?? process.env.COOP_HUB_NAME ?? 'coop',
    maxWorkers: Number(process.env.COOP_MAX_WORKERS) || 8,
    tokenTtlDays: wholeNumber(opts['token-ttl-days'] ?? process.env.COOP_TOKEN_TTL_DAYS, 90, 'The token lifetime'),
    retentionDays: wholeNumber(opts['retention-days'] ?? process.env.COOP_RETENTION_DAYS, 90, 'The retention period'),
  })
  console.log(`claude-code-multi-pc hub ${VERSION} is running at ${server.url} (data in ${dataDir})`)
  console.log(`Lead: ${leadName}`)
  if (shownToken) {
    console.log(`\nNew lead token. It's shown only now and isn't saved anywhere, so keep it:\n  ${shownToken}`)
    console.log(`\nJoin as the lead from another terminal:\n  coop join --hub ${server.url}`)
  } else if (!leadToken) {
    console.log('Lost the lead token? coop hub --rotate-lead-token makes a new one.')
  }
  console.log('\nFriends on other PCs need a URL they can reach: see docs/self-hosting.md. Ctrl+C stops the hub.')
  const stop = async () => {
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

// For a forgotten passphrase. It takes access to the hub's own data, which is
// what a stolen lead token doesn't give you.
async function resetApproval(dbPath) {
  const { sqliteDatabase } = await import('../src/hub/sqlite.js')
  const { migrate } = await import('../src/hub/schema.js')
  if (!existsSync(dbPath)) throw new Error(`No hub database at ${dbPath}.`)
  const db = await sqliteDatabase(dbPath)
  await migrate(db)
  await db.run("DELETE FROM settings WHERE key IN ('approval_key_hash', 'approval_salt', 'approval_kdf', 'approval_set_at')")
  await db.run("INSERT INTO audit_log (ts, type, actor, result, detail) VALUES (?, 'security_config_changed', 'hub-operator', 'ok', ?)", [new Date().toISOString(), JSON.stringify({ setting: 'approval_passphrase', reset: true })])
  db.close()
  console.log('The approval passphrase is cleared. Set a new one: coop approvals setup')
}

async function join(args) {
  const opts = options(args, { hub: { type: 'string' }, token: { type: 'string' }, 'insecure-dev-mode': { type: 'boolean' } })
  if (!opts.hub) throw new Error('Usage: coop join --hub URL [--token TOKEN] [--profile NAME]')
  const allowInsecureHttp = Boolean(opts['insecure-dev-mode'])
  const { kind, plain } = parseHubUrl(opts.hub, { allowInsecure: allowInsecureHttp })
  if (plain && (kind === 'private' || kind === 'public')) {
    console.warn(`Warning: this hub is on plain http${kind === 'public' ? ' across the internet' : ''}, so the token travels unencrypted. Use https or a private network like Tailscale.`)
  }
  let token = opts.token
  if (!token) {
    const { promptHidden, requireTerminal } = await import('../src/approval.js')
    requireTerminal('Without --token, coop join')
    token = (await promptHidden('Token: ')).trim()
    if (!token) throw new Error('No token given.')
  }
  const client = hubClient({ hub: opts.hub, token, allowInsecureHttp })
  const me = await client.me()
  // These answers end up in Claude's instructions and on a command line, so a
  // strange hub doesn't get to choose what they say.
  if (!isMemberName(me.name) || !ROLES.includes(me.role) || !isMemberName(me.lead) || !isCrewName(me.hub)) {
    throw new Error("That hub's answer doesn't look right, so nothing was saved. Check the address.")
  }
  const name = opts.profile ?? config.profileSlug(me.hub)
  const saved = config.saveProfile(name, { hub: client.base, token, member: me.name, role: me.role, lead: me.lead, crew: me.hub, ...(allowInsecureHttp ? { allowInsecureHttp } : {}) })
  console.log(`Joined crew "${me.hub}" as ${me.name} (${me.role}). Saved as profile "${name}"${saved.default === name ? ' (your default)' : ''}.`)
  if (me.role === 'lead') {
    console.log('\nNext:\n  coop approvals setup    so that only you, not your Claude, can approve things\n  coop invite <name>      for each friend whose Claude should join\n  coop start              in your project folder, to start your lead Claude')
  } else if (me.role === 'worker') {
    console.log(`\nNext, in your copy of the project (a git clone you can push branches from):\n  coop start\n\nYour Claude takes tasks from ${me.lead}. Leave the window open (minimized is fine).`)
  } else {
    console.log('\nYou can read the crew board with coop status.')
  }
}

// When a passphrase is set, granting something takes the person who knows it.
async function approvalIfNeeded(client, what) {
  const { deriveApprovalKey, promptHidden, requireTerminal } = await import('../src/approval.js')
  let state
  try {
    state = await client.approvalStatus()
  } catch (error) {
    if (error.status === 404) return {}
    throw error
  }
  if (!state.configured) return {}
  requireTerminal(what)
  const passphrase = await promptHidden('Approval passphrase: ')
  return { approval_key: await deriveApprovalKey(passphrase, state.salt, state.kdf) }
}

async function invite(args) {
  const opts = options(args, { observer: { type: 'boolean' }, device: { type: 'string' } }, { positionals: 1 })
  const name = opts._[0]
  if (!name) throw new Error('Usage: coop invite NAME [--observer] [--device LABEL]')
  const profile = config.getProfile(opts.profile)
  const client = hubClient(profile)
  const approval = await approvalIfNeeded(client, 'Inviting someone')
  if (!approval.approval_key) console.warn('Note: no approval passphrase is set, so anything with your lead token can invite people. Run coop approvals setup.')
  const result = await client.invite(name, { ...approval, ...(opts.observer ? { role: 'observer' } : {}), ...(opts.device ? { device: opts.device } : {}) })
  console.log(opts.device ? `A new token for ${result.name}'s ${cleanText(opts.device)}.\n` : result.rotated ? `New token for ${result.name}; the old one stopped working.\n` : `Invited ${result.name}.\n`)
  if (result.expires_at) console.log(`It expires on ${result.expires_at.slice(0, 10)}. They can renew it before then with coop tokens rotate.\n`)
  console.log('Send them this privately (the token works like a password):\n')
  console.log(inviteText({ hub: profile.hub, name: result.name, token: result.token, crew: profile.crew }))
}

async function remove(args) {
  const opts = options(args, {}, { positionals: 1 })
  if (!opts._[0]) throw new Error('Usage: coop remove NAME')
  const result = await hubClient(config.getProfile(opts.profile)).remove(opts._[0])
  console.log(`Removed ${result.removed}.${result.released.length ? ` Back in the pool: ${result.released.map((id) => `#${id}`).join(', ')}.` : ''}`)
}

async function status(args) {
  const opts = options(args, {})
  console.log(formatBoard(await hubClient(config.getProfile(opts.profile)).board()))
}

async function tokens(args) {
  const opts = options(args, { member: { type: 'string' } }, { positionals: 2 })
  const [action, id] = opts._
  const profile = config.getProfile(opts.profile)
  const client = hubClient(profile)
  if (action === 'rotate') {
    const { token, id: newId, expires_at: expires } = await client.rotateToken()
    const { name, ...saved } = profile
    try {
      config.saveProfile(name, { ...saved, token })
    } catch (error) {
      console.error(`The hub replaced your token, but it couldn't be saved (${error.message}). Your new token is:\n  ${token}`)
      process.exitCode = 1
      return
    }
    console.log(`Token replaced and saved (${newId}${expires ? `, expires ${expires.slice(0, 10)}` : ''}). The old one has stopped working. Restart any open coop session on this PC.`)
    return
  }
  if (action === 'revoke') {
    if (!id) throw new Error('Usage: coop tokens revoke ID (coop tokens lists the ids)')
    const result = await client.revokeToken(id)
    console.log(`Revoked ${result.revoked} (${result.member}). It has stopped working.`)
    return
  }
  if (action === 'revoke-all') {
    const result = await client.revokeAllTokens(opts.member)
    console.log(`Revoked ${result.revoked} token(s) of ${result.member}. They have stopped working.`)
    return
  }
  if (action) throw new Error(`Unknown action "${cleanText(action)}". Use rotate, revoke or revoke-all.`)
  const { tokens: list } = await client.tokens(opts.member)
  for (const t of list) {
    const state = t.revoked_at ? 'revoked' : t.expires_at && Date.parse(t.expires_at) <= Date.now() ? 'expired' : t.expires_at ? `expires ${t.expires_at.slice(0, 10)}` : 'no expiry'
    console.log(cleanText(`${t.current ? '*' : ' '} ${t.id}  ${t.member.padEnd(12)} ${(t.label || '-').padEnd(12)} ${state.padEnd(19)} last used ${ago(t.last_used_at)}`))
  }
}

async function approvals(args) {
  const opts = options(args, {}, { positionals: 1 })
  const client = hubClient(config.getProfile(opts.profile))
  const state = await client.approvalStatus()
  if (opts._[0] === undefined || opts._[0] === 'status') {
    console.log(state.configured ? `An approval passphrase is set (since ${state.set_at}).` : 'No approval passphrase is set, so permission requests can only be refused. Run coop approvals setup.')
    return
  }
  if (opts._[0] !== 'setup') throw new Error('Usage: coop approvals [status|setup]')
  const { KDF, MIN_PASSPHRASE, deriveApprovalKey, newSalt, promptHidden, requireTerminal } = await import('../src/approval.js')
  requireTerminal('Setting the approval passphrase')
  console.log('Choose a passphrase only you know. It proves a person approved something, so don\'t save it on this PC, and never tell it to a Claude.')
  const body = {}
  if (state.configured) body.previous_key = await deriveApprovalKey(await promptHidden('Current passphrase: '), state.salt, state.kdf)
  const passphrase = await promptHidden(`New passphrase (at least ${MIN_PASSPHRASE} characters): `)
  if ([...passphrase].length < MIN_PASSPHRASE) throw new Error(`That's too short: use at least ${MIN_PASSPHRASE} characters.`)
  if (passphrase !== (await promptHidden('Once more: '))) throw new Error("Those didn't match.")
  const salt = newSalt()
  await client.approvalSetup({ ...body, key: await deriveApprovalKey(passphrase, salt), salt, kdf: KDF })
  console.log('Set. You can now approve with coop approve WORKER ID. Forgot it? Whoever runs the hub can clear it: see docs/security.md.')
}

async function permissions(args) {
  const opts = options(args, { status: { type: 'string' } })
  const statuses = ['pending', 'allowed', 'denied', 'expired']
  if (opts.status && !statuses.includes(opts.status)) throw new Error(`Unknown status "${cleanText(opts.status)}". Use one of: ${statuses.join(', ')}`)
  const { requests } = await hubClient(config.getProfile(opts.profile)).permissions(opts.status ?? 'pending')
  if (!requests.length) {
    console.log(opts.status ? `No ${cleanText(opts.status)} requests.` : 'No open permission requests. coop permissions --status expired shows the ones nobody answered in time.')
    return
  }
  for (const request of requests) console.log(`${describeRequest(request)}\n`)
  if ((opts.status ?? 'pending') === 'pending') console.log("Open means no answer has come through the hub. The person at that PC, or Claude Code's own check in auto mode, may already have answered it, and the command may already have run.")
}

function describeRequest(r) {
  return cleanText(
    [
      `${r.worker} ${r.request_id}  [${r.risk} risk label]  ${r.status}${r.status === 'pending' ? `, answer before ${r.expires_at.slice(11, 19)} UTC` : ''}`,
      `  Tool:   ${r.tool_name}`,
      `  What:   ${r.description}`,
      r.input_preview && `  Input:  ${r.input_preview}`,
      r.cwd && `  Folder: ${r.cwd}`,
      r.task_id && `  Task:   #${r.task_id}`,
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

async function approve(args) {
  const opts = options(args, {}, { positionals: 2 })
  const [worker, id] = opts._
  if (!worker || !id) throw new Error('Usage: coop approve WORKER ID (coop permissions lists them)')
  const { deriveApprovalKey, promptHidden, requireTerminal } = await import('../src/approval.js')
  requireTerminal('Approving a permission request')
  const client = hubClient(config.getProfile(opts.profile))
  const state = await client.approvalStatus()
  if (!state.configured) throw new Error('Set an approval passphrase first: coop approvals setup')
  const { requests } = await client.permissions('pending')
  const request = requests.find((r) => r.worker === worker && r.request_id === id)
  if (!request) throw new Error(`No open request ${cleanText(id)} from ${cleanText(worker)}: it may have expired or been answered. coop permissions lists the open ones.`)
  console.log(`\nIf this is still waiting, it runs on ${cleanText(worker)}'s PC when you approve it. It may already have been answered there, or by auto mode. The text comes from that PC, so judge what it would do, not what it says:\n\n${describeRequest(request)}\n`)
  const passphrase = await promptHidden('Passphrase to approve (Ctrl+C to cancel): ')
  await client.permissionVerdict({ worker, request_id: id, behavior: 'allow', approval_key: await deriveApprovalKey(passphrase, state.salt, state.kdf) })
  console.log(`Approved. ${cleanText(worker)}'s Claude has been told.`)
}

async function deny(args) {
  const opts = options(args, {}, { positionals: 2 })
  const [worker, id] = opts._
  if (!worker || !id) throw new Error('Usage: coop deny WORKER ID')
  await hubClient(config.getProfile(opts.profile)).permissionVerdict({ worker, request_id: id, behavior: 'deny' })
  console.log('Refused.')
}

async function audit(args) {
  const opts = options(args, { type: { type: 'string' }, limit: { type: 'string' }, alerts: { type: 'boolean' }, local: { type: 'boolean' } })
  if (opts.local) return guardLog(wholeNumber(opts.limit, 50, '--limit'))
  const type = opts.alerts ? 'security_alert' : opts.type
  const { entries } = await hubClient(config.getProfile(opts.profile)).audit({ type, limit: wholeNumber(opts.limit, 50, '--limit') })
  if (!entries.length) {
    console.log('Nothing logged.')
    return
  }
  for (const e of entries.reverse()) {
    console.log(cleanText(`${e.ts}  ${e.type.padEnd(24)} ${(e.result ?? '').padEnd(7)} ${e.actor ?? '-'}${e.target ? ` -> ${e.target}` : ''}  ${JSON.stringify(e.detail)}  source=${e.source ?? '-'}  req=${e.request_id ?? '-'}`))
  }
}

// The hub never hears about these: they stay on the PC they happened on.
function guardLog(limit) {
  let lines = []
  try {
    lines = readFileSync(config.guardLogPath(), 'utf8').split('\n').filter(Boolean)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!lines.length) {
    console.log("coop's guard hasn't blocked anything on this PC.")
    return
  }
  for (const line of limit ? lines.slice(-limit) : lines) {
    try {
      const { ts, check, role, reason } = JSON.parse(line)
      console.log(cleanText(`${ts}  ${check} (${role})  ${reason}`))
    } catch {}
  }
}

async function start(args) {
  const split = args.indexOf('--')
  const own = split === -1 ? args : args.slice(0, split)
  const extraArgs = split === -1 ? [] : args.slice(split + 1)
  const opts = options(own, {
    new: { type: 'boolean' },
    'permission-mode': { type: 'string' },
    worktree: { type: 'boolean' },
    'no-relay': { type: 'boolean' },
    sandbox: { type: 'boolean' },
    'insecure-dev-mode': { type: 'boolean' },
    prompt: { type: 'string' },
    claude: { type: 'string' },
    'dry-run': { type: 'boolean' },
  })
  const { startClaude, commandLine } = await import('../src/launch.js')
  const profile = config.getProfile(opts.profile)
  const result = await startClaude(profile, {
    fresh: opts.new,
    permissionMode: opts['permission-mode'],
    worktree: opts.worktree,
    relay: !opts['no-relay'],
    sandbox: opts.sandbox,
    insecureDevMode: opts['insecure-dev-mode'],
    prompt: opts.prompt,
    claudeBin: opts.claude,
    extraArgs,
    dryRun: opts['dry-run'],
  })
  if (opts['dry-run']) {
    console.log(commandLine(result.bin, result.args))
    return
  }
  process.exitCode = result
}

async function doctor(args) {
  const opts = options(args, {})
  const { findClaude, claudeVersion, hasStrictHooks } = await import('../src/launch.js')
  const { prePushStatus } = await import('../src/guard.js')
  const { spawnSync } = await import('node:child_process')
  let problems = 0
  const check = (ok, text, hint) => {
    console.log(`${ok ? '✓' : '✗'} ${text}${!ok && hint ? `\n    ${hint}` : ''}`)
    if (!ok) problems++
  }
  const notice = (text, hint) => console.log(`! ${text}${hint ? `\n    ${hint}` : ''}`)

  const [major, minor] = process.versions.node.split('.').map(Number)
  check(major > 22 || (major === 22 && minor >= 13), `Node.js ${process.versions.node}`, 'claude-code-multi-pc needs Node.js 22.13 or newer.')

  const bin = findClaude()
  const version = bin && claudeVersion(bin)
  check(Boolean(version), version ? `Claude Code ${version} (${bin})` : 'Claude Code', 'Install Claude Code, or set CLAUDE_BIN to its path: https://code.claude.com/docs/en/quickstart')
  if (version && !hasStrictHooks(version)) notice('This Claude Code is older than 2.1.295: a guard check that times out lets the tool call through.', 'Run claude update.')

  let profile
  try {
    profile = config.getProfile(opts.profile)
    check(true, `Profile "${profile.name}": ${profile.member} (${profile.role}) in crew "${profile.crew}"`)
  } catch (error) {
    check(false, 'Crew profile', error.message)
  }
  if (config.isExposedFile(joinPath(config.coopHome(), 'config.json'))) {
    check(false, 'Your token file is readable by others on this PC', `Fix it with: chmod 600 ${joinPath(config.coopHome(), 'config.json')}`)
  }
  if (profile) {
    try {
      const client = hubClient(profile)
      const me = await client.me()
      check(me.name === profile.member, `Hub ${profile.hub} knows you as ${me.name} (${me.role})`, 'Your profile is out of date: run coop join again.')
      const expires = Date.parse(me.token?.expires_at)
      if (expires) {
        const days = Math.ceil((expires - Date.now()) / 86_400_000)
        if (days < 14) notice(`Your token expires in ${days} day(s).`, 'Run coop tokens rotate.')
        else check(true, `Your token expires in ${days} days`)
      } else if (me.token) notice('Your token never expires.', 'Replace it with one that does: coop tokens rotate (the lead token is changed on the hub).')
      if (me.role === 'lead') {
        const state = await client.approvalStatus().catch(() => null)
        if (state) check(state.configured, 'An approval passphrase is set', "Run coop approvals setup. Until then permission requests can only be refused, and anything with your lead token can invite people.")
      }
    } catch (error) {
      check(false, `Hub ${profile.hub}`, error.message)
    }
  }

  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  check(git.status === 0, git.status === 0 ? `Git repository: ${git.stdout.trim()}` : 'This folder is a git repository', 'Run coop start inside your clone of the project.')
  const gh = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' })
  check(gh.status === 0, 'GitHub CLI signed in (for pull requests)', 'Optional: install gh and run gh auth login, so your Claude can open pull requests.')
  if (git.status === 0) {
    if (profile?.role === 'worker') {
      const guard = prePushStatus(process.cwd())
      if (guard === 'present') check(true, "coop's pre-push check is installed")
      else if (guard === 'missing') notice("coop's pre-push check isn't installed yet.", 'coop start installs it.')
      else notice("coop can't install its pre-push check here, because this repository already manages its hooks.", 'Rely on branch protection on your git host.')
    }
    if (gh.status === 0) {
      const repo = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef', '--jq', '.nameWithOwner + " " + .defaultBranchRef.name'], { encoding: 'utf8' })
      const [slug, branch] = repo.status === 0 ? repo.stdout.trim().split(' ') : []
      if (slug && branch) {
        const rule = spawnSync('gh', ['api', `repos/${slug}/branches/${branch}/protection`, '--silent'], { encoding: 'utf8' })
        if (rule.status === 0) check(true, `${branch} is protected on GitHub`)
        else notice(`Can't confirm that ${branch} is protected on GitHub.`, 'Branch protection is the only limit a compromised PC can\'t get around: see docs/project-setup.md. (Checking it needs admin rights on the repository.)')
      }
    }
  }

  console.log(problems ? `\n${problems} thing(s) to fix.` : '\nAll good.')
  if (problems) process.exitCode = 1
}

async function update(args) {
  const opts = options(args, { check: { type: 'boolean' } })
  const latest = await latestVersion()
  if (compareVersions(latest, VERSION) <= 0) {
    console.log(`coop ${VERSION} is up to date.`)
    return
  }
  if (opts.check) {
    console.log(`coop ${latest} is out (you have ${VERSION}). Run coop update to install it.`)
    return
  }
  // A git clone (installed with npm link or npm install -g <folder>) is
  // someone's working copy: leave it to git rather than reinstalling over it.
  const root = fileURLToPath(new URL('..', import.meta.url))
  if (existsSync(joinPath(root, '.git'))) {
    console.log(`coop ${latest} is out (you have ${VERSION}). This coop runs from the git clone in ${root}: update it there with git pull.`)
    return
  }
  console.log(`Updating coop ${VERSION} to ${latest}: ${INSTALL_COMMAND}`)
  const { spawnSync } = await import('node:child_process')
  // A fixed command, with nothing from the network in it. npm is a .cmd file on Windows, which takes a shell.
  if (spawnSync(INSTALL_COMMAND, { stdio: 'inherit', shell: true }).status !== 0) throw new Error(`the update failed. Try it yourself: ${INSTALL_COMMAND}`)
  console.log(`\nUpdated to ${latest}. Restart open coop sessions (close the window, then coop start) to use it; that starts a new session.`)
}

// The version on GitHub's main branch. COOP_UPDATE_URL points elsewhere in tests.
async function latestVersion() {
  const url = process.env.COOP_UPDATE_URL ?? `https://raw.githubusercontent.com/${REPO}/main/package.json`
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    throw new Error(`can't check for updates (${error.cause?.code ?? error.cause?.message ?? error.message})`, { cause: error })
  }
  if (!response.ok) throw new Error(`can't check for updates (GitHub answered HTTP ${response.status})`)
  const { version } = await response.json().catch(() => ({}))
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/.test(version)) throw new Error("can't check for updates (no version found)")
  return version
}

function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split(/[.-]/).slice(0, 3).map(Number))
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

async function profiles() {
  const { profiles: all, default: preferred } = config.loadConfig()
  const names = Object.keys(all)
  if (!names.length) {
    console.log(`No crews yet. Install: ${INSTALL_COMMAND}\nThen: coop join --hub URL --token TOKEN`)
    return
  }
  for (const name of names) {
    const p = all[name]
    console.log(cleanText(`${name === preferred ? '*' : ' '} ${name}: ${p.member} (${p.role}) in "${p.crew}" at ${p.hub}`))
  }
}

async function use(args) {
  const opts = options(args, {}, { positionals: 1 })
  if (!opts._[0]) throw new Error('Usage: coop use PROFILE')
  config.setDefaultProfile(opts._[0])
  console.log(`Default crew profile: ${opts._[0]}`)
}

async function mcp(args) {
  const opts = options(args, {})
  const { runMcpServer } = await import('../src/mcp/server.js')
  await runMcpServer({ profileName: opts.profile })
}
