import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../db/connection.js'
import { migrate } from '../db/migrations.js'
import { MessageRepo, hashContent } from './messages.js'
import { EventRepo, eventId, type ParsedEvent } from './events.js'

let db: Db
let events: EventRepo
let messageId: string

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db)
  db.prepare(
    `INSERT INTO accounts (id, label, email, provider, host, port, username, secret_cipher, created_at)
     VALUES ('acc1', 'Main', 'a@example.com', 'custom', 'imap.example.com', 993, 'a@example.com', 'x', '2026-08-18T10:00:00Z')`,
  ).run()
  const messages = new MessageRepo(db)
  messageId = messages.upsert({
    accountId: 'acc1',
    uid: 1,
    folder: 'INBOX',
    messageId: '<o1@nike.com>',
    contentHash: hashContent('one'),
    fromAddress: 'orders@nike.com',
    fromName: 'Nike',
    subject: 'Order confirmed',
    receivedAt: '2026-08-18T10:00:00Z',
    rawPath: 'mail/1.eml',
    bodyPreview: '',
  }).id
  events = new EventRepo(db)
})

function orderEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    type: 'order_placed',
    retailer: 'nike',
    externalOrderId: 'C012345678',
    occurredAt: '2026-08-18T09:55:00Z',
    payload: { totalMinor: 22000, currency: 'EUR' },
    ...overrides,
  }
}

describe('eventId', () => {
  it('is deterministic for the same inputs', () => {
    expect(eventId('m1', 'nike-order', 0)).toBe(eventId('m1', 'nike-order', 0))
  })

  it('differs by ordinal and by parser', () => {
    expect(eventId('m1', 'nike-order', 0)).not.toBe(eventId('m1', 'nike-order', 1))
    expect(eventId('m1', 'nike-order', 0)).not.toBe(eventId('m1', 'nike-ship', 0))
  })
})

describe('EventRepo.replaceForMessage', () => {
  it('stores parsed events with deterministic ids', () => {
    const stored = events.replaceForMessage(
      messageId, 'nike-order', [orderEvent()], '2026-08-18T10:01:00Z',
    )
    expect(stored).toHaveLength(1)
    expect(stored[0]!.id).toBe(eventId(messageId, 'nike-order', 0))
    expect(stored[0]!.payload).toEqual({ totalMinor: 22000, currency: 'EUR' })
  })

  it('replaces rather than duplicates when a parser is re-run', () => {
    events.replaceForMessage(messageId, 'nike-order', [orderEvent()], '2026-08-18T10:01:00Z')
    const corrected = events.replaceForMessage(
      messageId,
      'nike-order',
      [orderEvent({ payload: { totalMinor: 24500, currency: 'EUR' } })],
      '2026-08-18T12:00:00Z',
    )
    expect(corrected).toHaveLength(1)
    expect(events.listUnreconciled()).toHaveLength(1)
    expect(corrected[0]!.payload).toEqual({ totalMinor: 24500, currency: 'EUR' })
  })

  it('leaves another parser\'s events on the same message untouched', () => {
    events.replaceForMessage(messageId, 'nike-order', [orderEvent()], '2026-08-18T10:01:00Z')
    events.replaceForMessage(
      messageId, 'nike-ship', [orderEvent({ type: 'shipped' })], '2026-08-18T10:02:00Z',
    )
    events.replaceForMessage(messageId, 'nike-order', [orderEvent()], '2026-08-18T13:00:00Z')
    expect(events.listUnreconciled()).toHaveLength(2)
  })

  it('drops to zero events when a corrected parser extracts nothing', () => {
    events.replaceForMessage(messageId, 'nike-order', [orderEvent()], '2026-08-18T10:01:00Z')
    events.replaceForMessage(messageId, 'nike-order', [], '2026-08-18T14:00:00Z')
    expect(events.listUnreconciled()).toHaveLength(0)
  })

  it('returns multiple events in the order the parser emitted them', () => {
    const stored = events.replaceForMessage(
      messageId,
      'nike-order',
      [
        orderEvent({ payload: { line: 1 } }),
        orderEvent({ payload: { line: 2 } }),
        orderEvent({ payload: { line: 3 } }),
      ],
      '2026-08-18T10:01:00Z',
    )
    expect(stored.map((e) => e.payload)).toEqual([{ line: 1 }, { line: 2 }, { line: 3 }])
  })
})

describe('EventRepo queries', () => {
  it('finds events by retailer and order reference', () => {
    events.replaceForMessage(messageId, 'nike-order', [orderEvent()], '2026-08-18T10:01:00Z')
    expect(events.findByOrder('nike', 'C012345678')).toHaveLength(1)
    expect(events.findByOrder('nike', 'OTHER')).toHaveLength(0)
  })

  it('excludes reconciled events from the unreconciled list', () => {
    const [stored] = events.replaceForMessage(
      messageId, 'nike-order', [orderEvent()], '2026-08-18T10:01:00Z',
    )
    events.markReconciled(stored!.id, '2026-08-18T10:05:00Z')
    expect(events.listUnreconciled()).toHaveLength(0)
  })
})
