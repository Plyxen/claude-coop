#!/usr/bin/env node
// claude-code-multi-pc command line. `coop help` lists the commands.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// node:sqlite prints an ExperimentalWarning on import; keep the CLI quiet.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') console.error(warning)
})

const { HubClient } = await import('../src/client.js')
const config = await import('../src/config.js')
const { formatBoard } = await import('../src/format.js')
const { VERSION, newToken } = await import('../src/hub/app.js')
const { INSTALL_COMMAND, REPO, inviteText } = await import('../src/meta.js')

// CLI commands are one-off, so they don't count as being online.
const hubClient = (profile) => new HubClient({ ...profile, presence: false })

const HELP = `claude-code-multi-pc ${VERSION}: one lead Claude, a crew of worker Claudes on other PCs.

Lead
  coop hub [--port 8765] [--host 127.0.0.1] [--data DIR] [--lead-name NAME] [--crew NAME]
                                  Run a self-hosted hub (or deploy one to Cloudflare: see docs)
  coop invite NAME                Invite a friend's Claude as a worker; prints what to send them
  coop remove NAME                Remove a worker; their unfinished tasks go back to the pool

Everyone
  coop join --hub URL --token TOKEN [--profile NAME]
                                  Save a crew profile on this PC (tokens stay in ~/.claude-coop)
  coop start [--new] [--permission-mode MODE] [--worktree] [--no-relay] [--prompt TEXT] [--dry-run] [-- CLAUDE ARGS]
                                  Start Claude Code in this folder, connected to the crew. Reopens
                                  your last coop session here; --new starts a fresh one
  coop status                     Show the crew board
  coop doctor                     Check this PC's setup
  coop update [--check]           Update coop to the latest version (--check: only look)
  coop profiles                   List your crew profiles
  coop use PROFILE                Make a profile the default

Other
  coop token                      Print a new random lead token
  coop mcp                        Run the MCP server (coop start does this for you)

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
  mcp,
}

try {
  if (!Object.hasOwn(commands, command)) throw new Error(`Unknown command "${command}". Run coop help.`)
  await commands[command](rest)
} catch (error) {
  console.error(`coop: ${error.message}`)
  process.exitCode = 1
}

function options(args, spec, { positionals = 0 } = {}) {
  const { values, positionals: found } = parseArgs({ args, options: { profile: { type: 'string' }, ...spec }, allowPositionals: true })
  if (found.length > positionals) throw new Error(`Unexpected argument "${found[positionals]}". Run coop help.`)
  return { ...values, _: found }
}

async function hub(args) {
  const opts = options(args, {
    port: { type: 'string' },
    host: { type: 'string' },
    data: { type: 'string' },
    'lead-name': { type: 'string' },
    crew: { type: 'string' },
  })
  const { startNodeHub } = await import('../src/hub/node.js')
  const dataDir = opts.data ?? joinPath(config.coopHome(), 'hub')
  mkdirSync(dataDir, { recursive: true })

  // The lead token and name are created once and kept in the data folder.
  const tokenFile = joinPath(dataDir, 'lead-token')
  const nameFile = joinPath(dataDir, 'lead-name')
  let leadToken = process.env.COOP_LEAD_TOKEN
  let newLeadToken = false
  if (!leadToken && existsSync(tokenFile)) leadToken = readFileSync(tokenFile, 'utf8').trim()
  if (!leadToken) {
    leadToken = newToken()
    newLeadToken = true
    config.writePrivate(tokenFile, `${leadToken}\n`)
  }
  let leadName = opts['lead-name'] ?? process.env.COOP_LEAD_NAME
  if (leadName) config.writePrivate(nameFile, `${leadName}\n`)
  else leadName = existsSync(nameFile) ? readFileSync(nameFile, 'utf8').trim() : 'lead'

  const server = await startNodeHub({
    port: Number(opts.port ?? process.env.PORT ?? 8765),
    host: opts.host ?? '127.0.0.1',
    dbPath: joinPath(dataDir, 'hub.db'),
    leadToken,
    leadName,
    hubName: opts.crew ?? process.env.COOP_HUB_NAME ?? 'coop',
    maxWorkers: Number(process.env.COOP_MAX_WORKERS) || 8,
  })
  console.log(`claude-code-multi-pc hub ${VERSION} is running at ${server.url} (data in ${dataDir})`)
  console.log(`Lead: ${leadName}`)
  if (newLeadToken) {
    console.log(`\nNew lead token (shown once, saved in ${tokenFile}):\n  ${leadToken}`)
    console.log(`\nJoin as the lead from another terminal:\n  coop join --hub ${server.url} --token ${leadToken}`)
  } else {
    console.log(`The lead token is in ${tokenFile}.`)
  }
  console.log('\nFriends on other PCs need a URL they can reach: see docs/self-hosting.md. Ctrl+C stops the hub.')
  const stop = async () => {
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function join(args) {
  const opts = options(args, { hub: { type: 'string' }, token: { type: 'string' } })
  if (!opts.hub || !opts.token) throw new Error('Usage: coop join --hub URL --token TOKEN [--profile NAME]')
  const url = new URL(opts.hub)
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !/^100\.|\.ts\.net$/.test(url.hostname)) {
    console.warn('Warning: this hub is not on https, so the token travels unencrypted. Use https outside your own PC or private network.')
  }
  const client = hubClient({ hub: opts.hub, token: opts.token })
  const me = await client.me()
  const name = opts.profile ?? config.profileSlug(me.hub)
  const saved = config.saveProfile(name, { hub: client.base, token: opts.token, member: me.name, role: me.role, lead: me.lead, crew: me.hub })
  console.log(`Joined crew "${me.hub}" as ${me.name} (${me.role}). Saved as profile "${name}"${saved.default === name ? ' (your default)' : ''}.`)
  if (me.role === 'lead') {
    console.log('\nNext:\n  coop invite <name>      for each friend whose Claude should join\n  coop start              in your project folder, to start your lead Claude')
  } else {
    console.log(`\nNext, in your copy of the project (a git clone you can push branches from):\n  coop start\n\nYour Claude takes tasks from ${me.lead}. Leave the window open (minimized is fine).`)
  }
}

async function invite(args) {
  const opts = options(args, {}, { positionals: 1 })
  const name = opts._[0]
  if (!name) throw new Error('Usage: coop invite NAME')
  const profile = config.getProfile(opts.profile)
  const result = await hubClient(profile).invite(name)
  console.log(result.rotated ? `New token for ${result.name}; the old one stopped working.\n` : `Invited ${result.name}.\n`)
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

async function start(args) {
  const split = args.indexOf('--')
  const own = split === -1 ? args : args.slice(0, split)
  const extraArgs = split === -1 ? [] : args.slice(split + 1)
  const opts = options(own, {
    new: { type: 'boolean' },
    'permission-mode': { type: 'string' },
    worktree: { type: 'boolean' },
    'no-relay': { type: 'boolean' },
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
  const { findClaude, claudeVersion } = await import('../src/launch.js')
  const { spawnSync } = await import('node:child_process')
  let problems = 0
  const check = (ok, text, hint) => {
    console.log(`${ok ? '✓' : '✗'} ${text}${!ok && hint ? `\n    ${hint}` : ''}`)
    if (!ok) problems++
  }

  const [major, minor] = process.versions.node.split('.').map(Number)
  check(major > 22 || (major === 22 && minor >= 13), `Node.js ${process.versions.node}`, 'claude-code-multi-pc needs Node.js 22.13 or newer.')

  const bin = findClaude()
  const version = bin && claudeVersion(bin)
  check(Boolean(version), version ? `Claude Code ${version} (${bin})` : 'Claude Code', 'Install Claude Code, or set CLAUDE_BIN to its path: https://code.claude.com/docs/en/quickstart')

  let profile
  try {
    profile = config.getProfile(opts.profile)
    check(true, `Profile "${profile.name}": ${profile.member} (${profile.role}) in crew "${profile.crew}"`)
  } catch (error) {
    check(false, 'Crew profile', error.message)
  }
  if (profile) {
    try {
      const me = await hubClient(profile).me()
      check(me.name === profile.member, `Hub ${profile.hub} knows you as ${me.name} (${me.role})`, 'Your profile is out of date: run coop join again.')
    } catch (error) {
      check(false, `Hub ${profile.hub}`, error.message)
    }
  }

  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  check(git.status === 0, git.status === 0 ? `Git repository: ${git.stdout.trim()}` : 'This folder is a git repository', 'Run coop start inside your clone of the project.')
  const gh = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' })
  check(gh.status === 0, 'GitHub CLI signed in (for pull requests)', 'Optional: install gh and run gh auth login, so your Claude can open pull requests.')

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
    throw new Error(`can't check for updates (${error.cause?.code ?? error.cause?.message ?? error.message})`)
  }
  if (!response.ok) throw new Error(`can't check for updates (GitHub answered HTTP ${response.status})`)
  const { version } = await response.json()
  if (!/^\d+\.\d+\.\d+/.test(version ?? '')) throw new Error("can't check for updates (no version found)")
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
    console.log(`${name === preferred ? '*' : ' '} ${name}: ${p.member} (${p.role}) in "${p.crew}" at ${p.hub}`)
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
