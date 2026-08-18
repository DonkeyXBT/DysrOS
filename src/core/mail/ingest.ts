import type { Db } from '../db/connection.js'

/**
 * Mailbox synchronisation.
 *
 * The transport is abstracted so the sync *logic* — which is where the bugs
 * live — can be tested without a server. `ImapFlowClient` is the real one.
 *
 * The cursor is a `UIDVALIDITY` plus the last UID seen in that folder. Both
 * halves matter: UIDs are only meaningful within a given UIDVALIDITY, and a
 * server that renumbers a mailbox bumps UIDVALIDITY. Comparing only UIDs would
 * silently skip every message after a renumbering.
 */

export interface MailboxMessage {
  uid: number
  raw: Buffer
}

export interface FolderStatus {
  uidValidity: number
  /** Highest UID present, used to report how far behind the cursor is. */
  uidNext?: number
}

export interface MailboxClient {
  connect(): Promise<void>
  openFolder(folder: string): Promise<FolderStatus>
  /** Messages with a UID strictly greater than `afterUid`, oldest first. */
  fetchSince(afterUid: number, limit: number): Promise<MailboxMessage[]>
  /**
   * The lowest UID whose message was received on or after `date`, or null when
   * the folder holds nothing that recent.
   *
   * This is what makes a first sync sane. Starting from UID 1 would fetch the
   * oldest mail in the mailbox — on a real account, years-old messages that
   * contain nothing of interest — and the limit would be exhausted long before
   * reaching anything recent.
   */
  firstUidSince(date: Date): Promise<number | null>
  close(): Promise<void>
}

export interface SyncResult {
  folder: string
  fetched: number
  stored: number
  duplicates: number
  uidValidityReset: boolean
  lastUid: number
  /** True when this run started from the lookback window rather than a cursor. */
  startedFresh: boolean
}

/** Called for each fetched message; returns true when it was newly stored. */
export type MessageSink = (message: {
  accountId: string
  folder: string
  uid: number
  raw: Buffer
}) => Promise<boolean>

export class MailboxSync {
  constructor(private readonly db: Db) {}

  readCursor(accountId: string, folder: string): { uidValidity: number; lastUid: number } | null {
    const row = this.db
      .prepare('SELECT uid_validity, last_uid FROM folder_cursors WHERE account_id = ? AND folder = ?')
      .get(accountId, folder) as { uid_validity: number; last_uid: number } | undefined
    return row ? { uidValidity: row.uid_validity, lastUid: row.last_uid } : null
  }

  writeCursor(accountId: string, folder: string, uidValidity: number, lastUid: number): void {
    this.db.prepare(
      `INSERT INTO folder_cursors (account_id, folder, uid_validity, last_uid)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, folder) DO UPDATE SET
         uid_validity = excluded.uid_validity,
         last_uid = excluded.last_uid`,
    ).run(accountId, folder, uidValidity, lastUid)
  }

  async sync(
    accountId: string,
    folder: string,
    client: MailboxClient,
    sink: MessageSink,
    options: { limit?: number; initialLookbackDays?: number } = {},
  ): Promise<SyncResult> {
    const limit = options.limit ?? 200
    // One week on a first sync. A busy mailbox holds thousands of messages a
    // month, almost none of them relevant, and a first run that grinds through
    // them all reads as broken. The hourly pass keeps up from there.
    const lookbackDays = options.initialLookbackDays ?? 7

    await client.connect()
    try {
      const status = await client.openFolder(folder)
      const cursor = this.readCursor(accountId, folder)

      // A changed UIDVALIDITY invalidates every stored UID for this folder, so
      // the cursor restarts. Content hashing keeps the re-read from duplicating
      // anything already stored.
      const uidValidityReset = cursor !== null && cursor.uidValidity !== status.uidValidity
      const startingFresh = cursor === null || uidValidityReset

      let afterUid = startingFresh ? 0 : cursor!.lastUid
      if (startingFresh) {
        // Begin at the first message inside the lookback window rather than at
        // the start of the mailbox.
        const cutoff = new Date(Date.now() - lookbackDays * 86_400_000)
        const firstRecent = await client.firstUidSince(cutoff)
        afterUid = firstRecent === null ? 0 : Math.max(0, firstRecent - 1)
      }

      const messages = await client.fetchSince(afterUid, limit)

      let stored = 0
      let duplicates = 0
      let lastUid = afterUid

      for (const message of messages) {
        const isNew = await sink({ accountId, folder, uid: message.uid, raw: message.raw })
        if (isNew) stored += 1
        else duplicates += 1
        // Advance only past messages actually handled, so an interrupted sync
        // resumes from the right place rather than skipping the remainder.
        if (message.uid > lastUid) lastUid = message.uid
      }

      this.writeCursor(accountId, folder, status.uidValidity, lastUid)

      return {
        folder,
        fetched: messages.length,
        stored,
        duplicates,
        uidValidityReset,
        lastUid,
        startedFresh: startingFresh,
      }
    } finally {
      await client.close()
    }
  }
}
