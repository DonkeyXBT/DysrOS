import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../db/connection.js'
import { migrate } from '../db/migrations.js'
import { MailboxSync, type MailboxClient, type MailboxMessage } from './ingest.js'

let db: Db
let sync: MailboxSync

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db)
  db.prepare(
    `INSERT INTO accounts (id, label, email, provider, host, port, username, secret_cipher, created_at)
     VALUES ('acc1', 'Main', 'a@example.com', 'gmail', 'imap.gmail.com', 993, 'a@example.com', 'x', '2026-08-01T00:00:00Z')`,
  ).run()
  sync = new MailboxSync(db)
})

/** A mailbox whose contents and UIDVALIDITY the test controls. */
function fakeMailbox(options: {
  uidValidity: number
  messages: MailboxMessage[]
  onFetch?: (afterUid: number) => void
  /** Lowest UID inside the lookback window, as a date search would report. */
  firstRecentUid?: number | null
  onSearch?: (since: Date) => void
}): MailboxClient & { closed: boolean } {
  return {
    closed: false,
    async connect() {},
    async openFolder() {
      return { uidValidity: options.uidValidity }
    },
    async firstUidSince(since: Date) {
      options.onSearch?.(since)
      return options.firstRecentUid === undefined ? 1 : options.firstRecentUid
    },
    async fetchSince(afterUid, limit) {
      options.onFetch?.(afterUid)
      return options.messages.filter((m) => m.uid > afterUid).slice(0, limit)
    },
    async close() {
      this.closed = true
    },
  }
}

function msg(uid: number, body = `body-${uid}`): MailboxMessage {
  return { uid, raw: Buffer.from(body, 'utf8') }
}

/** Records what the sink saw; treats a repeated body as a duplicate. */
function recordingSink() {
  const seen = new Set<string>()
  const calls: { uid: number; folder: string }[] = []
  return {
    calls,
    sink: async (message: { uid: number; folder: string; raw: Buffer }) => {
      calls.push({ uid: message.uid, folder: message.folder })
      const key = message.raw.toString('utf8')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    },
  }
}

describe('first sync', () => {
  it('fetches from the beginning and records the cursor', async () => {
    const mailbox = fakeMailbox({ uidValidity: 100, messages: [msg(1), msg(2), msg(3)] })
    const { sink, calls } = recordingSink()

    const result = await sync.sync('acc1', 'INBOX', mailbox, sink)

    expect(result.fetched).toBe(3)
    expect(result.stored).toBe(3)
    expect(result.lastUid).toBe(3)
    expect(calls.map((c) => c.uid)).toEqual([1, 2, 3])
    expect(sync.readCursor('acc1', 'INBOX')).toEqual({ uidValidity: 100, lastUid: 3 })
  })

  it('closes the connection even when the sink throws', async () => {
    const mailbox = fakeMailbox({ uidValidity: 100, messages: [msg(1)] })
    const failing = async () => {
      throw new Error('disk full')
    }

    await expect(sync.sync('acc1', 'INBOX', mailbox, failing)).rejects.toThrow('disk full')
    expect(mailbox.closed).toBe(true)
  })
})

describe('incremental sync', () => {
  it('asks only for messages after the stored cursor', async () => {
    let askedFor = -1
    const mailbox = fakeMailbox({
      uidValidity: 100,
      messages: [msg(1), msg(2), msg(3), msg(4)],
      onFetch: (afterUid) => {
        askedFor = afterUid
      },
    })
    const { sink } = recordingSink()

    await sync.sync('acc1', 'INBOX', mailbox, sink)
    const second = await sync.sync('acc1', 'INBOX', mailbox, sink)

    expect(askedFor).toBe(4)
    expect(second.fetched).toBe(0)
    expect(second.lastUid).toBe(4)
  })

  it('never re-reads the whole mailbox on restart', async () => {
    const mailbox = fakeMailbox({ uidValidity: 100, messages: [msg(1), msg(2)] })
    const { sink, calls } = recordingSink()

    await sync.sync('acc1', 'INBOX', mailbox, sink)
    await sync.sync('acc1', 'INBOX', mailbox, sink)
    await sync.sync('acc1', 'INBOX', mailbox, sink)

    expect(calls).toHaveLength(2)
  })

  it('picks up mail that arrives between syncs', async () => {
    const messages = [msg(1), msg(2)]
    const mailbox = fakeMailbox({ uidValidity: 100, messages })
    const { sink } = recordingSink()

    await sync.sync('acc1', 'INBOX', mailbox, sink)
    messages.push(msg(3), msg(4))
    const second = await sync.sync('acc1', 'INBOX', mailbox, sink)

    expect(second.fetched).toBe(2)
    expect(second.lastUid).toBe(4)
  })
})

