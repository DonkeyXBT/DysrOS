import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/connection.js'
import { migrate } from '../db/migrations.js'
import { findParcel, foldShipment, furthestStatus, mergeInto } from './shipment-merge.js'

function db() {
  const database = openDatabase(':memory:')
  migrate(database)
  return database
}

function shipment(
  database: ReturnType<typeof db>,
  id: string,
  fields: Partial<Record<string, string | null>> = {},
) {
  database.prepare(
    `INSERT INTO shipments (id, direction, carrier, tracking_number, tracking_url, status,
                            purchase_id, expected_delivery_at, created_at)
     VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?, '2026-08-19T00:00:00.000Z')`,
  ).run(
    id,
    fields.carrier ?? 'dhl',
    fields.tracking_number ?? null,
    fields.tracking_url ?? null,
    fields.status ?? 'pending',
    fields.purchase_id ?? null,
    fields.expected_delivery_at ?? null,
  )
}

describe('furthestStatus', () => {
  it('moves a parcel forward, never back', () => {
    expect(furthestStatus('in_transit', 'out_for_delivery')).toBe('out_for_delivery')
    expect(furthestStatus('delivered', 'in_transit')).toBe('delivered')
    expect(furthestStatus('pending', null)).toBe('pending')
  })
})

describe('findParcel', () => {
  it('finds the row already holding a barcode', () => {
    const database = db()
    shipment(database, 'first', { tracking_number: 'JVGL1' })
    expect(findParcel(database, 'dhl', 'JVGL1', 'second')).toBe('first')
  })

  it('does not find the asking row itself', () => {
    const database = db()
    shipment(database, 'first', { tracking_number: 'JVGL1' })
    expect(findParcel(database, 'dhl', 'JVGL1', 'first')).toBeNull()
  })

  it('treats the same barcode at another carrier as another parcel', () => {
    const database = db()
    shipment(database, 'first', { tracking_number: 'JVGL1' })
    expect(findParcel(database, 'postnl', 'JVGL1', 'second')).toBeNull()
  })
})

describe('folding a duplicate into the parcel it repeats', () => {
  it('leaves one row holding what both knew', () => {
    const database = db()
    shipment(database, 'first', {
      tracking_number: 'JVGL1', status: 'in_transit', purchase_id: null,
    })
    database.prepare("INSERT INTO purchases (id, retailer, ordered_at, currency, created_at) VALUES ('p1','bol','2026-08-01','EUR','2026-08-01')").run()
    shipment(database, 'second', {
      status: 'out_for_delivery', purchase_id: 'p1', expected_delivery_at: '2026-08-19',
    })

    foldShipment(database, 'second', 'first')

    const rows = database.prepare('SELECT * FROM shipments').all() as Record<string, string>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'first',
      tracking_number: 'JVGL1',
      status: 'out_for_delivery',
      purchase_id: 'p1',
      expected_delivery_at: '2026-08-19',
    })
  })

  it('does not let a later mail undo what an earlier one settled', () => {
    const database = db()
    shipment(database, 'first', { tracking_number: 'JVGL1', status: 'delivered' })
    shipment(database, 'second', { status: 'in_transit' })

    foldShipment(database, 'second', 'first')

    const row = database.prepare("SELECT status FROM shipments WHERE id = 'first'").get() as { status: string }
    expect(row.status).toBe('delivered')
  })

  it('keeps a tracking link it already has rather than blanking it', () => {
    const database = db()
    shipment(database, 'first', { tracking_number: 'JVGL1', tracking_url: 'https://my.dhlecommerce.nl/x' })
    mergeInto(database, 'first', { trackingUrl: null })

    const row = database.prepare("SELECT tracking_url FROM shipments WHERE id = 'first'").get() as { tracking_url: string }
    expect(row.tracking_url).toBe('https://my.dhlecommerce.nl/x')
  })

  it('is a no-op when the row to fold has already gone', () => {
    const database = db()
    shipment(database, 'first', { tracking_number: 'JVGL1' })
    expect(() => foldShipment(database, 'missing', 'first')).not.toThrow()
    expect(database.prepare('SELECT COUNT(*) AS n FROM shipments').get()).toEqual({ n: 1 })
  })
})
