// `coop start`: launch Claude Code with the coop server loaded as a channel,
// so crew events reach the session while it sits idle.
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coopHome, writePrivate } from './config.js'
import { guardSettings, installPrePush } from './guard.js'
import { VERSION } from './hub/app.js'
import { WORKER_START_PROMPT, leadSystemPrompt, workerSystemPrompt } from './mcp/instructions.js'

const COOP_BIN = fileURLToPath(new URL('../bin/coop.js', import.meta.url))
const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']
// Claude Code options that choose the session themselves.
const SESSION_FLAGS = ['--resume', '-r', '--continue', '-c', '--session-id', '--fork-session', '--from-pr', '--teleport']
// Claude Code options that turn off the checks a worker's owner relies on.
const UNSAFE_FLAGS = ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']
// `onFailure` and exec-form hooks: a hook that times out then blocks, and no shell quoting.
const STRICT_HOOKS_SINCE = [2, 1, 295]

export function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (dir && existsSync(candidate)) return candidate
    }
  }
  const native = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  return existsSync(native) ? native : null
}

export function claudeVersion(bin) {
  const result = runClaude(bin, ['--version'], { sync: true })
  return result.status === 0 ? String(result.stdout).trim() : null
}

export function hasStrictHooks(version) {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')
  if (!found) return false
  const parts = found.slice(1).map(Number)
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== STRICT_HOOKS_SINCE[i]) return parts[i] > STRICT_HOOKS_SINCE[i]
  }
  return true
}

// Refuses what would turn off the safety checks, unless the person asked for
// exactly that by name. Never reachable from a task or a message: only from
// someone typing this flag on their own PC.
function checkLaunchSafety(mode, extraArgs, insecureDevMode) {
  if (insecureDevMode) return
  if (mode === 'bypassPermissions') {
    throw new Error('Refusing permission mode bypassPermissions: it removes every check, while tasks come from someone else. Use it only in a throwaway VM, and only with --insecure-dev-mode.')
  }
  for (let i = 0; i < extraArgs.length; i++) {
    const [flag, value] = extraArgs[i].split('=')
    const next = value ?? extraArgs[i + 1]
    if (UNSAFE_FLAGS.includes(flag) || (flag === '--permission-mode' && next === 'bypassPermissions')) {
      throw new Error(`Refusing ${extraArgs[i]}: it removes every check, while tasks come from someone else. Use it only in a throwaway VM, and only with --insecure-dev-mode.`)
    }
  }
}

// Build the claude command line for a profile. Option order matters: the
// list-valued options (--mcp-config, --dangerously-load-development-channels)
// are followed by another option, so the start prompt stays positional.
/**
 * @param {any} profile
 * @param {Record<string, any>} [options]
 */
export function buildClaudeArgs(
  profile,
  { permissionMode, worktree = false, relay = true, prompt, session = null, extraArgs = [], insecureDevMode = false, sandbox = false, strictHooks = false } = {},
) {
  if (profile.role === 'observer') throw new Error("Observers read the board with coop status: they don't run a Claude session.")
  if (sandbox && process.platform === 'win32') {
    throw new Error("Claude Code's sandbox isn't available on native Windows, and it would silently run without one. Run coop inside WSL2, or a VM, if you need OS-level isolation.")
  }
  const mcpConfigPath = join(coopHome(), 'run', `${profile.name}.mcp.json`)
  const settingsPath = join(coopHome(), 'run', `${profile.name}.settings.json`)
  /** @type {Record<string, string>} */
  const env = { COOP_LAUNCHED: '1', ...(relay ? {} : { COOP_RELAY_PERMISSIONS: '0' }) }
  if (process.env.COOP_HOME) env.COOP_HOME = process.env.COOP_HOME
  const mcpConfig = {
    mcpServers: {
      coop: { command: process.execPath, args: [COOP_BIN, 'mcp', '--profile', profile.name], env },
    },
  }
  const isWorker = profile.role === 'worker'
  const mode = permissionMode ?? (isWorker ? profile.permissionMode ?? 'auto' : null)
  if (mode && !PERMISSION_MODES.includes(mode)) throw new Error(`Unknown permission mode "${mode}". Use one of: ${PERMISSION_MODES.join(', ')}`)
  checkLaunchSafety(mode, extraArgs, insecureDevMode)
  const settings = insecureDevMode
    ? null
    : guardSettings({
        role: profile.role,
        nodePath: process.execPath,
        coopBin: COOP_BIN,
        profile: profile.name,
        hookFields: { execForm: strictHooks, blockOnFailure: strictHooks },
        sandbox,
      })

  const args = [
    '--mcp-config',
    mcpConfigPath,
    '--dangerously-load-development-channels',
    'server:coop',
    '--name',
    `coop ${profile.role} ${profile.member}`,
  ]
  if (settings) args.push('--settings', settingsPath)
  if (session) args.push(session.resume ? '--resume' : '--session-id', session.id)
  if (mode) args.push('--permission-mode', mode)
  if (worktree) args.push('--worktree', `coop-${profile.member}`)
  args.push('--append-system-prompt', isWorker ? workerSystemPrompt(profile) : leadSystemPrompt(profile))
  args.push(...extraArgs)
  const startPrompt = prompt ?? (isWorker ? WORKER_START_PROMPT : null)
  if (startPrompt) args.push(startPrompt)
  return { args, mcpConfigPath, mcpConfig, settingsPath, settings }
}

