// Runtime guards for `coop start`. Two places enforce rules here, outside of
// what Claude decides to do:
//  - a Claude Code PreToolUse hook (`coop guard tool`), which Claude Code runs
//    before each tool call and which can block it
//  - a git pre-push hook (`coop guard pre-push`), which git runs on a push
// They stop mistakes and common prompt-injection payloads. They aren't a sandbox:
// a shell can always be made to do something no pattern expects. Only the OS, a
// sandbox or your git host can enforce a hard limit. See docs/security-guarantees.md.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pathProblem } from './paths.js'
import { findSecrets } from './secrets.js'
import { isProtectedBranch } from './validate.js'

const HOOK_MARKER = '# coop-guard'
const ZERO_SHA = /^0+$/
const MAX_SCAN = 32 * 1024 * 1024

// Credentials on this PC: not for either kind of Claude. Paths are written the
// way both a shell and Claude Code's rules see them.
const SECRET_PLACES = [
  /\.claude-coop\b/,
  /\.ssh\b/,
  /\.aws\b/,
  /\.gnupg\b/,
  /\.netrc\b/,
  /\.npmrc\b/,
  /\.git-credentials\b/,
  /\.config[\\/]gh\b/,
  /\.docker[\\/]config\.json/,
  /\.kube[\\/]config/,
  /\.claude[\\/]\.credentials\.json/,
  /\.claude\.json\b/,
  /\bid_(?:rsa|ed25519|ecdsa|dsa)\b/,
  /appdata[\\/]roaming[\\/](?:github cli|npm[\\/]etc)/,
]
// Files that decide what runs next, or what gets checked. A worker's file tools
// stay off them even inside the project.
const CONTROL_FILES = /(?:^|[\\/])(?:\.git(?:[\\/]|$)|\.mcp\.json$|\.claude[\\/](?:settings(?:\.local)?\.json$|hooks(?:[\\/]|$)))/i
/** @type {[RegExp, string][]} */
const SECRET_COMMANDS = [
  [/--dangerously-skip-permissions\b|--allow-dangerously-skip-permissions\b|--insecure-dev-mode\b|--permission-mode[\s=]+bypasspermissions\b/, 'starts something with its safety checks off'],
  [/--reset-approval\b/, 'clears the approval passphrase: that is for a person'],
  [/\bgit\s+credential\b/, 'reads git credentials'],
  [/\bgh\s+auth\s+(?:token|status\s+.*--show-token|refresh|login|logout)\b/, 'touches GitHub credentials'],
  [/\bcmdkey\b|\bsecurity\s+find-(?:generic|internet)-password\b|\bsecret-tool\b/, "reads this PC's credential store"],
]

