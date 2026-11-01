// The approval passphrase: the step that stands for "a person decided this".
// The lead's Claude has the lead's token, so that token can't be proof of a
// person. The passphrase is typed at a hidden prompt, stored nowhere on this PC,
// and turned into a key here, so the hub only ever sees (and stores a hash of)
// the key. It can be guessed offline only by paying scrypt's cost per guess.
import { randomBytes, scrypt } from 'node:crypto'

export const MIN_PASSPHRASE = 12
const COST = 2 ** 15
const BLOCK = 8
const PARALLEL = 1

export const KDF = `scrypt:${COST}:${BLOCK}:${PARALLEL}`

export function newSalt() {
  return randomBytes(16).toString('hex')
}

export function deriveApprovalKey(passphrase, saltHex, kdf = KDF) {
  const match = /^scrypt:(\d+):(\d+):(\d+)$/.exec(kdf ?? '')
  if (!match) throw new Error('the hub sent approval settings this coop does not understand')
  const [N, r, p] = match.slice(1).map(Number)
  // The hub picks these for later prompts, so it must not be able to pick ones
  // that are too weak to matter or big enough to take this PC down.
  if (N < 2 ** 14 || N > 2 ** 20 || (N & (N - 1)) !== 0 || r !== 8 || p < 1 || p > 4) throw new Error('the hub sent approval settings outside the safe range')
  if (!/^[0-9a-f]{32,128}$/.test(saltHex ?? '')) throw new Error('the hub sent an invalid approval salt')
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize('NFKC'), Buffer.from(saltHex, 'hex'), 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (error, key) => {
      if (error) reject(error)
      else resolve(key.toString('hex'))
    })
  })
}

// Only people have one of these. Refusing piped input also stops the passphrase
// from ending up in a script or a file that a process could read.
export function requireTerminal(what, stdin = process.stdin) {
  if (!stdin.isTTY) throw new Error(`${what} needs a person at a terminal: run this command yourself, in your own window. A Claude can't do this for you.`)
}

export function promptHidden(label, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    output.write(label)
    let text = ''
    const wasRaw = input.isRaw
    const finish = (action) => {
      input.removeListener('data', onData)
      if (input.setRawMode) input.setRawMode(Boolean(wasRaw))
      input.pause()
      output.write('\n')
      action()
    }
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish(() => resolve(text))
        if (char === '\u0003' || char === '\u0004') return finish(() => reject(new Error('cancelled')))
        if (char === '\u007f' || char === '\b') text = [...text].slice(0, -1).join('')
        else if (char >= ' ') text += char
      }
    }
    if (input.setRawMode) input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}
