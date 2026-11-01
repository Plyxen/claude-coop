// `coop guard tool` (run by Claude Code before a tool call) and `coop guard
// pre-push` (run by git). A non-zero return blocks. Messages go out with
// writeSync, because the caller exits straight away and a pipe on Windows
// wouldn't get flushed otherwise.
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { guardLogPath } from './config.js'
import { prePushProblem, toolProblem } from './guard.js'
import { redactSecrets } from './secrets.js'
import { cleanText } from './validate.js'

export const BLOCK = 2

const MAX_LOG = 1024 * 1024

function readInput() {
  try {
    return readFileSync(0, 'utf8')
  } catch (error) {
    if (error.code === 'EOF') return ''
    throw error
  }
}

function projectDir(input) {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', cwd: input.cwd })
  return git.status === 0 ? git.stdout.trim() : (input.cwd ?? process.cwd())
}

// What got blocked stays on this PC, for its owner: coop audit --local. It holds
// the reason, not the command, and it must never get in the way of blocking.
function remember(check, role, reason) {
  try {
    const file = guardLogPath()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    try {
      if (statSync(file).size > MAX_LOG) renameSync(file, `${file}.old`)
    } catch {}
    const clean = cleanText(redactSecrets(reason).text).slice(0, 500)
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), check, role, reason: clean })}\n`, { mode: 0o600 })
  } catch {}
}

export function runGuard(args) {
  const [kind, ...rest] = args
  if (kind === 'tool') {
    // Only the exact word "lead" gets the lead's looser rules.
    const roleAt = rest.indexOf('--role')
    const role = roleAt !== -1 && rest[roleAt + 1] === 'lead' ? 'lead' : 'worker'
    let input
    try {
      input = JSON.parse(readInput())
    } catch {
      remember('tool', role, 'could not read a tool call')
      writeSync(2, 'coop guard could not read this tool call, so it is blocked.\n')
      return BLOCK
    }
    const problem = toolProblem(input, { role, projectDir: projectDir(input) })
    if (!problem) return 0
    remember('tool', role, problem)
    writeSync(2, `coop guard blocked this: ${problem}.\n`)
    return BLOCK
  }
  if (kind === 'pre-push') {
    const problem = prePushProblem(readInput(), { cwd: process.cwd(), remote: rest[0] })
    if (!problem) return 0
    remember('pre-push', 'worker', problem)
    // No way past it in this message: whoever it just stopped may well be a Claude.
    writeSync(2, `coop guard stopped this push: ${problem}.\nIf that's wrong, tell a person: coop's troubleshooting guide covers it.\n`)
    return BLOCK
  }
  writeSync(2, 'coop guard: unknown check.\n')
  return BLOCK
}