// Command shapes workers never run. The real limits are the project's branch
// protection and the worker's permission mode: these catch the common cases.
/** @type {[RegExp, string][]} */
const WORKER_COMMANDS = [
  [/\bgit\b[^\n;&|]*\s-c\s+core\.hookspath\b/, 'turns off git hooks'],
  [/\bgit\s+config\b[^\n;&|]*\bcore\.hookspath\b/, 'changes where git hooks live'],
  [/\bgit\s+(?:\S+\s+)*push\b[^\n;&|]*--no-verify\b/, "skips coop's pre-push check"],
  [/\bgit\s+(?:\S+\s+)*push\b[^\n;&|]*\s(?:--force(?!-with-lease)\b|-f\b|--mirror\b|--delete\b|-d\b|--tags\b|--all\b)/, 'is a destructive or bulk push'],
  [/\.git[\\/]hooks\b/, 'touches git hooks'],
  [/\.claude[\\/](?:settings|hooks)|>\s*\S*\.mcp\.json\b/, "changes Claude Code's settings or hooks"],
  [/\bgh\s+pr\s+merge\b|\bgh\s+pr\s+review\s+[^\n;&|]*--approve\b/, 'merges or approves a pull request: that is for the lead'],
  [/\bgh\s+release\b|\bgh\s+secret\b|\bgh\s+variable\b|\bgh\s+repo\s+(?:delete|edit|rename|archive)\b|\bgh\s+workflow\s+run\b|\bgh\s+api\b[^\n;&|]*(?:-x|--method)\s*(?:put|post|patch|delete)\b/, 'changes GitHub settings, releases or secrets'],
  [/\b(?:npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b/, 'publishes a package'],
  [/\b(?:wrangler\s+(?:deploy|publish|secret|d1\s+(?:execute|delete))|vercel(?:\s|$)|netlify\s+deploy|flyctl\s|fly\s+deploy|kubectl\s|helm\s|terraform\s+(?:apply|destroy)|pulumi\s+up|aws\s|gcloud\s|az\s)/, 'deploys or touches cloud infrastructure'],
  [/\b(?:curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)\b[^\n;]*\|\s*(?:(?:ba|z|da|k)?sh|pwsh|powershell|iex|invoke-expression|python3?|node|perl|ruby)\b/, 'runs a downloaded script'],
  [/\binvoke-expression\b|\biex\b|\s-enc(?:odedcommand)?\s|\bbase64\s+(?:-d|--decode)\b[^\n;]*\|\s*(?:(?:ba|z|da|k)?sh|pwsh|powershell)\b/, 'runs hidden or generated code'],
  [/\bsudo\b|\bdoas\b|\brunas\b|\bstart-process\b[^\n;]*-verb\s+runas/, 'asks for admin rights'],
  [/\brm\s+-[a-z]*r[a-z]*\s+(?:-[a-z]+\s+)*["']?(?:\/|~|\$home|\.\.)(?:\s|\/?["']?$|\/\*)/m, 'deletes outside the project'],
  [/\b(?:rmdir|rd|del)\s+\/[sq]\s+[^\n;&|]*(?:[a-z]:\\|%userprofile%|\.\.)/, 'deletes outside the project'],
  [/\bremove-item\b[^\n;]*-recurse[^\n;]*(?:[a-z]:\\|\$home|\$env:|\.\.)/, 'deletes outside the project'],
  [/\b(?:mkfs|fdisk|diskpart)\b|\bdd\s+[^\n;]*\bof=\/dev\/|\bformat\s+[a-z]:|\breg\s+(?:add|delete)\b|\bsetx\b|\bschtasks\b|\bcrontab\b/, 'changes this PC outside the project'],
  [/\b(?:npm|pnpm|yarn)\s+(?:install|i|add)\s+[^\n;&|]*(?:-g\b|--global\b)|\bpip3?\s+install\s+[^\n;&|]*--user\b/, 'installs software system-wide'],
]

const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const FILE_TOOLS = [...WRITE_TOOLS, 'Read', 'NotebookRead', 'Glob', 'Grep', 'LS']
const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor']
export const GUARDED_TOOLS = [...SHELL_TOOLS, ...FILE_TOOLS].join('|')

// Decides on one tool call. Returns the reason to block it, or null.
/**
 * @param {any} input
 * @param {{ role: string, projectDir: string, home?: string, temp?: string, claudeDir?: string }} options
 */
export function toolProblem(input, { role, projectDir, home = homedir(), temp = tmpdir(), claudeDir }) {
  if (typeof input !== 'object' || input === null || typeof input.tool_name !== 'string') return 'coop could not read this tool call'
  const tool = input.tool_name
  const args = typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {}

  if (SHELL_TOOLS.includes(tool)) {
    const raw = args.command ?? args.cmd ?? ''
    if (typeof raw !== 'string') return 'coop could not read this command'
    const command = raw.replace(/\\\r?\n/g, ' ')
    return commandProblem(command, role)
  }
  if (!FILE_TOOLS.includes(tool)) return null

  const pattern = tool === 'Glob' ? args.pattern ?? '' : ''
  const paths = [args.file_path, args.notebook_path, args.path].filter((value) => value !== undefined && value !== null)
  if (typeof pattern !== 'string' || paths.some((value) => typeof value !== 'string')) return `coop could not read the paths of this ${tool} call`
  if (SECRET_PLACES.some((place) => place.test(pattern.toLowerCase()))) return "Glob on that pattern: it's where this PC keeps credentials"
  if (globBase(pattern)) paths.push(globBase(pattern))
  const writing = WRITE_TOOLS.includes(tool)
  for (const text of paths) {
    const expanded = text === '~' || text.startsWith('~/') || text.startsWith('~\\') ? path.join(home, text.slice(1)) : text
    if (SECRET_PLACES.some((place) => place.test(expanded.toLowerCase()))) return `${tool} on ${text}: that's where this PC keeps credentials`
    if (role !== 'worker') continue
    if (writing && CONTROL_FILES.test(expanded)) return `${tool} on ${text}: that file decides what runs next, so it's for a person to change`
    const config = claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude')
    // Claude Code's own working files stay reachable: skills and plugins to read,
    // memory, plans and tool output to write. Its settings don't.
    const also = writing ? [...CLAUDE_WORK_FOLDERS.map((folder) => path.join(config, folder)), temp] : [config, temp]
    const problem = pathProblem(expanded, { root: projectDir, base: input.cwd, also })
    if (problem) return `${tool} on ${text}: this path ${problem}. Workers stay inside the project folder`
  }
  return null
}

const CLAUDE_WORK_FOLDERS = ['projects', 'plans', 'todos', 'tasks']

// A Glob pattern reaches as far as the fixed part before its first wildcard.
function globBase(pattern) {
  const fixed = pattern.slice(0, pattern.search(/[*?[{]|$/))
  return fixed.slice(0, Math.max(fixed.lastIndexOf('/'), fixed.lastIndexOf('\\')) + 1) || null
}

export function commandProblem(command, role) {
  const text = command.toLowerCase()
  if (SECRET_PLACES.some((place) => place.test(text))) return `this command reaches a place where this PC keeps credentials`
  for (const [pattern, why] of SECRET_COMMANDS) if (pattern.test(text)) return `this command ${why}`
  if (role !== 'worker') return null
  for (const [pattern, why] of WORKER_COMMANDS) if (pattern.test(text)) return `this command ${why}`
  return pushProblem(command)
}

// `git push origin main`, `git push origin HEAD:main`, `git push origin x:refs/heads/main`.
function pushProblem(command) {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/)
    const git = words.findIndex((word) => /(?:^|[\\/])git(?:\.exe)?$/i.test(word.replace(/^["']|["']$/g, '')))
    if (git === -1) continue
    const push = words.indexOf('push', git + 1)
    if (push === -1) continue
    for (const word of words.slice(push + 1)) {
      const clean = word.replace(/^["'+]+|["']+$/g, '')
      if (clean.startsWith('-')) continue
      // Plain "HEAD" means the branch you're on: the pre-push check sees which that is.
      if (clean === 'HEAD') continue
      const destination = clean.includes(':') ? clean.slice(clean.lastIndexOf(':') + 1) : clean
      if (isProtectedBranch(destination)) return `this command pushes to the protected branch ${destination}: push your task's branch instead`
      if (destination.startsWith('refs/') && !destination.startsWith('refs/heads/')) return 'this command pushes something other than a branch'
    }
  }
  return null
}

// What Claude Code gets from `coop start --settings`. Deny rules are enforced by
// Claude Code itself, whatever Claude decides, though it documents that Bash
// patterns can be side-stepped: that's why they back up the hook, not replace it.
export function guardSettings({ role, nodePath, coopBin, profile, hookFields = {}, sandbox = false }) {
  const coopFiles = ['Read(~/.claude-coop/**)', 'Edit(~/.claude-coop/**)']
  const secrets = ['~/.ssh/**', '~/.aws/**', '~/.gnupg/**', '~/.config/gh/**', '~/.git-credentials', '~/.netrc', '~/.npmrc', '~/.claude/.credentials.json', '**/.env', '**/.env.local', '**/.env.production', '**/.env.development', '**/.env.staging']
  const deny = role === 'worker' ? [...coopFiles, ...secrets.flatMap((place) => [`Read(${place})`, `Edit(${place})`]), 'Bash(git push --no-verify *)', 'Bash(git push --force *)', 'Bash(gh pr merge *)', 'Bash(npm publish *)'] : coopFiles
  const settings = {
    permissions: { deny },
    hooks: {
      PreToolUse: [
        {
          matcher: GUARDED_TOOLS,
          hooks: [hookCommand(nodePath, coopBin, ['guard', 'tool', '--profile', profile, '--role', role], hookFields)],
        },
      ],
    },
  }
  if (role === 'worker') {
    settings.autoMode = { classifyAllShell: true }
    settings.permissions.blockReadsOutsideWorkingDirectories = true
  }
  if (sandbox) {
    settings.sandbox = {
      enabled: true,
      failIfUnavailable: true,
      filesystem: { denyRead: ['~/.claude-coop', '~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gh', '~/.git-credentials', '~/.netrc', '~/.npmrc'] },
      network: { allowedDomains: ['github.com', '*.github.com', '*.githubusercontent.com', 'registry.npmjs.org', '*.npmjs.org'] },
    }
  }
  return settings
}

function hookCommand(nodePath, coopBin, args, { execForm = false, blockOnFailure = false } = {}) {
  const forward = (value) => value.replace(/\\/g, '/')
  const failure = blockOnFailure ? { onFailure: 'block' } : {}
  // Exec form avoids every shell's quoting rules, where Claude Code has it.
  if (execForm) return { type: 'command', command: forward(nodePath), args: [forward(coopBin), ...args], timeout: 15, ...failure }
  return { type: 'command', command: [forward(nodePath), forward(coopBin), ...args].map((part) => `"${part}"`).join(' '), timeout: 15, ...failure }
}

// --- git pre-push --------------------------------------------------------------

/** @returns {{ ok: boolean, out: string, raw: string, error: any }} */
function git(args, cwd, options = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_SCAN, ...options })
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), raw: result.stdout ?? '', error: result.error }
}

// Puts the guard in .git/hooks/pre-push. Never overwrites a hook that isn't ours,
// and leaves a repository alone if it manages its hooks in a custom folder.
export function installPrePush({ cwd, nodePath, coopBin }) {
  if (!git(['rev-parse', '--is-inside-work-tree'], cwd).ok) return { status: 'no-repo' }
  if (git(['config', '--get', 'core.hooksPath'], cwd).out) return { status: 'custom-hooks-path' }
  const relative = git(['rev-parse', '--git-path', 'hooks/pre-push'], cwd).out
  if (!relative) return { status: 'no-repo' }
  const file = path.resolve(cwd, relative)
  const forward = (value) => value.replace(/\\/g, '/')
  const content = `#!/bin/sh\n${HOOK_MARKER}: installed by coop start, keeps worker Claudes off protected branches.\n# A person who really means it can use git push --no-verify.\nexec "${forward(nodePath)}" "${forward(coopBin)}" guard pre-push "$@"\n`
  if (existsSync(file)) {
    const current = readFileSync(file, 'utf8')
    if (!current.includes(HOOK_MARKER)) return { status: 'foreign-hook', file }
    if (current === content) return { status: 'present', file }
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  try {
    chmodSync(file, 0o755)
  } catch {}
  return { status: 'installed', file }
}

export function prePushStatus(cwd) {
  const relative = git(['rev-parse', '--git-path', 'hooks/pre-push'], cwd).out
  if (!relative) return 'no-repo'
  if (git(['config', '--get', 'core.hooksPath'], cwd).out) return 'custom-hooks-path'
  const file = path.resolve(cwd, relative)
  if (!existsSync(file)) return 'missing'
  return readFileSync(file, 'utf8').includes(HOOK_MARKER) ? 'present' : 'foreign-hook'
}

// git hands us one line per ref: <local ref> <local sha> <remote ref> <remote sha>.
// Anything we can't read or check is refused.
export function prePushProblem(stdin, { cwd, remote = 'origin' }) {
  const defaultBranch = git(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], cwd).out.split('/').slice(1).join('/')
  for (const line of stdin.split('\n').map((text) => text.trim()).filter(Boolean)) {
    const parts = line.split(/\s+/)
    if (parts.length !== 4) return `coop couldn't read what git is pushing (${line.slice(0, 80)})`
    const [, localSha, remoteRef] = parts
    if (!remoteRef.startsWith('refs/heads/')) return `${remoteRef} isn't a branch. Workers push task branches only`
    const branch = remoteRef.slice('refs/heads/'.length)
    if (isProtectedBranch(branch) || branch === defaultBranch) return `${branch} is a protected branch. Push a task branch and open a pull request`
    if (ZERO_SHA.test(localSha)) continue
    const log = git(['log', '-p', '--no-color', '--no-ext-diff', '--format=', localSha, '--not', `--remotes=${remote}`], cwd)
    if (log.error || !log.ok) return `coop couldn't scan ${branch} for secrets, so it isn't pushing it${log.error?.code === 'ENOBUFS' ? ' (too much to scan: a person should review and push this one)' : ''}`
    const added = log.raw.split('\n').filter((text) => text.startsWith('+') && !text.startsWith('+++')).join('\n')
    const kinds = findSecrets(added)
    if (kinds.length) return `${branch} adds what looks like a secret (${kinds.join(', ')}). Take it out of the commits: remember it stays in history unless they're rewritten`
  }
  return null
}
