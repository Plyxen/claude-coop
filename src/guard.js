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

// Files that change what the checks do. Named anywhere in a command, even in quotes.
/** @type {[RegExp, string][]} */
const CONTROL_COMMANDS = [
  [/\bgit\b[^\n;&|]*\s-c\s+core\.hookspath\b/, 'turns off git hooks'],
  [/\bgit\s+config\b[^\n;&|]*\bcore\.hookspath\b/, 'changes where git hooks live'],
  [/\.git[\\/]hooks\b/, 'touches git hooks'],
  [/\.claude[\\/](?:settings|hooks)|>\s*\S*\.mcp\.json\b/, "changes Claude Code's settings or hooks"],
]

// Where a shell runs a program: first on a line, or after ; & | ( or a backtick,
// past any NAME=value, shell keyword or launcher like npx. Its folder and its
// version (wrangler@4) don't change what it is. A program's name alone is too
// common a word to go on: `az` is also Hungarian for "the".
const BEFORE_PROGRAM = String.raw`(?:^|[;&|(\x60]|\s-exec(?:dir)?\s)\s*["']?(?:(?:\w+=\S*|then|do|else|if|while|until|!|\{)\s+|(?:npx|bunx|env|command|exec|nohup|time|sudo|doas|xargs|(?:ba|z|da|k)?sh|pwsh|powershell|cmd|npm\s+exec|pnpm(?:\s+(?:dlx|exec))?|yarn(?:\s+dlx)?|bun(?:\s+x)?)(?:\.exe)?(?:\s+[-/]\S+)*\s+)*(?:\S*[\\/])?`
const AFTER_PROGRAM = String.raw`(?:@\S*)?(?:\.(?:exe|cmd|bat|ps1))?(?=["'\s]|$)`
const running = (names, rest = '') => new RegExp(`${BEFORE_PROGRAM}(?:${names})${AFTER_PROGRAM}${rest}`, 'm')

// `wrangler@4 deploy`, `wrangler --env production deploy`. Local work like `wrangler dev` is fine.
const WRANGLER_CHANGE = /\bwrangler(?:@\S*)?(?:\.cmd|\.exe)?(?:\s+-\S+(?:\s+[^-\s]\S*)??)*?\s+(?:deploy|publish|secret|rollback|delete|versions\s+(?:deploy|upload|secret)|pages\s+(?:deploy|publish)|triggers\s+deploy|d1\s+(?:execute|delete|migrations\s+apply)|(?:kv|r2)\b[^\n;&|]*\s--remote)(?=[\s;&|)]|$)/
const DEPLOYS = 'deploys or touches cloud infrastructure'

