import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, type Db } from '../core/db/connection.js'
import { migrate, currentVersion } from '../core/db/migrations.js'
import { MessageRepo, hashContent } from '../core/repos/messages.js'
import { EventRepo, type StoredEvent } from '../core/repos/events.js'
import { loadEml, textOf } from '../core/mail/parsed-message.js'
import { ParserRegistry } from '../core/parsers/registry.js'
import { BOL_PARSERS } from '../core/parsers/bol.js'
import { MEDIAMARKT_PARSERS } from '../core/parsers/mediamarkt.js'
import { PROSHOP_PARSERS } from '../core/parsers/proshop.js'
import { POCKETGAMES_PARSERS } from '../core/parsers/pocketgames.js'
import { PROVIDERS } from '../core/mail/providers.js'
import { money, formatMoney, type Money } from '../core/money.js'
import { Reconciler } from '../core/reconcile/reconciler.js'
import { AccountRepo, type Encryptor, type MailAccount, type NewAccount } from '../core/repos/accounts.js'
import { MailboxSync } from '../core/mail/ingest.js'
import { ImapFlowClient, testConnection, explainConnectionError } from '../core/mail/imapflow-client.js'
import { AycdClient } from '../core/aycd/client.js'
import { resolveTrackingLink, isNonCarrierBolLanding } from '../core/tracking/resolve-link.js'
import {
  sendToDiscord, sampleNotification, isWebhookUrl, maskWebhookUrl,
  type NotifiableEvent, type NotificationInput,
} from '../core/notify/discord.js'
import { AYCD_TASK_BUILDERS } from '../core/aycd/tasks.js'
import {
  AycdWatcher, systemClock, type CapturedEvent, type InboxTransport, type WatcherClock,
} from '../core/aycd/watcher.js'

/**
 * Where a provider keeps everything.
 *
 * Gmail hides archived mail from INBOX but keeps it in All Mail, so syncing
 * only INBOX would miss any order confirmation that was archived or filtered.
 */
/** Settings keys for the AYCD Inbox integration. The key setting holds the
 *  ciphertext, never the key itself. */
const AYCD_KEY_SETTING = 'aycd_api_key_cipher'
const AYCD_ADDRESSES_SETTING = 'aycd_addresses'
const AYCD_ERROR_SETTING = 'aycd_last_error'
/** The schema version the derived tables were last built from. */
const ENTITIES_VERSION_SETTING = 'entities_schema_version'
/** The webhook URL is a secret: anyone holding it can post to the channel. */
const DISCORD_WEBHOOK_SETTING = 'discord_webhook_cipher'

/** Which events notify, and their default. Chosen so the noisy ones — an order
 *  being placed, which you already know about — start switched off. */
export const NOTIFIABLE_EVENTS: { event: NotifiableEvent; label: string; on: boolean }[] = [
  { event: 'order_placed', label: 'Order placed', on: false },
  { event: 'shipped', label: 'Order shipped', on: true },
  { event: 'delivered', label: 'Order delivered', on: true },
  { event: 'cancelled', label: 'Order cancelled', on: true },
  { event: 'refunded', label: 'Refund received', on: true },
  { event: 'sale', label: 'Item sold', on: true },
  { event: 'payout', label: 'Payout received', on: true },
  { event: 'shipment_exception', label: 'Shipment problem', on: true },
]

/** Keeps a subject usable as a filename without losing what it says. */
export function safeFileName(subject: string): string {
  return subject
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70) || 'message'
}

export function defaultFolderFor(provider: string): string {
  if (provider === 'gmail') return '[Gmail]/All Mail'
  return 'INBOX'
}

/**
 * Everything the renderer can ask for, in one place.
 *
 * The renderer never touches the database, the filesystem or the network: it
 * calls these methods over IPC and receives plain serialisable objects.
 */
export class AppService {
  private readonly db: Db
  private readonly messages: MessageRepo
  private readonly events: EventRepo
  private readonly registry = new ParserRegistry([
    ...BOL_PARSERS,
    ...MEDIAMARKT_PARSERS,
    ...PROSHOP_PARSERS,
    ...POCKETGAMES_PARSERS,
  ])
  private readonly reconciler: Reconciler
  private readonly accounts: AccountRepo
  private readonly mailbox: MailboxSync
  private aycd: AycdWatcher | null = null

  /** Where fetched mail is kept so a corrected parser can be re-run over it. */
  private readonly rawDir: string

  constructor(
    databasePath: string,
    private readonly encryptor: Encryptor,
    rawDir?: string,
  ) {
    this.rawDir = rawDir
      ?? (databasePath === ':memory:' ? join(tmpdir(), 'resell-ops-raw') : join(dirname(databasePath), 'mail-raw'))
    this.db = openDatabase(databasePath)
    migrate(this.db)
    this.messages = new MessageRepo(this.db)
    this.events = new EventRepo(this.db)
    this.reconciler = new Reconciler(this.db)
    this.accounts = new AccountRepo(this.db, encryptor)
    this.mailbox = new MailboxSync(this.db)
    this.ensureLocalAccount()
    this.rebuildIfSchemaMoved()
  }