export function startClaude(profile, options = {}) {
  const bin = options.claudeBin ?? findClaude()
  if (!bin) {
    throw new Error('Claude Code (the `claude` command) was not found. Install it (https://code.claude.com/docs/en/quickstart), or point CLAUDE_BIN at it.')
  }
  const session = pickSession(profile, options)
  if (session?.note) console.log(session.note)
  const strictHooks = options.dryRun ? false : hasStrictHooks(claudeVersion(bin))
  const { args, mcpConfigPath, mcpConfig, settingsPath, settings } = buildClaudeArgs(profile, { ...options, session, strictHooks })
  if (options.dryRun) return { bin, args }
  writePrivate(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`)
  if (settings) writePrivate(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
  if (options.insecureDevMode) {
    console.error('\n  INSECURE DEV MODE: coop\'s guards are off. Use this only in a throwaway VM.\n')
  } else {
    if (!strictHooks) console.error('Note: this Claude Code is older than 2.1.295, so a guard check that times out lets the tool call through. Run claude update.')
    if (profile.role === 'worker') reportPrePush(installPrePush({ cwd: process.cwd(), nodePath: process.execPath, coopBin: COOP_BIN }))
  }
  const record = session && { id: session.id, cwd: process.cwd(), version: VERSION }
  if (record) writePrivate(sessionFile(profile), `${JSON.stringify({ ...record, pid: process.pid })}\n`)
  const child = runClaude(bin, args)
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      if (record) writePrivate(sessionFile(profile), `${JSON.stringify(record)}\n`)
      resolve(code ?? 0)
    })
    child.on('error', (error) => {
      console.error(`Couldn't start ${bin}: ${error.message}`)
      resolve(1)
    })
  })
}

function reportPrePush(result) {
  if (result.status === 'installed') console.log(`Added a git pre-push check for protected branches and secrets: ${result.file}`)
  if (result.status === 'foreign-hook') console.error(`Warning: ${result.file} already exists and isn't coop's, so pushes aren't checked by coop here. Rely on branch protection on your git host.`)
  if (result.status === 'custom-hooks-path') console.error("Warning: this repository uses core.hooksPath, so coop's pre-push check isn't installed. Rely on branch protection on your git host.")
}

// One Claude Code session per crew and folder: `coop start` reopens it
// instead of adding another session every time. A new coop version gets a new
// session, because a resumed session keeps the system prompt (and so the coop
// instructions) it started with.
export function pickSession(profile, { fresh = false, worktree = false, extraArgs = [] } = {}) {
  if (worktree || extraArgs.some((arg) => SESSION_FLAGS.includes(arg.split('=')[0]))) return null
  const last = readJson(sessionFile(profile))
  const fits = last && last.cwd === process.cwd() && last.version === VERSION && transcriptExists(last.id)
  if (fresh || !fits) return { id: randomUUID(), resume: false }
  if (last.pid && last.pid !== process.pid && isRunning(last.pid)) {
    return { id: randomUUID(), resume: false, note: 'Your last coop session for this crew still looks open in another window, so this starts a new one.' }
  }
  return { id: last.id, resume: true }
}

function sessionFile(profile) {
  return join(coopHome(), 'run', `${profile.name}.session.json`)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Claude Code keeps each conversation in <config dir>/projects/<folder>/<id>.jsonl.
function transcriptExists(id) {
  if (!/^[0-9a-f-]{36}$/.test(id ?? '')) return false
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  try {
    return readdirSync(projects).some((dir) => existsSync(join(projects, dir, `${id}.jsonl`)))
  } catch {
    return false
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// Quotes an argument for cmd.exe, which ends a command at a line break even
// inside quotes, expands %VAR% everywhere, and lets a backslash before the
// closing quote escape it for the program being started.
export function quoteForCmd(arg) {
  const safe = String(arg).replace(/[\r\n]+/g, ' ').replace(/"/g, "'").replace(/%/g, ' percent').replace(/\\+$/, (slashes) => slashes + slashes)
  return `"${safe}"`
}

// .cmd and .bat files (npm-installed claude on Windows) only run through the
// shell, so their arguments are quoted for cmd.exe.
/** @returns {any} */
function runClaude(bin, args, { sync = false } = {}) {
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
  const run = /** @type {any} */ (sync ? spawnSync : spawn)
  const options = sync ? { encoding: 'utf8' } : { stdio: 'inherit' }
  if (!viaShell) return run(bin, args, options)
  return run([bin, ...args].map(quoteForCmd).join(' '), { ...options, shell: true })
}

export function commandLine(bin, args) {
  return [bin, ...args].map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')
}
