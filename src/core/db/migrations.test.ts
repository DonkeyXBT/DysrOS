import { describe, it, expect } from 'vitest'
import { openDatabase } from './connection.js'
import { migrate, currentVersion, MIGRATIONS } from './migrations.js'

function freshDb() {
  return openDatabase(':memory:')
}

describe('migration runner', () => {
  it('starts at version zero', () => {
    expect(currentVersion(freshDb())).toBe(0)
  })

  it('applies every migration and reports the final version', () => {
    const db = freshDb()
    const version = migrate(db)
    expect(version).toBe(MIGRATIONS.length)
    expect(currentVersion(db)).toBe(MIGRATIONS.length)
  })

  it('is idempotent when run twice', () => {
    const db = freshDb()
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
    expect(currentVersion(db)).toBe(MIGRATIONS.length)
  })

  it('creates every expected table', () => {
    const db = freshDb()
    migrate(db)
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => (row as { name: string }).name)
    for (const table of [
      'accounts', 'folder_cursors', 'messages', 'events',
      'purchases', 'purchase_lines', 'items', 'sales',
      'shipments', 'refunds', 'settings', 'notification_rules',
    ]) {
      expect(names).toContain(table)
    }
  })
})

describe('connection', () => {
  it('enables foreign key enforcement', () => {
    const db = freshDb()
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('rejects a row violating a foreign key', () => {
    const db = freshDb()
    migrate(db)
    expect(() =>
      db.prepare(
        "INSERT INTO folder_cursors (account_id, folder, uid_validity, last_uid) VALUES ('missing', 'INBOX', 1, 1)",
      ).run(),
    ).toThrow(/FOREIGN KEY/i)
  })
})
