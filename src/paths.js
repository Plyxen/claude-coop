// Is a path really inside the project? A string prefix can't answer that:
// `..`, symlinks, junctions and Windows' many ways to spell a path all get past
// one. So the path is refused if its spelling is suspicious, then resolved to
// the real location on disk and compared with the project's real location.
import { realpathSync } from 'node:fs'
import path from 'node:path'

const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:\.[^.]*)*$/i

// Spelling problems, checked without touching the disk.
export function lexicalPathProblem(candidate, platform = process.platform) {
  if (typeof candidate !== 'string' || !candidate) return 'is empty'
  if (candidate.includes('\0')) return 'contains a null byte'
  if (candidate.length > 4096) return 'is too long'
  const slashed = candidate.replace(/\\/g, '/')
  if (/^\/\/[?.]\//.test(slashed)) return 'uses a Windows device path'
  if (platform === 'win32' || candidate.startsWith('\\\\')) {
    if (slashed.startsWith('//')) return 'is a network (UNC) path'
  }
  if (platform === 'win32') {
    if (/^[a-z]:(?!\/)/i.test(slashed) && slashed.length > 2) return 'is relative to a drive (C:foo)'
    const rest = slashed.replace(/^[a-z]:/i, '')
    if (rest.includes(':')) return 'uses an alternate data stream'
    for (const part of rest.split('/')) {
      if (!part || part === '.' || part === '..') continue
      if (/[. ]$/.test(part)) return 'has a name ending in a dot or a space, which Windows silently drops'
      if (RESERVED_DEVICE.test(part)) return 'uses a reserved Windows device name'
    }
  }
  return null
}

// The real location of a path that may not exist yet: resolve the deepest part
// that exists (following symlinks and junctions), then add the rest.
function canonical(target) {
  const missing = []
  let current = target
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...missing.reverse())
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      const parent = path.dirname(current)
      if (parent === current) return target
      missing.push(path.basename(current))
      current = parent
    }
  }
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

// Why this path is outside the allowed places, or null if it's fine.
export function pathProblem(candidate, { root, base = root, also = [] }) {
  const lexical = lexicalPathProblem(candidate)
  if (lexical) return lexical
  let target
  try {
    target = canonical(path.resolve(base ?? root, candidate))
  } catch {
    return "can't be checked"
  }
  const places = [root, ...also].map((place) => {
    try {
      return canonical(path.resolve(place))
    } catch {
      return null
    }
  })
  return places.some((place) => place && isInside(place, target)) ? null : 'is outside the project'
}
