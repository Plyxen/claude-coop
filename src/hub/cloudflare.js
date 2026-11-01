// Cloudflare Workers entry. Bindings and settings come from wrangler.toml:
//   DB                    D1 database (required)
//   COOP_LEAD_TOKEN       the lead's token, set with `wrangler secret put` (required)
//   COOP_LEAD_NAME        the lead's crew name (default "lead")
//   COOP_HUB_NAME         a name for this crew, shown on the board
//   COOP_MAX_WORKERS      how many workers can join (default 8)
//   COOP_TOKEN_TTL_DAYS   how long new tokens last, 0 for no expiry (default 90)
//   COOP_RETENTION_DAYS   how long the hub keeps history, 0 for always (default 90)
import { createHub } from './app.js'
import { d1Database } from './d1.js'

let hub
let hubKey

const count = (value, fallback) => (value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback)

export default {
  async fetch(request, env) {
    const key = [env.COOP_LEAD_TOKEN, env.COOP_LEAD_NAME, env.COOP_HUB_NAME, env.COOP_MAX_WORKERS, env.COOP_TOKEN_TTL_DAYS, env.COOP_RETENTION_DAYS].join('|')
    if (!hub || hubKey !== key) {
      try {
        hub = createHub({
          db: d1Database(env.DB),
          leadToken: env.COOP_LEAD_TOKEN,
          leadName: env.COOP_LEAD_NAME || 'lead',
          hubName: env.COOP_HUB_NAME || 'coop',
          maxWorkers: Number(env.COOP_MAX_WORKERS) || 8,
          tokenTtlDays: count(env.COOP_TOKEN_TTL_DAYS, 90),
          retentionDays: count(env.COOP_RETENTION_DAYS, 90),
          // Set by Cloudflare itself on every request, and not by the client.
          clientAddress: (req) => req.headers.get('cf-connecting-ip'),
        })
        hubKey = key
      } catch (error) {
        // The reason is for whoever runs the hub, in `wrangler tail`.
        console.error('[hub] not configured:', error.message)
        return Response.json({ error: 'hub is not configured', code: 'not_configured' }, { status: 500 })
      }
    }
    return hub.fetch(request)
  },
}
