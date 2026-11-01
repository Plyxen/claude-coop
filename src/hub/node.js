// The self-hosted hub: the same app as on Cloudflare, served by node:http
// with Node's built-in SQLite as storage.
import { createServer } from 'node:http'
import { createHub } from './app.js'
import { sqliteDatabase } from './sqlite.js'

const MAX_REQUEST = 128 * 1024
const MAX_CONNECTIONS = 256
const ERROR_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }

export async function startNodeHub({
  port = 8765,
  host = '127.0.0.1',
  dbPath = ':memory:',
  leadToken,
  leadTokenHash,
  leadName,
  hubName,
  maxWorkers,
  tokenTtlDays,
  retentionDays,
  log = console.error,
}) {
  const db = await sqliteDatabase(dbPath)
  const hub = createHub({ db, leadToken, leadTokenHash, leadName, hubName, maxWorkers, tokenTtlDays, retentionDays })

  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_REQUEST) {
          res.writeHead(413, ERROR_HEADERS).end('{"error":"request body too large","code":"too_large"}')
          return
        }
        chunks.push(chunk)
      }
      // The Host header is the client's to choose, so it plays no part in the
      // address. The client's address comes from the socket, never from a header.
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) {
        if (name !== 'x-coop-client-address') headers.set(name, Array.isArray(value) ? value.join(', ') : value)
      }
      headers.set('x-coop-client-address', req.socket.remoteAddress ?? 'unknown')
      let address
      try {
        address = new URL(req.url, 'http://hub')
      } catch {
        res.writeHead(400, ERROR_HEADERS).end('{"error":"bad request address","code":"bad_request"}')
        return
      }
      const request = new Request(`http://hub${address.pathname}${address.search}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
      })
      const response = await hub.fetch(request)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) {
      log(error)
      if (!res.headersSent) res.writeHead(500, ERROR_HEADERS)
      res.end('{"error":"internal error","code":"internal"}')
    }
  })

  // Nothing here should take long, so slow clients don't get to hold a socket.
  server.requestTimeout = 30_000
  server.headersTimeout = 15_000
  server.keepAliveTimeout = 10_000
  server.timeout = 60_000
  server.maxConnections = MAX_CONNECTIONS
  server.maxHeadersCount = 64

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(undefined))
  })
  const actualPort = /** @type {import('node:net').AddressInfo} */ (server.address()).port
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host

  return {
    url: `http://${shownHost}:${actualPort}`,
    port: actualPort,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      db.close()
    },
  }
}