describe('UIDVALIDITY change', () => {
  it('restarts the cursor when the server renumbers the mailbox', async () => {
    const { sink } = recordingSink()
    await sync.sync('acc1', 'INBOX', fakeMailbox({ uidValidity: 100, messages: [msg(1), msg(2)] }), sink)

    // Same messages, renumbered under a new UIDVALIDITY.
    const renumbered = fakeMailbox({
      uidValidity: 200,
      messages: [msg(11, 'body-1'), msg(12, 'body-2')],
    })
    const result = await sync.sync('acc1', 'INBOX', renumbered, sink)

    expect(result.uidValidityReset).toBe(true)
    expect(result.fetched).toBe(2)
    // Re-read, but content hashing means nothing new is stored.
    expect(result.stored).toBe(0)
    expect(result.duplicates).toBe(2)
    expect(sync.readCursor('acc1', 'INBOX')).toEqual({ uidValidity: 200, lastUid: 12 })
  })

  it('does not report a reset on an ordinary sync', async () => {
    const mailbox = fakeMailbox({ uidValidity: 100, messages: [msg(1)] })
    const { sink } = recordingSink()
    const result = await sync.sync('acc1', 'INBOX', mailbox, sink)
    expect(result.uidValidityReset).toBe(false)
  })
})

describe('multiple folders and accounts', () => {
  it('keeps a separate cursor per folder', async () => {
    const { sink } = recordingSink()
    await sync.sync('acc1', 'INBOX', fakeMailbox({ uidValidity: 100, messages: [msg(1), msg(2)] }), sink)
    await sync.sync('acc1', 'Archive', fakeMailbox({ uidValidity: 500, messages: [msg(9)] }), sink)

    expect(sync.readCursor('acc1', 'INBOX')).toEqual({ uidValidity: 100, lastUid: 2 })
    expect(sync.readCursor('acc1', 'Archive')).toEqual({ uidValidity: 500, lastUid: 9 })
  })

  it('has no cursor for a folder never synced', () => {
    expect(sync.readCursor('acc1', 'Spam')).toBeNull()
  })
})

describe('batching', () => {
  it('honours the fetch limit so a huge mailbox syncs in chunks', async () => {
    const messages = Array.from({ length: 50 }, (_, i) => msg(i + 1))
    const mailbox = fakeMailbox({ uidValidity: 100, messages })
    const { sink } = recordingSink()

    const first = await sync.sync('acc1', 'INBOX', mailbox, sink, { limit: 20 })
    expect(first.fetched).toBe(20)
    expect(first.lastUid).toBe(20)

    const second = await sync.sync('acc1', 'INBOX', mailbox, sink, { limit: 20 })
    expect(second.lastUid).toBe(40)
  })
})

describe('first sync window', () => {
  it('starts at the first recent message, not at the oldest in the mailbox', async () => {
    // A real mailbox: thousands of old messages, a handful of recent ones.
    const messages = Array.from({ length: 30 }, (_, i) => msg(i + 1))
    let askedFor = -1
    const mailbox = fakeMailbox({
      uidValidity: 100,
      messages,
      firstRecentUid: 28,
      onFetch: (afterUid) => {
        askedFor = afterUid
      },
    })
    const { sink, calls } = recordingSink()

    const result = await sync.sync('acc1', 'INBOX', mailbox, sink, { limit: 10 })

    expect(askedFor).toBe(27)
    expect(calls.map((c) => c.uid)).toEqual([28, 29, 30])
    expect(result.startedFresh).toBe(true)
  })

  it('falls back to the whole folder when nothing is inside the window', async () => {
    const mailbox = fakeMailbox({
      uidValidity: 100,
      messages: [msg(1), msg(2)],
      firstRecentUid: null,
    })
    const { sink } = recordingSink()

    const result = await sync.sync('acc1', 'INBOX', mailbox, sink)
    expect(result.fetched).toBe(2)
  })

  it('uses the cursor rather than the window on later syncs', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(i + 1))
    let askedFor = -1
    const mailbox = fakeMailbox({
      uidValidity: 100,
      messages,
      firstRecentUid: 28,
      onFetch: (afterUid) => {
        askedFor = afterUid
      },
    })
    const { sink } = recordingSink()

    await sync.sync('acc1', 'INBOX', mailbox, sink)
    messages.push(msg(31))
    const second = await sync.sync('acc1', 'INBOX', mailbox, sink)

    expect(askedFor).toBe(30)
    expect(second.startedFresh).toBe(false)
    expect(second.fetched).toBe(1)
  })
})

