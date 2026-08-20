import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../db/connection.js'
import { migrate } from '../db/migrations.js'
import { MessageRepo, hashContent } from '../repos/messages.js'
import { EventRepo, type ParsedEvent } from '../repos/events.js'
import { Reconciler } from './reconciler.js'

let db: Db
let events: EventRepo
let reconciler: Reconciler
let messageSeq = 0

const NOW = '2026-08-19T10:00:00Z'

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db)
  db.prepare(
    `INSERT INTO accounts (id, label, email, provider, host, port, username, secret_cipher, created_at)
     VALUES ('acc1', 'Main', 'a@example.com', 'custom', 'h', 993, 'u', 'x', '2026-08-01T00:00:00Z')`,
  ).run()
  events = new EventRepo(db)
  reconciler = new Reconciler(db)
  messageSeq = 0
})

/** Records an event as though a parser had produced it from a real email. */
function record(event: ParsedEvent, parserId = 'test-parser'): void {
  messageSeq += 1
  const messages = new MessageRepo(db)
  const message = messages.upsert({
    accountId: 'acc1',
    uid: messageSeq,
    folder: 'INBOX',
    messageId: `<m${messageSeq}@test>`,
    contentHash: hashContent(`message-${messageSeq}`),
    fromAddress: 'automail@bol.com',
    fromName: 'bol',
    toAddress: 'shop@example.com',
    subject: `message ${messageSeq}`,
    receivedAt: event.occurredAt,
    rawPath: `mail/${messageSeq}.eml`,
    bodyPreview: '',
  })
  events.replaceForMessage(message.id, parserId, [event], NOW)
}

function order(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    type: 'order_placed',
    retailer: 'bol',
    externalOrderId: 'C0008N401L',
    occurredAt: '2026-08-01T09:00:00Z',
    payload: {
      title: 'One Piece - Double Pack Set - Vol. 11',
      quantity: 1,
      currency: 'EUR',
      unitMinor: 1199,
      shippingMinor: 299,
      totalMinor: 1498,
      totalsConsistent: true,
    },
    ...overrides,
  }
}

function shipment(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    type: 'shipped',
    retailer: 'bol',
    externalOrderId: 'C0008N401L',
    occurredAt: '2026-08-02T09:00:00Z',
    payload: { carrier: 'dhl', direction: 'inbound', trackingNumber: null, quantity: 1 },
    ...overrides,
  }
}

function cancellation(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    type: 'cancelled',
    retailer: 'bol',
    externalOrderId: 'C0008N401L',
    occurredAt: '2026-08-03T09:00:00Z',
    payload: { title: 'One Piece - Double Pack Set - Vol. 11', refundExpected: true },
    ...overrides,
  }
}

function purchases() {
  return db.prepare('SELECT * FROM purchases').all() as Record<string, unknown>[]
}
function items() {
  return db.prepare('SELECT * FROM items ORDER BY id').all() as Record<string, unknown>[]
}
function shipments() {
  return db.prepare('SELECT * FROM shipments').all() as Record<string, unknown>[]
}
function refunds() {
  return db.prepare('SELECT * FROM refunds').all() as Record<string, unknown>[]
}

describe('order reconciliation', () => {
  it('creates a purchase and one item per unit', () => {
    record(order({ payload: { ...order().payload, quantity: 3, unitMinor: 5399, totalMinor: 16197 } }))
    reconciler.run(NOW)

    expect(purchases()).toHaveLength(1)
    expect(purchases()[0]!.total_minor).toBe(16197)
    expect(items()).toHaveLength(3)
    expect(items().every((item) => item.status === 'incoming')).toBe(true)
    expect(items().every((item) => item.cost_minor === 5399)).toBe(true)
  })

  it('marks the events it consumed as reconciled', () => {
    record(order())
    reconciler.run(NOW)
    expect(events.listUnreconciled()).toHaveLength(0)
  })

  it('is idempotent: running twice does not duplicate stock', () => {
    record(order({ payload: { ...order().payload, quantity: 2 } }))
    reconciler.run(NOW)
    reconciler.run(NOW)

    expect(purchases()).toHaveLength(1)
    expect(items()).toHaveLength(2)
  })

  it('re-running a corrected parser updates the purchase rather than adding one', () => {
    record(order())
    reconciler.run(NOW)
    // Same order, corrected total, delivered by the same parser on the same message.
    const message = db.prepare('SELECT id FROM messages LIMIT 1').get() as { id: string }
    events.replaceForMessage(
      message.id,
      'test-parser',
      [order({ payload: { ...order().payload, totalMinor: 1598 } })],
      NOW,
    )
    reconciler.run(NOW)

    expect(purchases()).toHaveLength(1)
    expect(purchases()[0]!.total_minor).toBe(1598)
  })
})

