// A rough risk label for a relayed permission request, so a person notices the
// scary ones. It only ever informs: nothing is approved because it looks low risk.
const HIGH = [
  /\brm\s+-[a-z]*[rf]/,
  /\b(?:rmdir|del|rd)\s+\/[sq]/,
  /\bremove-item\b.*-recurse/,
  /\bsudo\b|\brunas\b/,
  /\b(?:curl|wget|invoke-webrequest|iwr)\b.*\|\s*(?:ba|z|da)?sh\b/,
  /\b(?:curl|wget|invoke-webrequest|iwr)\b.*\|\s*(?:iex|invoke-expression|python|node|perl|ruby)\b/,
  /\binvoke-expression\b|\biex\b|-encodedcommand\b|\s-enc\s/,
  /\bgit\s+(?:\S+\s+)*push\b/,
  /\bgit\s+(?:\S+\s+)*(?:reset\s+--hard|clean\s+-[a-z]*f|filter-branch|config)\b/,
  /\bgh\s+(?:pr\s+merge|release|secret|repo\s+delete|auth)\b/,
  /\b(?:npm|pnpm|yarn)\s+publish\b/,
  /\b(?:wrangler|vercel|netlify|flyctl|kubectl|terraform|helm)\b/,
  /\bdeploy\b/,
  /\bchmod\s+(?:-r\s+)?[0-7]*7[0-7]{2}\b|\bchown\b|\bicacls\b|\breg\s+(?:add|delete)\b|\bsetx\b/,
  /\b(?:mkfs|fdisk|diskpart|format\s+[a-z]:)\b|\bdd\s+if=/,
  /(?:^|[\s"'/\\])\.env(?:\.|\b)|\.ssh\b|\.aws\b|\.claude-coop\b|\.gnupg\b|\.npmrc\b|\.netrc\b|id_rsa|id_ed25519/,
  /\bcredentials?\b|\bpasswords?\b|\bprivate[_-]?key\b/,
  /\[redacted\b/,
]
const READ_ONLY_TOOL = /^(?:read|glob|grep|ls|notebookread|todoread|todowrite|websearch)$/i

export function classifyRisk(toolName, inputPreview = '', description = '') {
  const text = `${inputPreview}\n${description}`.toLowerCase()
  if (HIGH.some((pattern) => pattern.test(text))) return 'high'
  return READ_ONLY_TOOL.test(toolName) ? 'low' : 'medium'
}
