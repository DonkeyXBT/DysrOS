import type { Db } from './connection.js'
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3 } from './schema.sql.js'

export const MIGRATIONS: readonly { version: number; sql: string }[] = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
  { version: 3, sql: SCHEMA_V3 },
]

function ensureVersionTable(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
}

export function currentVersion(db: Db): number {
  ensureVersionTable(db)
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
    | { version: number | null }
    | undefined
  return row?.version ?? 0
}

export function migrate(db: Db): number {
  ensureVersionTable(db)
  const from = currentVersion(db)
  const pending = MIGRATIONS.filter((m) => m.version > from)
  const apply = db.transaction(() => {
    for (const migration of pending) {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
    }
  })
  apply()
  return currentVersion(db)
}
