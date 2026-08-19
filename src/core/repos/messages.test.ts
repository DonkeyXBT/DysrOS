import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../db/connection.js'
import { migrate } from '../db/migrations.js'
import { MessageRepo, hashContent, type NewMessage } from './messages.js'

let db: Db
let repo: MessageRepo

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db)
  db.prepare(
    `INSERT INTO accounts (id, label, email, provider, host, port, username, secret_cipher, created_at)
     VALUES ('acc1', 'Main', 'a@example.com', 'custom', 'imap.example.com', 993, 'a@example.com', 'x', '2026-08-18T10:00:00Z')`,
  ).run()
  repo = new MessageRepo(db)
})

function sample(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    accountId: 'acc1',
    uid: 42,
    folder: 'INBOX',
    messageId: '<order-1@nike.com>',
    contentHash: hashContent('raw email body one'),
    fromAddress: 'orders@nike.com',
    fromName: 'Nike',
    toAddress: 'shop@example.com',
    subject: 'Your order is confirmed',
    receivedAt: '2026-08-18T10:00:00Z',
    rawPath: 'mail/acc1/42.eml',
    bodyPreview: 'Thanks for your order',
    ...overrides,
  }
}

describe('hashContent', () => {
  it('is stable and differs for different content', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'))
    expect(hashContent('abc')).not.toBe(hashContent('abd'))
  })
})

describe('MessageRepo.upsert', () => {
  it('stores a message and assigns an id', () => {
    const stored = repo.upsert(sample())
    expect(stored.id).toBeTruthy()
    expect(stored.subject).toBe('Your order is confirmed')
    expect(stored.parseStatus).toBe('pending')
  })

  it('deduplicates the same email delivered to two accounts', () => {
    const first = repo.upsert(sample())
    const second = repo.upsert(sample({ uid: 77 }))
    expect(second.id).toBe(first.id)
    expect(repo.listByStatus('pending')).toHaveLength(1)
  })

  it('does not reset parse status when the same message is seen again', () => {
    const first = repo.upsert(sample())
    repo.markParsed(first.id, 'nike-order', '2026-08-18T11:00:00Z')
    const again = repo.upsert(sample({ uid: 78 }))
    expect(again.parseStatus).toBe('parsed')
    expect(again.parserId).toBe('nike-order')
  })
})

describe('MessageRepo status transitions', () => {
  it('lists unrecognized messages for the review queue', () => {
    const a = repo.upsert(sample())
    const b = repo.upsert(sample({ contentHash: hashContent('two'), subject: 'Mystery' }))
    repo.markParsed(a.id, 'nike-order', '2026-08-18T11:00:00Z')
    repo.markUnrecognized(b.id)

    const queue = repo.listByStatus('unrecognized')
    expect(queue).toHaveLength(1)
    expect(queue[0]!.subject).toBe('Mystery')
  })

  it('finds a message by content hash', () => {
    const stored = repo.upsert(sample())
    expect(repo.findByHash(stored.contentHash)?.id).toBe(stored.id)
    expect(repo.findByHash('nope')).toBeNull()
  })
})