describe('lookback window', () => {
  it('asks the server for one week of mail on a first sync', async () => {
    let searchedSince: Date | null = null
    const mailbox = fakeMailbox({
      uidValidity: 100,
      messages: [msg(1)],
      onSearch: (since) => {
        searchedSince = since
      },
    })
    const { sink } = recordingSink()

    await sync.sync('acc1', 'INBOX', mailbox, sink)

    const days = (Date.now() - searchedSince!.getTime()) / 86_400_000
    // A busy mailbox holds thousands of messages a month; a first run that
    // grinds through them all reads as broken.
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThan(7.1)
  })

  it('honours an explicit window when one is given', async () => {
    let searchedSince: Date | null = null
    const mailbox = fakeMailbox({
      uidValidity: 100,
      messages: [msg(1)],
      onSearch: (since) => {
        searchedSince = since
      },
    })
    const { sink } = recordingSink()

    await sync.sync('acc1', 'INBOX', mailbox, sink, { initialLookbackDays: 60 })

    const days = (Date.now() - searchedSince!.getTime()) / 86_400_000
    expect(days).toBeGreaterThan(59.9)
  })

  it('does not search by date once a cursor exists', async () => {
    let searches = 0
    const messages = [msg(1), msg(2)]
    const mailbox = fakeMailbox({
      uidValidity: 100,
      messages,
      onSearch: () => {
        searches += 1
      },
    })
    const { sink } = recordingSink()

    await sync.sync('acc1', 'INBOX', mailbox, sink)
    messages.push(msg(3))
    await sync.sync('acc1', 'INBOX', mailbox, sink)

    // The second run resumes from the cursor, so the window is irrelevant.
    expect(searches).toBe(1)
  })
})

describe('draining a mailbox', () => {
  it('keeps fetching until the folder is exhausted, not just one batch', async () => {
    const messages = Array.from({ length: 500 }, (_, i) => msg(i + 1))
    const asked: number[] = []
    const mailbox = fakeMailbox({
      uidValidity: 100,
      messages,
      onFetch: (afterUid) => asked.push(afterUid),
    })
    const { sink } = recordingSink()

    const result = await sync.sync('acc1', 'INBOX', mailbox, sink, { limit: 5000, batchSize: 200 })

    // Three batches of 200, 200 and 100 — the whole mailbox, in one run.
    expect(asked).toEqual([0, 200, 400])
    expect(result.fetched).toBe(500)
    expect(result.lastUid).toBe(500)
    expect(result.remaining).toBe(false)
  })

  it('says so when it stops at the ceiling with mail still waiting', async () => {
    const messages = Array.from({ length: 60 }, (_, i) => msg(i + 1))
    const mailbox = fakeMailbox({ uidValidity: 100, messages })
    const { sink } = recordingSink()

    const first = await sync.sync('acc1', 'INBOX', mailbox, sink, { limit: 40, batchSize: 20 })
    expect(first.fetched).toBe(40)
    expect(first.remaining).toBe(true)

    // The next run carries on from where that one stopped.
    const second = await sync.sync('acc1', 'INBOX', mailbox, sink, { limit: 40, batchSize: 20 })
    expect(second.fetched).toBe(20)
    expect(second.remaining).toBe(false)
    expect(second.lastUid).toBe(60)
  })

  it('records the cursor after each batch so an interrupted run keeps its place', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(i + 1))
    const mailbox = fakeMailbox({ uidValidity: 100, messages })
    let handled = 0
    const sink = async () => {
      handled += 1
      // Fails part way through the second batch, as a dropped connection would.
      if (handled > 15) throw new Error('connection reset')
      return true
    }

    await expect(
      sync.sync('acc1', 'INBOX', mailbox, sink, { limit: 5000, batchSize: 10 }),
    ).rejects.toThrow('connection reset')

    // The first ten are kept; the run resumes there rather than from the start.
    expect(sync.readCursor('acc1', 'INBOX')).toEqual({ uidValidity: 100, lastUid: 10 })
  })
})