describe('shipment reconciliation', () => {
  it('creates a shipment and links it to its purchase', () => {
    record(order())
    record(shipment())
    reconciler.run(NOW)

    expect(shipments()).toHaveLength(1)
    expect(shipments()[0]!.carrier).toBe('dhl')
    expect(shipments()[0]!.purchase_id).toBe(purchases()[0]!.id)
  })

  it('accepts a shipping notice that arrives before its order confirmation', () => {
    record(shipment())
    reconciler.run(NOW)

    // The shipment is real and worth showing even with no order yet.
    expect(shipments()).toHaveLength(1)
    expect(shipments()[0]!.purchase_id).toBeNull()

    record(order())
    reconciler.run(NOW)

    // Once the order arrives the existing shipment is linked, not duplicated.
    expect(shipments()).toHaveLength(1)
    expect(shipments()[0]!.purchase_id).toBe(purchases()[0]!.id)
  })

  it('does not duplicate a shipment when reconciled repeatedly', () => {
    record(order())
    record(shipment())
    reconciler.run(NOW)
    reconciler.run(NOW)
    expect(shipments()).toHaveLength(1)
  })
})

describe('cancellation reconciliation', () => {
  it('reverses the unit it names rather than deleting anything', () => {
    record(order({ payload: { ...order().payload, quantity: 2 } }))
    record(cancellation())
    reconciler.run(NOW)

    // A cancellation of one article out of two leaves the other standing: an
    // order of two where one was cancelled is still an order of one.
    expect(items()).toHaveLength(2)
    expect(items().filter((item) => item.status === 'cancelled')).toHaveLength(1)
    expect(purchases()[0]!.status).toBe('partly_cancelled')
  })

  it('cancels the whole order when the mail names every unit of it', () => {
    record(order({ payload: { ...order().payload, quantity: 2 } }))
    record(cancellation({ payload: { ...cancellation().payload, quantity: 2 } }))
    reconciler.run(NOW)

    expect(items().every((item) => item.status === 'cancelled')).toBe(true)
    expect(purchases()[0]!.status).toBe('cancelled')
  })

  it('books an expected refund for the amount actually paid', () => {
    record(order())
    record(cancellation())
    reconciler.run(NOW)

    expect(refunds()).toHaveLength(1)
    expect(refunds()[0]!.amount_minor).toBe(1498)
    expect(refunds()[0]!.received_at).toBeNull()
  })

  it('holds a cancellation with no matching order as unreconciled', () => {
    record(cancellation({ externalOrderId: 'C000UNKNOWN' }))
    reconciler.run(NOW)

    // Nothing to cancel yet, and the amount is unknowable from this mail alone,
    // so it waits for the order rather than guessing.
    expect(refunds()).toHaveLength(0)
    expect(events.listUnreconciled()).toHaveLength(1)
  })

  it('applies a held cancellation once its order finally arrives', () => {
    record(cancellation())
    reconciler.run(NOW)
    expect(events.listUnreconciled()).toHaveLength(1)

    record(order())
    reconciler.run(NOW)

    expect(items().every((item) => item.status === 'cancelled')).toBe(true)
    expect(refunds()).toHaveLength(1)
    expect(events.listUnreconciled()).toHaveLength(0)
  })
})

describe('delivery reconciliation', () => {
  it('moves items into stock on delivery', () => {
    record(order())
    record({
      type: 'delivered',
      retailer: 'bol',
      externalOrderId: 'C0008N401L',
      occurredAt: '2026-08-04T09:00:00Z',
      payload: {},
    })
    reconciler.run(NOW)

    expect(items()[0]!.status).toBe('in_stock')
  })

  it('does not resurrect a cancelled item', () => {
    record(order())
    record(cancellation())
    record({
      type: 'delivered',
      retailer: 'bol',
      externalOrderId: 'C0008N401L',
      occurredAt: '2026-08-05T09:00:00Z',
      payload: {},
    })
    reconciler.run(NOW)

    expect(items()[0]!.status).toBe('cancelled')
  })
})

describe('run reporting', () => {
  it('reports what it applied and what it held back', () => {
    record(order())
    record(cancellation({ externalOrderId: 'C000UNKNOWN' }))
    const result = reconciler.run(NOW)

    expect(result.applied).toBe(1)
    expect(result.held).toBe(1)
  })
})
