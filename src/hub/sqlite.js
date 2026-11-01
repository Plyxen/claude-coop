// Node's built-in SQLite behind the same interface as d1.js, for the
// self-hosted hub and the tests.
export async function sqliteDatabase(path = ':memory:') {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')

  return {
    async all(sql, params = []) {
      return db.prepare(sql).all(...params).map((row) => ({ ...row }))
    },
    async get(sql, params = []) {
      const row = db.prepare(sql).get(...params)
      return row ? { ...row } : undefined
    },
    async run(sql, params = []) {
      const result = db.prepare(sql).run(...params)
      return { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) }
    },
    // All statements commit together, or none of them do.
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const [sql, params = []] of statements) db.prepare(sql).run(...params)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    close() {
      db.close()
    },
  }
}
