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

describe('v5 repairs tracking codes that swallowed the postcode', () => {
  /** A database as it stood before v5, which is what a real upgrade starts from. */
  function atVersion4() {
    const db = openDatabase(':memory:')
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
    for (const migration of MIGRATIONS.filter((m) => m.version <= 4)) {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
    }
    return db
  }

  function shipment(db: ReturnType<typeof openDatabase>, id: string, code: string) {
    db.prepare(
      `INSERT INTO shipments (id, direction, carrier, tracking_number, status, created_at)
       VALUES (?, 'inbound', 'dhl', ?, 'in_transit', '2026-08-19T00:00:00.000Z')`,
    ).run(id, code)
  }

  it('cuts the barcode back and keeps the postcode', () => {
    const db = atVersion4()
    shipment(db, 'a', 'JVGL0637312004304176/3043LC')

    migrate(db)

    expect(db.prepare("SELECT tracking_number, postal_code FROM shipments WHERE id = 'a'").get())
      .toEqual({ tracking_number: 'JVGL0637312004304176', postal_code: '3043LC' })
  })

  it('folds a row that turns out to repeat a parcel already recorded', () => {
    const db = atVersion4()
    shipment(db, 'a', 'JVGL0637312004304176')
    shipment(db, 'b', 'JVGL0637312004304176/3043LC')

    expect(() => migrate(db)).not.toThrow()
    expect(db.prepare('SELECT id FROM shipments').all()).toEqual([{ id: 'a' }])
  })

  it('leaves a well-formed barcode alone', () => {
    const db = atVersion4()
    shipment(db, 'a', 'JVGL0627463317265600')

    migrate(db)

    expect(db.prepare("SELECT tracking_number, postal_code FROM shipments WHERE id = 'a'").get())
      .toEqual({ tracking_number: 'JVGL0627463317265600', postal_code: null })
  })

  it('leaves a parcel with no barcode yet alone', () => {
    const db = atVersion4()
    db.prepare(
      `INSERT INTO shipments (id, direction, carrier, tracking_number, status, created_at)
       VALUES ('a', 'inbound', 'dhl', NULL, 'pending', '2026-08-19T00:00:00.000Z')`,
    ).run()

    migrate(db)

    expect(db.prepare("SELECT tracking_number FROM shipments WHERE id = 'a'").get())
      .toEqual({ tracking_number: null })
  })
})

describe('v10 treats what was already collected as already said', () => {
  it('marks existing events as announced, so an upgrade is not a burst', () => {
    const db = openDatabase(':memory:')
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
    for (const migration of MIGRATIONS.filter((m) => m.version <= 9)) {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
    }
    db.prepare(
      `INSERT INTO accounts (id, label, email, provider, host, port, username, secret_cipher, created_at)
       VALUES ('local-import','Imported files','local@import','custom','',0,'','','2026-08-01T00:00:00.000Z')`,
    ).run()
    db.prepare(
      `INSERT INTO messages (id, account_id, uid, folder, message_id, content_hash, from_address,
                             from_name, subject, received_at, raw_path, parse_status, parser_id)
       VALUES ('m1','local-import',0,'IMPORT','<a>','hash-1','automail@bol.com','bol','Verzonden',
               '2026-08-01T00:00:00.000Z','','parsed','bol')`,
    ).run()
    db.prepare(
      `INSERT INTO events (id, message_id, parser_id, type, retailer, external_order_id,
                           occurred_at, payload_json, created_at)
       VALUES ('e1','m1','bol','shipped','bol','C1','2026-08-01T00:00:00.000Z','{}','2026-08-01T00:00:00.000Z')`,
    ).run()

    migrate(db)

    expect(db.prepare('SELECT COUNT(*) AS n FROM notifications_sent').get()).toEqual({ n: 1 })
  })
})
