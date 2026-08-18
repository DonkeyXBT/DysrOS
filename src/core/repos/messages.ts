import { createHash, randomUUID } from 'node:crypto'
import type { Db } from '../db/connection.js'
import type { ParseStatus } from '../types.js'

export type { ParseStatus }

export interface StoredMessage {
  id: string
  accountId: string
  uid: number
  folder: string
  messageId: string | null
  contentHash: string
  fromAddress: string
  fromName: string | null
  subject: string
  receivedAt: string
  rawPath: string
  bodyPreview: string
  parseStatus: ParseStatus
  parserId: string | null
  parsedAt: string | null
}

export type NewMessage = Omit<
  StoredMessage,
  'id' | 'parseStatus' | 'parserId' | 'parsedAt'
>

interface MessageRow {
  id: string
  account_id: string
  uid: number
  folder: string
  message_id: string | null
  content_hash: string
  from_address: string
  from_name: string | null
  subject: string
  received_at: string
  raw_path: string
  body_preview: string
  parse_status: ParseStatus
  parser_id: string | null
  parsed_at: string | null
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    accountId: row.account_id,
    uid: row.uid,
    folder: row.folder,
    messageId: row.message_id,
    contentHash: row.content_hash,
    fromAddress: row.from_address,
    fromName: row.from_name,
    subject: row.subject,
    receivedAt: row.received_at,
    rawPath: row.raw_path,
    bodyPreview: row.body_preview,
    parseStatus: row.parse_status,
    parserId: row.parser_id,
    parsedAt: row.parsed_at,
  }
}

export function hashContent(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export class MessageRepo {
  constructor(private readonly db: Db) {}

  findByHash(hash: string): StoredMessage | null {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE content_hash = ?')
      .get(hash) as MessageRow | undefined
    return row ? toMessage(row) : null
  }

  upsert(message: NewMessage): StoredMessage {
    const existing = this.findByHash(message.contentHash)
    if (existing) return existing

    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO messages
          (id, account_id, uid, folder, message_id, content_hash, from_address,
           from_name, subject, received_at, raw_path, body_preview, parse_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        id,
        message.accountId,
        message.uid,
        message.folder,
        message.messageId,
        message.contentHash,
        message.fromAddress,
        message.fromName,
        message.subject,
        message.receivedAt,
        message.rawPath,
        message.bodyPreview,
      )
    return this.findByHash(message.contentHash)!
  }

  listByStatus(status: ParseStatus): StoredMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE parse_status = ? ORDER BY received_at DESC')
      .all(status) as MessageRow[]
    return rows.map(toMessage)
  }

  markParsed(id: string, parserId: string, at: string): void {
    this.db
      .prepare(
        "UPDATE messages SET parse_status = 'parsed', parser_id = ?, parsed_at = ? WHERE id = ?",
      )
      .run(parserId, at, id)
  }

  markUnrecognized(id: string): void {
    this.db
      .prepare("UPDATE messages SET parse_status = 'unrecognized' WHERE id = ?")
      .run(id)
  }
}