  /**
   * Re-derives entities after a migration that added a column the reconciler
   * fills.
   *
   * Events already carrying a `reconciled_at` are never revisited, so a new
   * column keeps its default on every existing row — which showed up as blank
   * item titles for everything recorded before the column existed.
   */
  private rebuildIfSchemaMoved(): void {
    const current = String(currentVersion(this.db))
    if (this.getSetting(ENTITIES_VERSION_SETTING) === current) return

    const hasEvents = (this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
    if (hasEvents > 0) this.rebuildEntities()
    this.setSetting(ENTITIES_VERSION_SETTING, current)
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  /**
   * The folder the application ingests mail from, with no user action required.
   *
   * Picking files by hand is not how this should work day to day: the app knows
   * where mail lives and reads it on its own. Until IMAP lands this is a watched
   * folder; afterwards it stays as the manual drop point for one-off files.
   */
  mailDir(fallback: string): string {
    const configured = this.getSetting('mail_dir')
    if (configured) return configured
    this.setSetting('mail_dir', fallback)
    return fallback
  }

  /**
   * Imports every .eml in the folder. Safe to run on every launch and on every
   * file-system change: content hashing means an unchanged file is a no-op, and
   * parser output is replaced rather than duplicated.
   */
  async scanMailDir(dir: string): Promise<{ scanned: number; recognised: number; unrecognised: number }> {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
      return { scanned: 0, recognised: 0, unrecognised: 0 }
    }

    let recognised = 0
    let unrecognised = 0
    const files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.eml'))
    for (const name of files) {
      try {
        const result = await this.importEml(join(dir, name))
        if (result.parserId) recognised += 1
        else unrecognised += 1
      } catch {
        // A single unreadable file must not stop the rest of the folder.
        unrecognised += 1
      }
    }
    this.reconciler.run(new Date().toISOString())
    return { scanned: files.length, recognised, unrecognised }
  }

  /** Imported files are not tied to a mailbox yet, but messages require an
   *  account, so a single local placeholder stands in until IMAP lands. */
  /** Keeps a copy of a fetched message, sharded so one directory never holds
   *  tens of thousands of files. */
  private storeRaw(contentHash: string, raw: Buffer): string {
    try {
      const shard = join(this.rawDir, contentHash.slice(0, 2))
      mkdirSync(shard, { recursive: true })
      const path = join(shard, `${contentHash}.eml`)
      if (!existsSync(path)) writeFileSync(path, raw)
      return path
    } catch {
      // Failing to keep a copy must not stop the message being processed.
      return ''
    }
  }

  /**
   * Runs the current parsers over every message already stored, then rebuilds
   * every entity from the corrected events.
   *
   * This is what makes a parser fix worth anything to data already collected:
   * event identity is derived from the message and the parser, so re-running
   * corrects history in place rather than duplicating it.
   */
  async reparseAll(): Promise<{ examined: number; reparsed: number; missing: number }> {
    const rows = this.db
      .prepare('SELECT id, raw_path FROM messages ORDER BY received_at')
      .all() as { id: string; raw_path: string }[]

    let reparsed = 0
    let missing = 0
    const now = new Date().toISOString()

    for (const row of rows) {
      if (!row.raw_path || !existsSync(row.raw_path)) {
        missing += 1
        continue
      }
      try {
        const parsed = await loadEml(readFileSync(row.raw_path))
        const result = this.registry.parse(parsed)
        if (!result) {
          this.messages.markUnrecognized(row.id)
        } else {
          this.events.replaceForMessage(row.id, result.parserId, result.events, now)
          this.messages.markParsed(row.id, result.parserId, now)
        }
        reparsed += 1
      } catch {
        missing += 1
      }
    }

    this.rebuildEntities(now)
    return { examined: rows.length, reparsed, missing }
  }

  /**
   * Discards derived rows and re-applies every event.
   *
   * Needed after a migration that adds a column the reconciler fills: already
   * reconciled events are never revisited, so existing rows would keep the
   * column's default forever and the screens would show blanks.
   */
  rebuildEntities(now = new Date().toISOString()): { applied: number; held: number } {
    const rebuild = this.db.transaction(() => {
      this.db.exec('DELETE FROM refunds')
      this.db.exec('DELETE FROM items')
      this.db.exec('DELETE FROM shipments')
      this.db.exec('DELETE FROM purchases')
      this.db.exec('UPDATE events SET reconciled_at = NULL')
    })
    rebuild()
    return this.reconciler.run(now)
  }

  private ensureLocalAccount(): void {
    const exists = this.db.prepare("SELECT 1 FROM accounts WHERE id = 'local-import'").get()
    if (exists) return
    this.db.prepare(
      `INSERT INTO accounts (id, label, email, provider, host, port, username, secret_cipher, created_at)
       VALUES ('local-import', 'Imported files', 'local@import', 'custom', '', 0, '', '', ?)`,
    ).run(new Date().toISOString())
  }

  /**
   * Reads an .eml file, stores it, runs the parser registry over it and records
   * the resulting events. Safe to run twice: the message is deduplicated by
   * content hash and events are replaced rather than duplicated.
   */
  async importEml(path: string): Promise<{ subject: string; parserId: string | null; events: number }> {
    const raw = readFileSync(path)
    const parsed = await loadEml(raw)
    const now = new Date().toISOString()

    const stored = this.messages.upsert({
      accountId: 'local-import',
      uid: 0,
      folder: 'IMPORT',
      messageId: parsed.messageId,
      contentHash: hashContent(raw.toString('utf8')),
      fromAddress: parsed.fromAddress,
      fromName: parsed.fromName,
      subject: parsed.subject || basename(path),
      receivedAt: parsed.receivedAt,
      rawPath: path,
      bodyPreview: textOf(parsed, { preferHtml: true }).slice(0, 400),
    })

    const result = this.registry.parse(parsed)
    if (!result) {
      this.messages.markUnrecognized(stored.id)
      return { subject: stored.subject, parserId: null, events: 0 }
    }

    const written = this.events.replaceForMessage(stored.id, result.parserId, result.events, now)
    this.messages.markParsed(stored.id, result.parserId, now)
    this.reconciler.run(now)
    return { subject: stored.subject, parserId: result.parserId, events: written.length }
  }

  /**
   * Shipments as reconciled. The reconciler links a shipment to its order once
   * both have arrived, in either order, so this reports the linkage rather than
   * re-deriving it from whichever event happens to be present.
   *
   * Contents come from the originating event: a shipping mail names what is in
   * the parcel, and that detail exists nowhere else.
   */
  listShipments(): ShipmentView[] {
    const rows = this.db.prepare(
      `SELECT s.*, e.payload_json, e.retailer, e.external_order_id
       FROM shipments s
       LEFT JOIN events e ON e.id = s.id
       ORDER BY s.created_at DESC`,
    ).all() as Record<string, unknown>[]

    return rows.map((row) => {
      const payload = row.payload_json
        ? (JSON.parse(row.payload_json as string) as Record<string, unknown>)
        : {}
      const reference = (row.external_order_id as string | null) ?? null
      return {
        id: row.id as string,
        direction: row.direction as string,
        carrier: row.carrier as string,
        trackingNumber: (row.tracking_number as string | null) ?? null,
        trackingUrl: (row.tracking_url as string | null) ?? null,
        linked: `${(row.retailer as string) ?? 'unknown'} \u00b7 ${reference ?? '\u2014'}`,
        title: (payload.title as string | null) ?? null,
        quantity: (payload.quantity as number) ?? 1,
        status: row.status as string,
        lastMovementAt: (row.last_movement_at as string | null) ?? null,
        expectedDeliveryAt: (row.expected_delivery_at as string | null) ?? null,
        postalCode: (payload.deliveryPostalCode as string | null) ?? null,
        city: (payload.deliveryCity as string | null) ?? null,
        dhlRedirectable: Boolean(payload.dhlRedirectable),
        /** True once the reconciler has matched this parcel to its order. */
        linkedToPurchase: row.purchase_id !== null,
      }
    })
  }

  listPurchases(): PurchaseView[] {
    const rows = this.db.prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM items i WHERE i.purchase_id = p.id) AS item_count,
              (SELECT i.cost_minor FROM items i WHERE i.purchase_id = p.id LIMIT 1) AS unit_minor,
              (SELECT COALESCE(SUM(r.amount_minor), 0) FROM refunds r
                WHERE r.purchase_id = p.id AND r.received_at IS NULL) AS refund_outstanding
       FROM purchases p
       ORDER BY p.ordered_at DESC`,
    ).all() as Record<string, unknown>[]

    const orders: PurchaseView[] = rows.map((row) => {
      const currency = (row.currency as Money['currency']) ?? 'EUR'
      const total = money(row.total_minor as number, currency)
      const outstanding = row.refund_outstanding as number
      return {
        id: row.id as string,
        kind: 'buy',
        retailer: row.retailer as string,
        reference: (row.external_order_id as string | null) ?? null,
        orderedAt: row.ordered_at as string,
        title: (row.title as string | null) ?? null,
        quantity: (row.item_count as number) || 1,
        unit: formatMoney(money((row.unit_minor as number) ?? 0, currency)),
        shipping: formatMoney(money(row.shipping_minor as number, currency)),
        total: formatMoney(total),
        totalMinor: total.minor,
        totalsConsistent: row.totals_consistent === 1,
        status: row.status as string,
        refundOutstanding: outstanding > 0 ? formatMoney(money(outstanding, currency)) : null,
      }
    })

    // A cancellation whose order was never captured has nothing to attach to,
    // but it is still something that happened and belongs on the same list —
    // hidden away in its own panel it is easy to miss that money is owed.
    const attached = new Set(orders.map((order) => `${order.retailer}|${order.reference}`))
    const orphans: PurchaseView[] = this.listCancellations()
      .filter((c) => !attached.has(`${c.retailer}|${c.reference}`))
      .map((c) => ({
        id: c.id,
        kind: 'cancel',
        retailer: c.retailer,
        reference: c.reference,
        orderedAt: c.occurredAt,
        title: c.title,
        quantity: 1,
        // bol.com states no amount in a cancellation, so there is nothing
        // honest to put in these columns.
        unit: '\u2014',
        shipping: '\u2014',
        total: '\u2014',
        totalMinor: 0,
        totalsConsistent: false,
        status: 'cancelled',
        refundOutstanding: null,
      }))

    return [...orders, ...orphans].sort((a, b) => (a.orderedAt < b.orderedAt ? 1 : -1))
  }

  listCancellations(): CancellationView[] {
    return this.allEvents()
      .filter((event) => event.type === 'cancelled')
      .map((event) => ({
        id: event.id,
        retailer: event.retailer,
        reference: event.externalOrderId,
        occurredAt: event.occurredAt,
        title: (event.payload.title as string | null) ?? null,
        refundExpected: Boolean(event.payload.refundExpected),
      }))
  }

  /** Individual units, straight out of the reconciled `items` table. */
  listInventory(): ItemView[] {
    const rows = this.db.prepare(
      `SELECT i.*, p.retailer AS retailer, p.external_order_id AS order_ref
       FROM items i LEFT JOIN purchases p ON p.id = i.purchase_id
       ORDER BY i.purchased_at DESC, i.id`,
    ).all() as Record<string, unknown>[]

    const today = Date.now()
    return rows.map((row) => {
      const purchasedAt = row.purchased_at as string | null
      const daysHeld = purchasedAt
        ? Math.max(0, Math.floor((today - Date.parse(purchasedAt)) / 86_400_000))
        : null
      return {
        id: row.id as string,
        title: row.title as string,
        brand: (row.brand as string | null) ?? null,
        sku: (row.sku as string | null) ?? null,
        size: (row.size as string | null) ?? null,
        condition: row.condition as string,
        status: row.status as string,
        cost: formatMoney(money(row.cost_minor as number, (row.cost_currency as Money['currency']) ?? 'EUR')),
        costMinor: row.cost_minor as number,
        purchasedAt,
        daysHeld,
        location: (row.location as string | null) ?? null,
        retailer: (row.retailer as string | null) ?? null,
        orderRef: (row.order_ref as string | null) ?? null,
      }
    })
  }

  /**
   * The stored copy of a message, for sending on so a parser can be written.
   *
   * Returns null when no copy was kept — mail fetched before copies were
   * retained cannot be exported, and saying so is better than writing an empty
   * file that looks like a failed parser rather than a missing source.
   */
  async exportMessage(
    id: string,
    format: 'eml' | 'html',
  ): Promise<{ name: string; content: Buffer } | null> {
    const row = this.db
      .prepare('SELECT raw_path, subject, received_at FROM messages WHERE id = ?')
      .get(id) as { raw_path: string; subject: string; received_at: string } | undefined
    if (!row?.raw_path || !existsSync(row.raw_path)) return null

    const raw = readFileSync(row.raw_path)
    const stem = `${row.received_at.slice(0, 10)}-${safeFileName(row.subject)}`

    // The .eml is the useful one for writing a parser: it keeps the headers a
    // parser matches on. The .html is for looking at the message in a browser.
    if (format === 'eml') return { name: `${stem}.eml`, content: raw }

    const parsed = await loadEml(raw)
    const html = parsed.html.trim().length > 0
      ? parsed.html
      : `<pre>${parsed.text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))}</pre>`
    return { name: `${stem}.html`, content: Buffer.from(html, 'utf8') }
  }

  /** Every unrecognised message that still has a stored copy. */
  exportableReviewIds(): string[] {
    const rows = this.db.prepare(
      `SELECT id FROM messages
       WHERE parse_status = 'unrecognized' AND raw_path IS NOT NULL AND raw_path != ''
       ORDER BY received_at DESC`,
    ).all() as { id: string }[]
    return rows.map((row) => row.id)
  }

  listReviewQueue(): ReviewView[] {
    return this.messages.listByStatus('unrecognized').map((message) => ({
      id: message.id,
      from: message.fromName ?? message.fromAddress,
      address: message.fromAddress,
      subject: message.subject,
      receivedAt: message.receivedAt,
      preview: message.bodyPreview,
      exportable: message.rawPath !== '' && existsSync(message.rawPath),
    }))
  }

  listParsers(): ParserView[] {
    const counts = this.db
      .prepare('SELECT parser_id AS id, COUNT(*) AS n FROM messages WHERE parser_id IS NOT NULL GROUP BY parser_id')
      .all() as { id: string; n: number }[]
    const byId = new Map(counts.map((row) => [row.id, row.n]))
    return this.registry.describe().map((parser) => ({
      id: parser.id,
      retailer: parser.retailer,
      parsed: byId.get(parser.id) ?? 0,
    }))
  }

  listAccounts(): MailAccount[] {
    return this.accounts.list()
  }

  addAccount(account: NewAccount): MailAccount {
    return this.accounts.add(account, new Date().toISOString())
  }

  removeAccount(id: string): void {
    this.accounts.remove(id)
  }

  async testAccount(connection: {
    host: string; port: number; useTls: boolean; username: string; password: string
  }) {
    return testConnection(connection)
  }

  /**
   * Pulls new mail for every enabled account, parses it and reconciles.
   *
   * Each account is synced independently: one mailbox with a rejected password
   * must not stop the others, so its error is recorded against that account and
   * the loop continues.
   */
  async syncAccounts(folder?: string, onProgress?: SyncProgressFn): Promise<{
    accounts: number
    fetched: number
    stored: number
    failures: { email: string; error: string }[]
    perAccount: { email: string; folder: string; fetched: number; stored: number; startedFresh: boolean }[]
  }> {
    const enabled = this.accounts.list().filter((account) => account.enabled)
    let fetched = 0
    let stored = 0
    const failures: { email: string; error: string }[] = []
    const perAccount: {
      email: string; folder: string; fetched: number; stored: number; startedFresh: boolean
    }[] = []

    let handled = 0
    let storedSoFar = 0

    for (const account of enabled) {
      const password = this.accounts.password(account.id)
      if (password === null) {
        failures.push({ email: account.email, error: 'Stored password could not be read.' })
        continue
      }

      const client = new ImapFlowClient({
        host: account.host,
        port: account.port,
        useTls: account.useTls,
        username: account.username,
        password,
      })

      const box = folder ?? defaultFolderFor(account.provider)
      try {
        const result = await this.mailbox.sync(
          account.id,
          box,
          client,
          async ({ accountId, folder: f, uid, raw }) => {
            const isNew = await this.ingestRaw(accountId, f, uid, raw)
            // Reported per message rather than per account: a mailbox can take
            // minutes, and a progress bar that only moves at the end is no
            // better than none.
            handled += 1
            onProgress?.({
              account: account.email,
              done: handled,
              stored: isNew ? (storedSoFar += 1) : storedSoFar,
              subject: this.messages.findByHash(hashContent(raw.toString('utf8')))?.subject ?? '',
            })
            return isNew
          },
          { limit: 500 },
        )
        fetched += result.fetched
        stored += result.stored
        perAccount.push({
          email: account.email,
          folder: box,
          fetched: result.fetched,
          stored: result.stored,
          startedFresh: result.startedFresh,
        })
        this.accounts.recordSyncSuccess(account.id, new Date().toISOString())
      } catch (error) {
        const message = explainConnectionError(error)
        this.accounts.recordSyncFailure(account.id, message)
        failures.push({ email: account.email, error: message })
      }
    }

    this.reconciler.run(new Date().toISOString())
    return { accounts: enabled.length, fetched, stored, failures, perAccount }
  }

  /** Stores and parses one fetched message. Returns true when it was new. */
  private async ingestRaw(
    accountId: string,
    folder: string,
    uid: number,
    raw: Buffer,
  ): Promise<boolean> {
    const parsed = await loadEml(raw)
    const now = new Date().toISOString()
    const contentHash = hashContent(raw.toString('utf8'))
    const already = this.messages.findByHash(contentHash) !== null

    // Keeping the message is what makes a parser fix able to heal history:
    // without it, correcting an extraction can only ever affect future mail.
    const rawPath = this.storeRaw(contentHash, raw)

    const stored = this.messages.upsert({
      accountId,
      uid,
      folder,
      messageId: parsed.messageId,
      contentHash,
      fromAddress: parsed.fromAddress,
      fromName: parsed.fromName,
      subject: parsed.subject || '(no subject)',
      receivedAt: parsed.receivedAt,
      rawPath,
      bodyPreview: textOf(parsed, { preferHtml: true }).slice(0, 400),
    })
    if (already) return false

    const result = this.registry.parse(parsed)
    if (!result) {
      this.messages.markUnrecognized(stored.id)
      return true
    }
    this.events.replaceForMessage(stored.id, result.parserId, result.events, now)
    this.messages.markParsed(stored.id, result.parserId, now)
    return true
  }

  /**
   * Removes everything the application has collected.
   *
   * Mail accounts and integration keys are kept unless asked for too, because
   * "start the data over" and "disconnect my mailboxes" are different
   * intentions and conflating them makes the destructive one easy to trigger by
   * accident. Retained message copies go as well — leaving them behind would
   * mean a later re-read silently resurrecting what was just deleted.
   */
  deleteAllData(options: { includeAccounts?: boolean } = {}): {
    messages: number
    events: number
    purchases: number
    items: number
  } {
    const before = {
      messages: (this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n,
      events: (this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
      purchases: (this.db.prepare('SELECT COUNT(*) AS n FROM purchases').get() as { n: number }).n,
      items: (this.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n,
    }

    const wipe = this.db.transaction(() => {
      this.db.exec('DELETE FROM refunds')
      this.db.exec('DELETE FROM sales')
      this.db.exec('DELETE FROM items')
      this.db.exec('DELETE FROM shipments')
      this.db.exec('DELETE FROM purchase_lines')
      this.db.exec('DELETE FROM purchases')
      this.db.exec('DELETE FROM events')
      this.db.exec('DELETE FROM messages')
      // Cursors must go too: leaving them would make the next sync resume from
      // where it stopped and never re-fetch what was just deleted.
      this.db.exec('DELETE FROM folder_cursors')
      if (options.includeAccounts) {
        this.db.exec("DELETE FROM accounts WHERE id != 'local-import'")
      }
    })
    wipe()

    try {
      rmSync(this.rawDir, { recursive: true, force: true })
    } catch {
      // A locked file must not leave the database half-cleared.
    }

    return before
  }

  /**
   * Turns retailer redirect links into real carrier barcodes.
   *
   * The retailer never states the barcode in the mail — only a tokenised
   * redirect that lands on the carrier's own page, where the code is in the
   * URL. That costs one request per parcel, so it runs as its own pass rather
   * than during parsing: ingestion stays offline, and a network failure can
   * never corrupt a parsed event.
   *
   * A parcel that fails is simply left for the next pass. Nothing is guessed.
   */
  async resolveTrackingCodes(
    options: { limit?: number; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<{ attempted: number; resolved: number; failed: number }> {
    const limit = options.limit ?? 40

    const rows = this.db.prepare(
      `SELECT s.id, e.payload_json
       FROM shipments s
       JOIN events e ON e.id = s.id
       WHERE s.tracking_number IS NULL
       ORDER BY s.created_at DESC
       LIMIT ?`,
    ).all(limit) as { id: string; payload_json: string }[]

    let resolved = 0
    let failed = 0

    for (const [index, row] of rows.entries()) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>
      const candidates = Array.isArray(payload.trackingCandidates)
        ? (payload.trackingCandidates as string[])
        : [payload.trackingUrl as string].filter(Boolean)

      let found: { carrier: string; trackingNumber: string; finalUrl: string } | null = null
      for (const candidate of candidates) {
        const result = await resolveTrackingLink(candidate)
        // Landing on the retailer's own login page means this link was never a
        // tracking link; try the next candidate rather than giving up.
        if (result && !isNonCarrierBolLanding(result.finalUrl)) {
          found = result
          break
        }
      }

      if (found) {
        this.db.prepare(
          `UPDATE shipments
           SET tracking_number = ?, carrier = ?, status = 'in_transit', last_polled_at = ?
           WHERE id = ?`,
        ).run(found.trackingNumber, found.carrier, new Date().toISOString(), row.id)
        resolved += 1
      } else {
        this.db.prepare('UPDATE shipments SET last_polled_at = ? WHERE id = ?')
          .run(new Date().toISOString(), row.id)
        failed += 1
      }

      options.onProgress?.(index + 1, rows.length)
    }

    return { attempted: rows.length, resolved, failed }
  }

  // ---- Discord notifications ----------------------------------------------

  setDiscordWebhook(url: string): { ok: boolean; message: string } {
    const trimmed = url.trim()
    if (trimmed.length === 0) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(DISCORD_WEBHOOK_SETTING)
      return { ok: true, message: 'Webhook removed.' }
    }
    if (!isWebhookUrl(trimmed)) {
      return { ok: false, message: 'That does not look like a Discord webhook URL.' }
    }
    this.setSetting(DISCORD_WEBHOOK_SETTING, this.encryptor.encrypt(trimmed))
    return { ok: true, message: 'Webhook stored, encrypted with the OS keystore.' }
  }

  private discordWebhook(): string | null {
    const cipher = this.getSetting(DISCORD_WEBHOOK_SETTING)
    if (!cipher) return null
    try {
      return this.encryptor.decrypt(cipher)
    } catch {
      return null
    }
  }

  discordSettings(): {
    configured: boolean
    masked: string
    rules: { event: string; label: string; enabled: boolean }[]
  } {
    const url = this.discordWebhook()
    const stored = this.db
      .prepare('SELECT event_type, enabled FROM notification_rules')
      .all() as { event_type: string; enabled: number }[]
    const byEvent = new Map(stored.map((row) => [row.event_type, row.enabled === 1]))

    return {
      configured: url !== null,
      masked: url ? maskWebhookUrl(url) : '—',
      rules: NOTIFIABLE_EVENTS.map((rule) => ({
        event: rule.event,
        label: rule.label,
        enabled: byEvent.get(rule.event) ?? rule.on,
      })),
    }
  }

  setDiscordRule(event: string, enabled: boolean): void {
    this.db.prepare(
      `INSERT INTO notification_rules (event_type, channel, enabled)
       VALUES (?, 'discord', ?)
       ON CONFLICT(event_type) DO UPDATE SET enabled = excluded.enabled`,
    ).run(event, enabled ? 1 : 0)
  }

  async sendDiscordTest(): Promise<{ ok: boolean; message: string }> {
    const url = this.discordWebhook()
    if (!url) return { ok: false, message: 'No webhook is configured.' }
    return sendToDiscord(url, [sampleNotification(new Date().toISOString())])
  }

  /** Posts the events a rule allows. Silent when nothing is configured, so the
   *  rest of the pipeline never has to care whether Discord is set up. */
  async notifyDiscord(inputs: NotificationInput[]): Promise<void> {
    const url = this.discordWebhook()
    if (!url || inputs.length === 0) return

    const settings = this.discordSettings()
    const allowed = new Set(settings.rules.filter((r) => r.enabled).map((r) => r.event))
    const wanted = inputs.filter((input) => allowed.has(input.event))
    if (wanted.length === 0) return

    await sendToDiscord(url, wanted)
  }

  listProviders(): { id: string; label: string; host: string; port: number; requiresAppPassword: boolean; setupNote: string | null }[] {
    return PROVIDERS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      host: preset.host,
      port: preset.port,
      requiresAppPassword: preset.requiresAppPassword,
      setupNote: preset.setupNote,
    }))
  }

  /**
   * The AYCD Inbox key, kept the same way mail passwords are: encrypted by the
   * injected cipher and never written, returned or logged in plaintext.
   */
  setAycdApiKey(apiKey: string): void {
    const trimmed = apiKey.trim()
    if (trimmed.length === 0) {
      this.clearAycdApiKey()
      return
    }
    this.setSetting(AYCD_KEY_SETTING, this.encryptor.encrypt(trimmed))
  }

  clearAycdApiKey(): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(AYCD_KEY_SETTING)
    void this.stopAycdWatch()
  }

  /** Never exposed over IPC: reading the key has to be a deliberate act inside
   *  this process, exactly as with account passwords. */
  private aycdApiKey(): string | null {
    const cipher = this.getSetting(AYCD_KEY_SETTING)
    if (!cipher) return null
    try {
      return this.encryptor.decrypt(cipher)
    } catch {
      return null
    }
  }

  /** The addresses Inbox should watch. Stored as JSON so the set survives a
   *  restart; a malformed value is treated as none rather than as a crash. */
  /**
   * Addresses AYCD Inbox watches.
   *
   * With none configured, every connected mailbox is watched: that is the
   * obvious intent, and an empty list would otherwise mean Inbox silently
   * watches nothing at all.
   */
  listAycdAddresses(): string[] {
    const stored = this.getSetting(AYCD_ADDRESSES_SETTING)
    const configured = stored
      ? (JSON.parse(stored) as string[]).map((a) => a.trim()).filter(Boolean)
      : []
    if (configured.length > 0) return configured
    return this.accounts.list().filter((a) => a.enabled).map((a) => a.email)
  }

  setAycdAddresses(addresses: string[]): string[] {
    const cleaned = [...new Set(
      addresses.map((address) => address.trim().toLowerCase()).filter((address) => address.length > 0),
    )]
    this.setSetting(AYCD_ADDRESSES_SETTING, JSON.stringify(cleaned))
    this.aycd?.setAddresses(cleaned)
    return cleaned
  }

  /** Confirms the key works and that the Inbox desktop application is running. */
  async verifyAycd(): Promise<{ ok: boolean; message: string }> {
    const apiKey = this.aycdApiKey()
    if (!apiKey) return { ok: false, message: 'No AYCD Inbox API key is stored.' }
    return new AycdClient({ apiKey }).verify()
  }

  /**
   * Starts capturing mail as it arrives.
   *
   * Inbox is forward-looking: this catches what lands from now on and can never
   * fetch what already has. It complements the IMAP sync rather than replacing
   * it, so both can run at once.
   *
   * The transport and clock are injectable purely so tests can drive the loop
   * without a network or a timer; the application passes neither.
   */
  startAycdWatch(
    overrides: { transport?: InboxTransport; clock?: WatcherClock } = {},
  ): { started: boolean; message: string } {
    if (this.aycd?.status().running) {
      return { started: true, message: 'AYCD Inbox capture is already running.' }
    }

    const apiKey = this.aycdApiKey()
    if (!apiKey && !overrides.transport) {
      return { started: false, message: 'No AYCD Inbox API key is stored.' }
    }

    const addresses = this.listAycdAddresses()
    if (addresses.length === 0) {
      return { started: false, message: 'No addresses are set for AYCD Inbox to watch.' }
    }

    this.aycd = new AycdWatcher({
      client: overrides.transport ?? new AycdClient({ apiKey: apiKey! }),
      clock: overrides.clock ?? systemClock,
      addresses,
      onEvent: (captured) => this.recordAycdCapture(captured),
      onError: (message) => this.setSetting(AYCD_ERROR_SETTING, message),
    })
    this.aycd.start()
    return { started: true, message: `Watching ${addresses.length} address(es) for new mail.` }
  }

  /** The watcher is kept after stopping so its tally stays readable; only a
   *  fresh `startAycdWatch` replaces it. */
  async stopAycdWatch(): Promise<void> {
    if (!this.aycd) return
    this.aycd.stop()
    await this.aycd.drain()
  }

  aycdStatus(): AycdStatusView {
    const status = this.aycd?.status()
    return {
      configured: this.getSetting(AYCD_KEY_SETTING) !== null,
      running: status?.running ?? false,
      addresses: status?.addresses ?? this.listAycdAddresses(),
      templates: status?.templates ?? AYCD_TASK_BUILDERS.length,
      activeTasks: status?.activeTasks ?? 0,
      registered: status?.registered ?? 0,
      succeeded: status?.succeeded ?? 0,
      timedOut: status?.timedOut ?? 0,
      errored: status?.errored ?? 0,
      events: status?.events ?? 0,
      lastPollAt: status?.lastPollAt ?? null,
      lastError: status?.lastError ?? this.getSetting(AYCD_ERROR_SETTING),
    }
  }

  /**
   * Stores one capture.
   *
   * Inbox returns extracted fields and no message, so there is nothing to
   * retain and nothing to re-parse later. A stand-in message row is written
   * anyway, because events hang off one and because it gives the capture a
   * place in the pipeline; its content hash is the Inbox task id, which makes
   * recording the same capture twice a no-op.
   */
  private recordAycdCapture(captured: CapturedEvent): void {
    const now = new Date().toISOString()
    const { event } = captured
    const message = this.messages.upsert({
      accountId: 'local-import',
      uid: 0,
      folder: 'AYCD',
      messageId: null,
      contentHash: hashContent(`aycd:${captured.taskId}`),
      fromAddress: `${event.retailer}@aycd-inbox`,
      fromName: 'AYCD Inbox',
      subject: `${event.retailer} ${event.type} ${event.externalOrderId ?? '(no reference)'}`,
      receivedAt: event.occurredAt,
      rawPath: '',
      bodyPreview: JSON.stringify(event.payload).slice(0, 400),
    })

    this.events.replaceForMessage(message.id, captured.builderId, [event], now)
    this.messages.markParsed(message.id, captured.builderId, now)
    this.reconciler.run(now)
  }

  summary(): SummaryView {
    const purchases = this.listPurchases()
    const spend = purchases.reduce((sum, purchase) => sum + purchase.totalMinor, 0)
    const shipments = this.listShipments()
    const inventory = this.listInventory()
    const held = inventory.filter((item) => ['incoming', 'in_stock', 'listed'].includes(item.status))
    const heldEvents = this.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE reconciled_at IS NULL')
      .get() as { n: number }
    return {
      units: held.length,
      capitalTiedUp: formatMoney(money(held.reduce((sum, item) => sum + item.costMinor, 0), 'EUR')),
      heldEvents: heldEvents.n,
      messageCount: (this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n,
      eventCount: (this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
      purchaseCount: purchases.length,
      spend: formatMoney(money(spend, 'EUR')),
      inbound: shipments.filter((s) => s.direction === 'inbound' && s.status !== 'delivered').length,
      outbound: shipments.filter((s) => s.direction === 'outbound' && s.status !== 'delivered').length,
      reviewCount: this.listReviewQueue().length,
      awaitingTracking: shipments.filter((s) => s.trackingNumber === null).length,
      redirectable: shipments.filter((s) => s.dhlRedirectable).length,
    }
  }

  /** Rows for the DHL ServicePoint redirect tool's `trackings.csv`. */
  redirectCsv(): string {
    const rows = this.listShipments().filter(
      (shipment) => shipment.carrier === 'dhl' && shipment.postalCode && shipment.trackingNumber,
    )
    return ['tracking,postalcode', ...rows.map((r) => `${r.trackingNumber},${r.postalCode}`)].join('\n')
  }

  private allEvents(): StoredEvent[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY occurred_at DESC').all() as {
      id: string
      message_id: string
      parser_id: string
      type: string
      retailer: string
      external_order_id: string | null
      occurred_at: string
      payload_json: string
      reconciled_at: string | null
    }[]
    return rows.map((row) => ({
      id: row.id,
      messageId: row.message_id,
      parserId: row.parser_id,
      type: row.type as StoredEvent['type'],
      retailer: row.retailer,
      externalOrderId: row.external_order_id,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      reconciledAt: row.reconciled_at,
    }))
  }
}

export interface ShipmentView {
  id: string
  direction: string
  carrier: string
  trackingNumber: string | null
  trackingUrl: string | null
  linked: string
  title: string | null
  quantity: number
  status: string
  lastMovementAt: string | null
  expectedDeliveryAt: string | null
  postalCode: string | null
  city: string | null
  dhlRedirectable: boolean
  linkedToPurchase: boolean
}

export interface PurchaseView {
  id: string
  /** `buy` for an order, `cancel` for a cancellation with no order to attach to. */
  kind: 'buy' | 'cancel'
  retailer: string
  reference: string | null
  orderedAt: string
  title: string | null
  quantity: number
  unit: string
  shipping: string
  total: string
  totalMinor: number
  totalsConsistent: boolean
  status: string
  refundOutstanding: string | null
}

export interface CancellationView {
  id: string
  retailer: string
  reference: string | null
  occurredAt: string
  title: string | null
  refundExpected: boolean
}

export interface ReviewView {
  id: string
  from: string
  address: string
  subject: string
  receivedAt: string
  preview: string
  /** False when no copy of the message was kept, so it cannot be sent on. */
  exportable: boolean
}

export interface ParserView {
  id: string
  retailer: string
  parsed: number
}

export type SyncProgressFn = (progress: {
  account: string
  done: number
  stored: number
  subject: string
}) => void

export interface ItemView {
  id: string
  title: string
  brand: string | null
  sku: string | null
  size: string | null
  condition: string
  status: string
  cost: string
  costMinor: number
  purchasedAt: string | null
  daysHeld: number | null
  location: string | null
  retailer: string | null
  orderRef: string | null
}

export interface AycdStatusView {
  configured: boolean
  running: boolean
  addresses: string[]
  templates: number
  activeTasks: number
  registered: number
  succeeded: number
  timedOut: number
  errored: number
  events: number
  lastPollAt: string | null
  lastError: string | null
}

export interface SummaryView {
  units: number
  capitalTiedUp: string
  heldEvents: number
  messageCount: number
  eventCount: number
  purchaseCount: number
  spend: string
  inbound: number
  outbound: number
  reviewCount: number
  awaitingTracking: number
  redirectable: number
}
