import { ImapFlow } from 'imapflow'
import type { FolderStatus, MailboxClient, MailboxMessage } from './ingest.js'

export interface ImapConnection {
  host: string
  port: number
  useTls: boolean
  username: string
  password: string
}

export interface ConnectionTestResult {
  ok: boolean
  /** A message aimed at the person filling in the form, not a stack trace. */
  message: string
  folders?: string[]
}

/**
 * The real IMAP transport.
 *
 * `MailboxSync` holds the cursor logic and is tested against a fake; this class
 * is the thin part that talks to a server, so it stays as small as possible.
 */
export class ImapFlowClient implements MailboxClient {
  private client: ImapFlow | null = null
  private folder = 'INBOX'

  constructor(private readonly connection: ImapConnection) {}

  async connect(): Promise<void> {
    this.client = new ImapFlow({
      host: this.connection.host,
      port: this.connection.port,
      secure: this.connection.useTls,
      auth: { user: this.connection.username, pass: this.connection.password },
      logger: false,
      // Mail is only ever read. Nothing here marks messages as seen or deletes.
      emitLogs: false,
    })
    await this.client.connect()
  }

  async openFolder(folder: string): Promise<FolderStatus> {
    if (!this.client) throw new Error('connect() must be called first')
    this.folder = folder
    // Read-only: opening a mailbox normally can flag messages as seen, which
    // would change the user's actual inbox. This application only observes.
    const lock = await this.client.getMailboxLock(folder, { readOnly: true })
    try {
      const mailbox = this.client.mailbox
      if (!mailbox || typeof mailbox === 'boolean') {
        throw new Error(`Could not open folder ${folder}`)
      }
      return {
        uidValidity: Number(mailbox.uidValidity),
        uidNext: mailbox.uidNext,
      }
    } finally {
      lock.release()
    }
  }

  /**
   * Finds where a first sync should begin, using the server's own date search
   * so the whole mailbox never has to be walked.
   */
  async firstUidSince(date: Date): Promise<number | null> {
    if (!this.client) throw new Error('connect() must be called first')

    const lock = await this.client.getMailboxLock(this.folder, { readOnly: true })
    try {
      const uids = await this.client.search({ since: date }, { uid: true })
      if (!uids || uids.length === 0) return null
      return Math.min(...uids)
    } catch {
      // A server that refuses the search should not block syncing entirely.
      return null
    } finally {
      lock.release()
    }
  }

  async fetchSince(afterUid: number, limit: number): Promise<MailboxMessage[]> {
    if (!this.client) throw new Error('connect() must be called first')

    const lock = await this.client.getMailboxLock(this.folder, { readOnly: true })
    const messages: MailboxMessage[] = []
    try {
      const range = `${afterUid + 1}:*`
      for await (const message of this.client.fetch(range, { uid: true, source: true }, { uid: true })) {
        // A `n:*` range always returns at least one message even when none is
        // newer, so anything at or below the cursor is discarded.
        if (message.uid <= afterUid) continue
        if (message.source) messages.push({ uid: message.uid, raw: message.source })
        if (messages.length >= limit) break
      }
    } finally {
      lock.release()
    }

    return messages.sort((a, b) => a.uid - b.uid)
  }

  async close(): Promise<void> {
    if (!this.client) return
    try {
      await this.client.logout()
    } catch {
      // A server that drops the connection first is not a failure worth raising.
    }
    this.client = null
  }
}

/**
 * Checks credentials and reports back in words the person can act on.
 *
 * The common failures have specific causes — an app-specific password being
 * required, or IMAP being switched off entirely — and saying which one it is
 * saves far more time than the raw server error.
 */
export async function testConnection(connection: ImapConnection): Promise<ConnectionTestResult> {
  const client = new ImapFlow({
    host: connection.host,
    port: connection.port,
    secure: connection.useTls,
    auth: { user: connection.username, pass: connection.password },
    logger: false,
  })

  try {
    await client.connect()
    const folders = (await client.list()).map((box) => box.path).slice(0, 50)
    await client.logout()
    return { ok: true, message: `Connected. ${folders.length} folders visible.`, folders }
  } catch (error) {
    return { ok: false, message: explainConnectionError(error) }
  }
}

export function explainConnectionError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const text = raw.toLowerCase()

  if (text.includes('authenticationfailed') || text.includes('invalid credentials') || text.includes('login failed')) {
    return 'The server rejected the username or password. Gmail, Yahoo and iCloud need an app-specific password here, not your normal one.'
  }
  if (text.includes('enotfound') || text.includes('eai_again') || text.includes('getaddrinfo')) {
    return 'That server name could not be found. Check the host, or pick the provider preset again.'
  }
  if (text.includes('econnrefused')) {
    return 'The server refused the connection. Check the port — IMAP over TLS is normally 993.'
  }
  if (text.includes('etimedout') || text.includes('timeout')) {
    return 'The server did not respond in time. It may be blocked by a firewall, or the host may be wrong.'
  }
  if (text.includes('certificate') || text.includes('self signed') || text.includes('altnames')) {
    return 'The server\'s TLS certificate could not be verified. This is expected on a self-hosted server with a self-signed certificate.'
  }
  if (text.includes('imap') && text.includes('disabled')) {
    return 'IMAP is switched off for this mailbox. web.de and some Outlook accounts require enabling it in the provider\'s settings first.'
  }
  return raw
}