// Command shapes workers never run, checked against what the command really runs.
// The real limits are the project's branch protection and the worker's permission
// mode: these catch the common cases.
/** @type {[RegExp, string][]} */
const WORKER_COMMANDS = [
  [/\bgit\s+(?:\S+\s+)*push\b[^\n;&|]*--no-verify\b/, "skips coop's pre-push check"],
  [/\bgit\s+(?:\S+\s+)*push\b[^\n;&|]*\s(?:--force(?!-with-lease)\b|-f\b|--mirror\b|--delete\b|-d\b|--tags\b|--all\b)/, 'is a destructive or bulk push'],
  [/\bgh\s+pr\s+merge\b|\bgh\s+pr\s+review\s+[^\n;&|]*--approve\b/, 'merges or approves a pull request: that is for the lead'],
  [/\bgh\s+release\b|\bgh\s+secret\b|\bgh\s+variable\b|\bgh\s+repo\s+(?:delete|edit|rename|archive)\b|\bgh\s+workflow\s+run\b|\bgh\s+api\b[^\n;&|]*(?:-x|--method)\s*(?:put|post|patch|delete)\b/, 'changes GitHub settings, releases or secrets'],
  [/\b(?:npm|pnpm|yarn|bun)(?:@\S*)?(?:\s+-\S+)*\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b/, 'publishes a package'],
  [WRANGLER_CHANGE, DEPLOYS],
  [running('vercel|flyctl|kubectl|helm|aws|gcloud|az'), DEPLOYS],
  [running('netlify(?:-cli)?|fly', String.raw`\s+deploy\b`), DEPLOYS],
  [running('terraform', String.raw`\s+(?:apply|destroy)\b`), DEPLOYS],
  [running('pulumi', String.raw`\s+up\b`), DEPLOYS],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?deploy\b/, DEPLOYS],
  [/\b(?:curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)\b[^\n;]*\|\s*(?:(?:ba|z|da|k)?sh|pwsh|powershell|iex|invoke-expression|python3?|node|perl|ruby)\b/, 'runs a downloaded script'],
  [/\binvoke-expression\b|\biex\b|\s-enc(?:odedcommand)?\s|\bbase64\s+(?:-d|--decode)\b[^\n;]*\|\s*(?:(?:ba|z|da|k)?sh|pwsh|powershell)\b/, 'runs hidden or generated code'],
  [running('sudo|doas|runas'), 'asks for admin rights'],
  [/\bstart-process\b[^\n;]*-verb\s+runas/, 'asks for admin rights'],
  [running(String.raw`mkfs(?:\.\w+)?|fdisk|diskpart|setx|schtasks|crontab`), 'changes this PC outside the project'],
  [running('reg', String.raw`\s+(?:add|delete)\b`), 'changes this PC outside the project'],
  [/\bdd\s+[^\n;]*\bof=\/dev\/|\bformat\s+[a-z]:/, 'changes this PC outside the project'],
  [/\b(?:npm|pnpm|yarn)\s+(?:install|i|add)\s+[^\n;&|]*(?:-g\b|--global\b)|\bpip3?\s+install\s+[^\n;&|]*--user\b/, 'installs software system-wide'],
]

