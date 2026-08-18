import { createHash } from 'node:crypto'
import type { Db } from '../db/connection.js'
import type { EventType } from '../types.js'

export interface ParsedEvent {
  type: EventType
  retailer: string
  externalOrderId: string | null
  occurredAt: string
  payload: Record<string, unknown>
}

export interface StoredEvent extends ParsedEvent {
  id: string
  messageId: string
  parserId: string
  reconciledAt: string | null
}

interface EventRow {
  id: string
  message_id: string
  parser_id: string
  type: EventType
  retailer: string
  external_order_id: string | null
  occurred_at: string
  payload_json: string
  reconciled_at: string | null
}

function toEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    messageId: row.message_id,
    parserId: row.parser_id,
    type: row.type,
    retailer: row.retailer,
    externalOrderId: row.external_order_id,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    reconciledAt: row.reconciled_at,
  }
}

export function eventId(messageId: string, parserId: string, ordinal: number): string {
  return createHash('sha256')
    .update(`${messageId} ${parserId} ${ordinal}`)
    .digest('hex')
}

export class EventRepo {
  constructor(private readonly db: Db) {}

  replaceForMessage(
    messageId: string,
    parserId: string,
    events: ParsedEvent[],
    now: string,
  ): StoredEvent[] {
    const stored: StoredEvent[] = events.map((event, ordinal) => ({
      ...event,
      id: eventId(messageId, parserId, ordinal),
      messageId,
      parserId,
      reconciledAt: null,
    }))

    const run = this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM events WHERE message_id = ? AND parser_id = ?')
        .run(messageId, parserId)

      const insert = this.db.prepare(
        `INSERT INTO events
          (id, message_id, parser_id, type, retailer, external_order_id,
           occurred_at, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const event of stored) {
        insert.run(
          event.id,
          messageId,
          parserId,
          event.type,
          event.retailer,
          event.externalOrderId,
          event.occurredAt,
          JSON.stringify(event.payload),
          now,
        )
      }
    })
    run()

    // Returned in the order the parser emitted them. Re-querying would order by
    // hashed id, which is arbitrary once a parser emits more than one event.
    return stored
  }

  listUnreconciled(): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE reconciled_at IS NULL ORDER BY occurred_at')
      .all() as EventRow[]
    return rows.map(toEvent)
  }

  findByOrder(retailer: string, externalOrderId: string): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE retailer = ? AND external_order_id = ? ORDER BY occurred_at')
      .all(retailer, externalOrderId) as EventRow[]
    return rows.map(toEvent)
  }

  markReconciled(id: string, at: string): void {
    this.db.prepare('UPDATE events SET reconciled_at = ? WHERE id = ?').run(at, id)
  }
}
