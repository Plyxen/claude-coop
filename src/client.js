// A thin client for the hub's API, used by the MCP server and the CLI. What the
// hub answers is treated as untrusted: size-capped, cleaned, no redirects.
import { VERSION } from './hub/app.js'
import { cleanText, parseHubUrl } from './validate.js'

const MAX_RESPONSE = 4 * 1024 * 1024
const MAX_ATTEMPTS = 2
const RETRY_STATUS = [502, 503, 504]

export class HubError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {{ code?: string, retryAfter?: number }} [details]
   */
  constructor(message, status, { code, retryAfter } = {}) {
    super(message)
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

export class HubClient {
  // presence: false for one-off commands, so they don't make you look online.
  constructor({ hub, token, timeoutMs = 15_000, presence = true, allowInsecureHttp = false }) {
    if (!hub) throw new Error('no hub URL')
    if (!token) throw new Error('no token')
    this.base = parseHubUrl(hub, { allowInsecure: allowInsecureHttp }).url
    // Node turns off certificate checks for the whole process when this is set.
    if (this.base.startsWith('https:') && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
      throw new Error("NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks, so coop won't send your token over this connection. Unset it. If your network uses its own certificate authority, point NODE_EXTRA_CA_CERTS at it instead.")
    }
    this.token = token
    this.timeoutMs = timeoutMs
    this.presence = presence
  }

  // A change carries the same request id on a retry, so the hub can tell it's a
  // repeat and not run it twice.
  async request(method, path, body) {
    const requestId = crypto.randomUUID()
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(method, path, body, requestId)
      } catch (error) {
        const transient = error.status === 0 || RETRY_STATUS.includes(error.status)
        if (!transient || attempt >= MAX_ATTEMPTS) throw error
        await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 400))
      }
    }
  }

  async attempt(method, path, body, requestId) {
    let response
    let text
    try {
      response = await fetch(this.base + path, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'user-agent': `claude-code-multi-pc/${VERSION}`,
          ...(this.presence ? {} : { 'x-coop-presence': 'off' }),
          ...(method === 'GET' ? {} : { 'x-coop-request-id': requestId, 'x-coop-timestamp': String(Date.now()) }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A redirect could carry this request somewhere else, or down to plain http.
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      text = await readLimited(response)
    } catch (error) {
      throw new HubError(`can't reach the hub at ${this.base} (${error.cause?.code ?? error.name})`, 0)
    }
    let data = {}
    try {
      data = JSON.parse(text)
    } catch {}
    if (typeof data !== 'object' || data === null) data = {}
    if (!response.ok) {
      const message = typeof data.error === 'string' ? cleanText(data.error).slice(0, 500) : `hub answered HTTP ${response.status}`
      throw new HubError(message, response.status, { code: data.code, retryAfter: Number(response.headers.get('retry-after')) || undefined })
    }
    return data
  }

  me() {
    return this.request('GET', '/v1/me')
  }
  board() {
    return this.request('GET', '/v1/board')
  }
  events(after, limit = 100) {
    return this.request('GET', `/v1/events?after=${after}&limit=${limit}`)
  }
  tasks(status) {
    return this.request('GET', `/v1/tasks${status ? `?status=${encodeURIComponent(status)}` : ''}`)
  }
  task(id) {
    return this.request('GET', `/v1/tasks/${id}`)
  }
  createTask(task) {
    return this.request('POST', '/v1/tasks', task)
  }
  taskAction(id, action, body = {}) {
    return this.request('POST', `/v1/tasks/${id}/${action}`, body)
  }
  send(message) {
    return this.request('POST', '/v1/messages', message)
  }
  invite(name, options = {}) {
    return this.request('POST', '/v1/members', { name, ...options })
  }
  remove(name) {
    return this.request('DELETE', `/v1/members/${encodeURIComponent(name)}`)
  }
  permissionRequest(request) {
    return this.request('POST', '/v1/permissions', request)
  }
  permissionVerdict(verdict) {
    return this.request('POST', '/v1/permissions/verdict', verdict)
  }
  permissions(status = 'pending') {
    return this.request('GET', `/v1/permissions?status=${encodeURIComponent(status)}`)
  }
  tokens(member) {
    return this.request('GET', `/v1/tokens${member ? `?member=${encodeURIComponent(member)}` : ''}`)
  }
  rotateToken() {
    return this.request('POST', '/v1/tokens/rotate', {})
  }
  revokeToken(id) {
    return this.request('DELETE', `/v1/tokens/${encodeURIComponent(id)}`)
  }
  revokeAllTokens(member) {
    return this.request('POST', '/v1/tokens/revoke-all', member ? { member } : {})
  }
  approvalStatus() {
    return this.request('GET', '/v1/approvals')
  }
  approvalSetup(settings) {
    return this.request('POST', '/v1/approvals/setup', settings)
  }
  /** @param {{ type?: string, limit?: number }} [filter] */
  audit({ type, limit = 50 } = {}) {
    return this.request('GET', `/v1/audit?limit=${limit}${type ? `&type=${encodeURIComponent(type)}` : ''}`)
  }
}

async function readLimited(response) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    size += value.byteLength
    if (size > MAX_RESPONSE) {
      await reader.cancel().catch(() => {})
      throw new Error('the answer was too large')
    }
    text += decoder.decode(value, { stream: true })
  }
}
