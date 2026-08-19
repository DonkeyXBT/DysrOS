import type { Db } from './connection.js'
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6, SCHEMA_V7, SCHEMA_V8, SCHEMA_V9, SCHEMA_V10, SCHEMA_V11, SCHEMA_V12 } from './schema.sql.js'

export const MIGRATIONS: readonly { version: number; sql: string }[] = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
  { version: 3, sql: SCHEMA_V3 },
  { version: 4, sql: SCHEMA_V4 },
  { version: 5, sql: SCHEMA_V5 },
  { version: 6, sql: SCHEMA_V6 },
  { version: 7, sql: SCHEMA_V7 },
  { version: 8, sql: SCHEMA_V8 },
  { version: 9, sql: SCHEMA_V9 },
  { version: 10, sql: SCHEMA_V10 },
  { version: 11, sql: SCHEMA_V11 },
  { version: 12, sql: SCHEMA_V12 },
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
