// Cloudflare D1 behind the small interface the hub uses: all, get and run.
export function d1Database(d1) {
  return {
    async all(sql, params = []) {
      const result = await d1.prepare(sql).bind(...params).all()
      return result.results
    },
    async get(sql, params = []) {
      return (await d1.prepare(sql).bind(...params).first()) ?? undefined
    },
    async run(sql, params = []) {
      const result = await d1.prepare(sql).bind(...params).run()
      return { changes: result.meta.changes, lastId: result.meta.last_row_id }
    },
    // All statements commit together, or none of them do.
    async batch(statements) {
      await d1.batch(statements.map(([sql, params = []]) => d1.prepare(sql).bind(...params)))
    },
  }
}
