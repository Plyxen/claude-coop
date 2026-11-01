// Input rules shared by the hub and the clients. Everything that crosses the
// network is hostile until it passes here. Web APIs only: the hub runs on
// Cloudflare Workers too.

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const CREW_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u
export const ROLES = ['lead', 'worker', 'observer']
// Words the tools give a meaning of their own, so no worker can be called them.
export const RESERVED_NAMES = ['all', 'coop', 'everyone', 'hub', 'lead', 'observer', 'root', 'system', 'worker']
export const PROTECTED_BRANCHES = ['head', 'main', 'master', 'trunk']

const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[@-Z\\-_])/g
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
const char = (code) => String.fromCharCode(code)
const BIDI = new RegExp(`[${char(0x200e)}${char(0x200f)}${char(0x202a)}-${char(0x202e)}${char(0x2066)}-${char(0x2069)}${char(0xfeff)}]`, 'g')
const LINE_BREAK = new RegExp(`\\r\\n?|${char(0x2028)}|${char(0x2029)}`, 'g')

// Removes what can rewrite a terminal or hide text from a reader: escape
// sequences, control characters and bidirectional overrides.
export function cleanText(value) {
  return String(value)
    .replace(ANSI, '')
    .replace(LINE_BREAK, '\n')
    .replace(CONTROL, '')
    .replace(BIDI, '')
}

// Text from the network goes into a Claude session inside a <channel> tag, so
// it must not be able to close that tag or open one of its own.
export function neutralizeMarkup(text) {
  return String(text).replace(/<(\/?)(?=channel|system|function|antml|tool|invoke|parameter)/gi, '‹$1')
}

// Marks several lines of someone else's text as a quote, so none of them can
// pass as a line from coop itself.
export function quoted(text) {
  const clean = String(text ?? '')
  return clean.includes('\n') ? `\n${clean.split('\n').map((line) => `> ${line}`).join('\n')}` : clean
}

export function isMemberName(value) {
  return typeof value === 'string' && NAME_RE.test(value)
}

export function isCrewName(value) {
  return typeof value === 'string' && CREW_RE.test(value)
}

export function isProtectedBranch(name) {
  const base = String(name).replace(/^refs\/heads\//, '').replace(/^origin\//, '').toLowerCase()
  return PROTECTED_BRANCHES.includes(base)
}

// Why a branch name is refused, or null. Stricter than git on purpose: the name
// ends up in commands that a Claude runs, so nothing here may start an option
// or mean something to a shell.
export function branchProblem(name) {
  if (typeof name !== 'string' || !name) return 'is empty'
  if (name.length > 200) return 'is too long'
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) return 'may only use letters, digits and . _ / - and must start with a letter or digit'
  if (/\.\.|\/\/|\/\.|@\{|\.lock(?:\/|$)|[./]$|^refs\//i.test(name)) return 'is not a valid git branch name'
  if (isProtectedBranch(name)) return 'is a protected branch: tasks use their own branch'
  return null
}

// Why a pull request link is refused, or null.
export function httpsUrlProblem(value) {
  if (typeof value !== 'string' || !value) return 'is empty'
  if (value.length > 500) return 'is too long'
  if (/[\s\u0000-\u001F\u007F]/.test(value)) return 'must not contain spaces or control characters'
  let url
  try {
    url = new URL(value)
  } catch {
    return 'is not a valid URL'
  }
  if (url.protocol !== 'https:') return 'must start with https://'
  if (url.username || url.password) return 'must not contain credentials'
  return null
}

// loopback and tailscale traffic doesn't cross a network in the clear; private
// is someone's LAN, where plain http can still be read; public is the internet.
export function hostKind(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)) return 'loopback'
  if (host.endsWith('.ts.net') || /^fd7a:115c:a1e0:/.test(host)) return 'tailscale'
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 100 && b >= 64 && b <= 127) return 'tailscale'
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return 'private'
    return 'public'
  }
  if (/^f[cd][0-9a-f]{2}:|^fe[89ab][0-9a-f]:/.test(host)) return 'private'
  // A bare machine name only resolves inside a private network.
  return host.includes('.') ? 'public' : 'private'
}

// Checks a hub address. Returns { url, kind, plain }, or throws with the reason.
export function parseHubUrl(value, { allowInsecure = false } = {}) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`"${cleanText(value)}" is not a valid hub URL.`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The hub URL must start with https:// (or http:// on a private network).')
  if (url.username || url.password) throw new Error("The hub URL must not contain a username or password: the token is what signs you in.")
  if (url.search || url.hash) throw new Error('The hub URL must not contain a query or a fragment.')
  const kind = hostKind(url.hostname)
  const plain = url.protocol === 'http:'
  if (plain && kind === 'public' && !allowInsecure) {
    throw new Error(`Refusing plain http to ${url.hostname}: your token would cross the internet unencrypted. Use the hub's https address, or a private network like Tailscale. For a throwaway test only, pass --insecure-dev-mode.`)
  }
  return { url: url.href.replace(/\/+$/, ''), kind, plain }
}

// Compares two strings of the same kind (hex digests) without stopping at the
// first difference.
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}
