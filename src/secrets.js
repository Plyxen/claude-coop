// Pattern-based secret detection. This is an extra layer that catches common
// accidents, never a guarantee: it doesn't know your secrets, only what popular
// ones look like. Web APIs only, since the hub uses it too.

const PATTERNS = [
  ['private-key', /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['aws-secret-key', /\baws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}/gi],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ['slack-token', /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g],
  ['stripe-key', /\b[rs]k_live_[A-Za-z0-9]{16,}/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}/g],
  ['coop-token', /\bcoop_[A-Za-z0-9_-]{24,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['database-url', /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@]{1,200}:[^\s@/]{1,200}@[^\s]{1,300}/g],
]

// name = value, the shape of .env files and config. Most of the false positives
// live here, so values that are obviously not secrets are let through.
const ASSIGNMENT = /(password|passwd|pwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret)(["']?\s{0,8}[=:]\s{0,8}["']?)([^\s"'`,;()]{8,200})/gi
const NOT_A_SECRET = /^(?:\$|<|\{|\[|%|process\.env|os\.environ|env\.|import\.meta|undefined|null|none|true|false|string|boolean|required|optional|example|changeme|placeholder|your[_-]|xxx|\*{3})/i

// Replaces what looks like a secret with [redacted <kind>] and says what it found.
export function redactSecrets(input) {
  let text = String(input ?? '')
  const kinds = new Set()
  for (const [kind, pattern] of PATTERNS) {
    text = text.replace(pattern, () => {
      kinds.add(kind)
      return `[redacted ${kind}]`
    })
  }
  text = text.replace(ASSIGNMENT, (match, name, separator, value) => {
    if (NOT_A_SECRET.test(value)) return match
    kinds.add('assignment')
    return `${name}${separator}[redacted]`
  })
  return { text, kinds: [...kinds] }
}

export function findSecrets(input) {
  return redactSecrets(input).kinds
}