const QUOTED = /"((?:[^"\\]|\\[\s\S])*)"|'([^']*)'/g
const HERE_DOCUMENT = /<<-?[ \t]*(["']?)([\w.-]+)\1([^\n]*)\n(?:([\s\S]*?)\n)?[ \t]*\2[ \t]*(?=\r?\n|$)/g
const HERE_STRING = /@(["'])\r?\n[\s\S]*?\r?\n\1@/g
const STARTS_COMMAND = /(?:^|[;&|(\x60])\s*$/
const RUNS_ITS_TEXT = /(?:\b(?:(?:ba|z|da|k)?sh|pwsh|powershell)(?:\.exe)?\b[^;&|\n]*\s-[a-z]*c\w*|\bcmd(?:\.exe)?\s+\/[ck]|\beval|<<<)\s*$/i
const FED_TO_SHELL = /\|\s*(?:sudo\s+)?(?:(?:ba|z|da|k)?sh|pwsh|powershell|iex|cmd)(?:\.exe)?\b/i
const TAKES_ITS_INPUT = /\b(?:(?:ba|z|da|k)?sh|pwsh|powershell|cmd|iex|python3?|node|perl|ruby|php)(?:\.exe)?\b/i
const SPAWNS = /child_process|\bexecsync\b|\bexecfile|\bspawn|\bsubprocess\b|\bos\.system\b|\bpopen\b|\bsystem\s*\(|\bexec\s*\(/i
const SUBSTITUTES = /\$\(|(?<!\\)`/
const DELETE_SO_FAR = /(?:^|[\s;&|(\\/])(?:rm|rmdir|rd|del|erase|remove-item|ri)(?:\.exe)?\s[^;&|\n]*$/i

// The command without the text it only mentions: a commit message or a grep for
// "az email" isn't running anything. Text stays when something will run it, when
// it's the program itself, and when it's one plain word, since `"aws" s3 rm` and
// `git push "--force"` run just as well with the quotes.
function whatRuns(command) {
  const fed = FED_TO_SHELL.test(command)
  return command
    .replace(HERE_STRING, '""')
    .replace(HERE_DOCUMENT, (whole, _quote, _tag, rest, body = '', at, text) => {
      const line = text.slice(text.lastIndexOf('\n', at) + 1, at) + rest
      return TAKES_ITS_INPUT.test(line) || SPAWNS.test(body) ? whole : `${rest}\n`
    })
    .replace(QUOTED, (whole, double, single, at, text) => {
      const inner = double ?? single
      const before = text.slice(Math.max(0, at - 200), at)
      if (fed || RUNS_ITS_TEXT.test(before)) return ` ; ${inner} ; `
      if (!/[\s;&|()`<>]/.test(inner) || STARTS_COMMAND.test(before) || DELETE_SO_FAR.test(before) || SPAWNS.test(inner) || (double !== undefined && SUBSTITUTES.test(inner))) return inner
      return '""'
    })
}

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
    return commandProblem(command, role, { projectDir, cwd: typeof input.cwd === 'string' ? input.cwd : undefined, home, temp })
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

/**
 * @param {string} command
 * @param {string} role
 * @param {{ projectDir?: string, cwd?: string, home?: string, temp?: string }} [places]
 */
export function commandProblem(command, role, places = {}) {
  const text = command.toLowerCase()
  if (SECRET_PLACES.some((place) => place.test(text))) return `this command reaches a place where this PC keeps credentials`
  for (const [pattern, why] of SECRET_COMMANDS) if (pattern.test(text)) return `this command ${why}`
  if (role !== 'worker') return null
  for (const [pattern, why] of CONTROL_COMMANDS) if (pattern.test(text)) return `this command ${why}`
  const runs = whatRuns(command)
  const lower = runs.toLowerCase()
  for (const [pattern, why] of WORKER_COMMANDS) if (pattern.test(lower)) return `this command ${why}`
  return pushProblem(runs) ?? deleteProblem(runs, places)
}

const DELETERS = /^(?:rm|rmdir|rd|del|erase|remove-item|ri)(?:\.exe)?$/i
const CMD_DELETERS = /^(?:rmdir|rd|del|erase)(?:\.exe)?$/i

// `rm -rf ../other`, `rm -f /etc/x`, `Remove-Item ..\x -Recurse`: whatever a delete
// names has to be in the project, or in temp. The folder a `cd` earlier in the
// command moved to, and a variable's value, aren't known here.
function deleteProblem(command, { projectDir = process.cwd(), cwd = projectDir, home = homedir(), temp = tmpdir() }) {
  for (const segment of command.split(/&&|\|\||[;&|\n()]/)) {
    const words = segment.trim().split(/\s+/).map((word) => word.replace(/^["'`]+|["'`]+$/g, ''))
    const at = words.findIndex((word) => DELETERS.test(word.split(/[\\/]/).pop() ?? ''))
    if (at === -1) continue
    const cmdStyle = CMD_DELETERS.test(words[at].split(/[\\/]/).pop() ?? '')
    for (const word of words.slice(at + 1)) {
      if (/^\d*[<>]/.test(word)) break
      if (!word || word.startsWith('-') || (cmdStyle && /^\/[a-z]$/i.test(word))) continue
      if (leavesProject(word, { projectDir, cwd, home, temp })) return 'this command deletes outside the project'
    }
  }
  return null
}

function leavesProject(word, { projectDir, cwd, home, temp }) {
  let target = word
    .replace(/\\/g, '/')
    .replace(/^~(?=\/|$)/, () => home)
    .replace(/^(?:\$\{?(?:home|userprofile)\}?|\$env:(?:home|userprofile)|%userprofile%)(?=\/|$)/i, () => home)
    .replace(/^(?:\$\{?(?:tmpdir|temp|tmp)\}?|\$env:(?:temp|tmp)|%te?mp%|\/tmp)(?=\/|$)/i, () => temp)
    .replace(/^\$\{?pwd\}?(?=\/|$)/i, () => cwd)
  if (/^~[\w-]+(?:\/|$)/.test(target)) return true
  if (process.platform === 'win32') target = target.replace(/^\/([a-z])(?=\/|$)/i, '$1:')
  else if (/^[a-z]:/i.test(target)) return true
  if (target.includes('$') || /%\w+%/.test(target)) return false
  if (/[*?[{]/.test(target)) target = globBase(target) ?? '.'
  return pathProblem(target, { root: projectDir, base: cwd, also: [temp] }) !== null
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
