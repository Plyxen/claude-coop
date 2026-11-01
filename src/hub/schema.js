// The hub's tables. Every CREATE is idempotent. migrate() runs on startup (Node)
// or on the first request of each isolate (Cloudflare), and only does work when
// the stored schema version is behind.
export const SCHEMA_VERSION = 2

const MEMBERS = (table) => `CREATE TABLE IF NOT EXISTS ${table} (
    name TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('lead', 'worker', 'observer')),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen TEXT,
    revoked INTEGER NOT NULL DEFAULT 0
  )`

export const SCHEMA = [
  MEMBERS('members'),
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    assignee TEXT,
    created_by TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    scope TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    pr_url TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    actor TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    target TEXT,
    task_id INTEGER,
    text TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}'
  )`,
  // One row per credential, so a member can have several devices and each can
  // be revoked alone. Only hashes are stored.
  `CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    member TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS permission_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker TEXT NOT NULL,
    request_id TEXT NOT NULL,
    tool_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    input_preview TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL DEFAULT '',
    task_id INTEGER,
    risk TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT,
    decided_via TEXT,
    UNIQUE (worker, request_id)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    actor TEXT,
    actor_role TEXT,
    target TEXT,
    request_id TEXT,
    source TEXT,
    result TEXT NOT NULL DEFAULT 'ok',
    detail TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS request_log (
    member TEXT NOT NULL,
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status INTEGER,
    response TEXT,
    PRIMARY KEY (member, request_id)
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_target ON events (target, id)`,
  `CREATE INDEX IF NOT EXISTS events_task ON events (task_id, id)`,
  `CREATE INDEX IF NOT EXISTS events_ts ON events (ts)`,
  `CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status, id)`,
  `CREATE INDEX IF NOT EXISTS tokens_member ON tokens (member)`,
  `CREATE INDEX IF NOT EXISTS permission_status ON permission_requests (status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS audit_type ON audit_log (type, id)`,
  `CREATE INDEX IF NOT EXISTS audit_ts ON audit_log (ts)`,
]

async function storedVersion(db) {
  try {
    return Number((await db.get("SELECT value FROM settings WHERE key = 'schema_version'"))?.value) || 0
  } catch {
    return 0
  }
}

export async function migrate(db) {
  if ((await storedVersion(db)) >= SCHEMA_VERSION) return
  for (const statement of SCHEMA) await db.run(statement)
  // Version 2 allows the observer role, which SQLite can only do by rebuilding
  // the table, and moves token hashes to their own table. Existing tokens keep
  // working with no expiry. All of it commits together, or none of it does.
  await db.batch([
    ['DROP TABLE IF EXISTS members_v2'],
    [MEMBERS('members_v2')],
    ['INSERT INTO members_v2 (name, role, token_hash, created_at, last_seen, revoked) SELECT name, role, token_hash, created_at, last_seen, revoked FROM members'],
    [
      `INSERT OR IGNORE INTO tokens (id, member, token_hash, label, created_at, created_by)
       SELECT 'tok_' || lower(hex(randomblob(8))), name, token_hash, 'migrated', created_at, 'migration' FROM members_v2
       WHERE revoked = 0 AND token_hash NOT LIKE '%:%'`,
    ],
    ["UPDATE members_v2 SET token_hash = 'member:' || name"],
    ['DROP TABLE members'],
    ['ALTER TABLE members_v2 RENAME TO members'],
    ["INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(SCHEMA_VERSION)]],
  ])
}
