import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { openDatabase, type Db } from '../core/db/connection.js'
import { migrate } from '../core/db/migrations.js'
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

/**
 * Where a provider keeps everything.
 *
 * Gmail hides archived mail from INBOX but keeps it in All Mail, so syncing
 * only INBOX would miss any order confirmation that was archived or filtered.
 */
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

  constructor(databasePath: string, encryptor: Encryptor) {
    this.db = openDatabase(databasePath)
    migrate(this.db)
    this.messages = new MessageRepo(this.db)
    this.events = new EventRepo(this.db)
    this.reconciler = new Reconciler(this.db)
    this.accounts = new AccountRepo(this.db, encryptor)
    this.mailbox = new MailboxSync(this.db)
    this.ensureLocalAccount()
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

  /** Shipments derived from `shipped` events, shaped for the shipments screen. */
  listShipments(): ShipmentView[] {
    const events = this.allEvents().filter((event) => event.type === 'shipped')
    return events.map((event) => {
      const payload = event.payload as Record<string, unknown>
      return {
        id: event.id,
        direction: (payload.direction as string) ?? 'inbound',
        carrier: (payload.carrier as string) ?? 'unknown',
        trackingNumber: (payload.trackingNumber as string | null) ?? null,
        trackingUrl: (payload.trackingUrl as string | null) ?? null,
        linked: `${event.retailer} · ${event.externalOrderId ?? '—'}`,
        title: (payload.title as string | null) ?? null,
        quantity: (payload.quantity as number) ?? 1,
        status: payload.trackingNumber ? 'in_transit' : 'pending',
        lastMovementAt: null,
        expectedDeliveryAt: (payload.expectedDeliveryAt as string | null) ?? null,
        postalCode: (payload.deliveryPostalCode as string | null) ?? null,
        city: (payload.deliveryCity as string | null) ?? null,
        dhlRedirectable: Boolean(payload.dhlRedirectable),
      }
    })
  }

  listPurchases(): PurchaseView[] {
    return this.allEvents()
      .filter((event) => event.type === 'order_placed')
      .map((event) => {
        const payload = event.payload as Record<string, unknown>
        const currency = (payload.currency as Money['currency']) ?? 'EUR'
        const total = money((payload.totalMinor as number) ?? 0, currency)
        return {
          id: event.id,
          retailer: event.retailer,
          reference: event.externalOrderId,
          orderedAt: event.occurredAt,
          title: (payload.title as string | null) ?? null,
          quantity: (payload.quantity as number) ?? 1,
          unit: formatMoney(money((payload.unitMinor as number) ?? 0, currency)),
          shipping: formatMoney(money((payload.shippingMinor as number) ?? 0, currency)),
          total: formatMoney(total),
          totalMinor: total.minor,
          totalsConsistent: Boolean(payload.totalsConsistent),
          status: 'confirmed',
        }
      })
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

  listReviewQueue(): ReviewView[] {
    return this.messages.listByStatus('unrecognized').map((message) => ({
      id: message.id,
      from: message.fromName ?? message.fromAddress,
      address: message.fromAddress,
      subject: message.subject,
      receivedAt: message.receivedAt,
      preview: message.bodyPreview,
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
  async syncAccounts(folder?: string): Promise<{
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
          async ({ accountId, folder: f, uid, raw }) => this.ingestRaw(accountId, f, uid, raw),
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
      rawPath: '',
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
}

export interface PurchaseView {
  id: string
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
}

export interface ParserView {
  id: string
  retailer: string
  parsed: number
}

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
