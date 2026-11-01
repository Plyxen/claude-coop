// Local settings: ~/.claude-coop/config.json holds one profile per crew you
// joined (hub URL, token, your name and role). Tokens never go into a project.
import { mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ROLES, isCrewName, isMemberName } from './validate.js'

const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/

export function coopHome() {
  return process.env.COOP_HOME || join(homedir(), '.claude-coop')
}

function configPath() {
  return join(coopHome(), 'config.json')
}

export function guardLogPath() {
  return join(coopHome(), 'guard.log')
}

export function loadConfig() {
  try {
    const config = JSON.parse(readFileSync(configPath(), 'utf8'))
    if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error('it is not a JSON object')
    const profiles = typeof config.profiles === 'object' && config.profiles !== null ? config.profiles : {}
    return { ...config, profiles }
  } catch (error) {
    if (error.code === 'ENOENT') return { profiles: {} }
    throw new Error(`Can't read ${configPath()}: ${error.message}`, { cause: error })
  }
}

export function saveConfig(config) {
  writePrivate(configPath(), `${JSON.stringify(config, null, 2)}\n`)
}

export function getProfile(name) {
  const config = loadConfig()
  const profileName = name || process.env.COOP_PROFILE || config.default
  if (!profileName) throw new Error('You haven\'t joined a crew yet. Run: coop join --hub <url> --token <token>')
  if (!PROFILE_RE.test(profileName)) throw new Error('That is not a valid profile name.')
  const profile = Object.hasOwn(config.profiles, profileName) ? config.profiles[profileName] : null
  if (!profile) {
    const known = Object.keys(config.profiles)
    throw new Error(`No crew profile named "${profileName}". ${known.length ? `Yours: ${known.join(', ')}` : 'Join a crew first: coop join --hub <url> --token <token>'}`)
  }
  checkProfile(profile, profileName)
  return { name: profileName, ...profile }
}

// A profile's names came from a hub and end up in Claude's instructions and on a
// command line, so they're checked on the way out as well as on the way in.
export function checkProfile(profile, name = 'this') {
  const problem = !isMemberName(profile.member) ? 'its member name' : !ROLES.includes(profile.role) ? 'its role' : !isMemberName(profile.lead) ? 'its lead name' : !isCrewName(profile.crew) ? 'its crew name' : null
  if (problem) throw new Error(`The ${name} profile looks wrong (${problem} isn't valid). Run coop join again, and only with a hub you trust.`)
}

export function saveProfile(name, profile) {
  if (!PROFILE_RE.test(name)) throw new Error(`Profile name "${name}" is not valid: use lowercase letters, digits, - and _.`)
  const config = loadConfig()
  config.profiles[name] = profile
  if (!config.default || !config.profiles[config.default]) config.default = name
  saveConfig(config)
  return config
}

export function setDefaultProfile(name) {
  const config = loadConfig()
  if (!Object.hasOwn(config.profiles, name)) throw new Error(`No crew profile named "${name}".`)
  config.default = name
  saveConfig(config)
}

export function profileSlug(text) {
  const slug = String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'default'
}

// Per-profile state for the MCP server (the event cursor), so a restarted
// session doesn't replay old events.
export function readState(profileName) {
  try {
    const state = JSON.parse(readFileSync(join(coopHome(), 'state', `${profileName}.json`), 'utf8'))
    return typeof state === 'object' && state !== null && Number.isSafeInteger(state.cursor) ? state : {}
  } catch {
    return {}
  }
}

export function writeState(profileName, state) {
  writePrivate(join(coopHome(), 'state', `${profileName}.json`), JSON.stringify(state))
}

// Owner-only, atomic, and it won't write through something planted at the temp
// file's name. On Windows the mode is ignored and the file inherits the ACL of
// the user's profile folder, which other non-admin accounts can't read.
export function writePrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  rmSync(temp, { force: true })
  const handle = openSync(temp, 'wx', 0o600)
  try {
    writeSync(handle, text)
  } finally {
    closeSync(handle)
  }
  renameSync(temp, path)
}

// Whether others on this PC can read a file. Null where the OS doesn't say (Windows).
export function isExposedFile(path) {
  if (process.platform === 'win32') return null
  try {
    return (statSync(path).mode & 0o077) !== 0
  } catch {
    return null
  }
}
