import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { simpleParser } from 'mailparser'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, type Db } from '../core/db/connection.js'
import { migrate, currentVersion } from '../core/db/migrations.js'
import { MessageRepo, hashContent } from '../core/repos/messages.js'
import { EventRepo, type StoredEvent } from '../core/repos/events.js'
import { loadEml, textOf } from '../core/mail/parsed-message.js'
import { ParserRegistry } from '../core/parsers/registry.js'
import { BOL_PARSERS } from '../core/parsers/bol.js'
import { DHL_PARSERS } from '../core/parsers/dhl.js'
import { POSTNL_PARSERS } from '../core/parsers/postnl.js'
import { VINTED_PARSERS } from '../core/parsers/vinted.js'
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
import {
  resolveTrackingLink, isNonCarrierBolLanding, type ResolvedTracking,
} from '../core/tracking/resolve-link.js'
import { carrierTrackingUrl } from '../core/tracking/carrier-url.js'
import { redirectParcel, type Page, type ServicePoint } from '../core/tracking/redirect.js'
import {
  fetchShipment, summarizeShipment, toShipmentStatus, type Fetcher,
} from '../core/tracking/dhl-status.js'
import { breakDownSale, vatWithinCost, NL_VAT_BASIS_POINTS } from '../core/sell.js'
import { toNotification } from '../core/notify/from-events.js'
import { findParcel, foldShipment, furthestStatus, mergeInto } from '../core/reconcile/shipment-merge.js'
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
/**
 * How old something can be and still be worth announcing.
 *
 * A first sync reaches a week back, and nobody wants last Tuesday's parcel
 * announced as though it just happened.
 */
const NOTIFY_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** How far back a first sync reaches, unless someone says otherwise. */
const DEFAULT_LOOKBACK_DAYS = 7
const SYNC_LOOKBACK_SETTING = 'sync_lookback_days'

/** Where DHL sends the confirmation when a parcel is redirected. */
const REDIRECT_EMAIL_SETTING = 'redirect_email'
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
    // After the retailers: a retailer's own mail is the better source of what
    // was bought, and DHL's mail is the better source of when it arrives.
    ...DHL_PARSERS,
    ...POSTNL_PARSERS,
    ...VINTED_PARSERS,
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
    this.repairUnlinkedSales()
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

  /**
   * What the parsers extracted when the stored events were made.
   *
   * This used to be a number to bump by hand, and the hand forgot: 0.2.0 taught
   * the parsers about delivery windows and about DHL's own mail, and every
   * message already stored kept its older, thinner event. So the marker is the
   * application's version instead. Mail already read is read again once after
   * every upgrade, which costs seconds in the background and means a parser
   * improvement always reaches the mail it was written for.
   */
  static readonly PARSER_GENERATION = 'dev'

  /** True when the mail already read was read by an older build. */
  needsReparse(generation: string = AppService.PARSER_GENERATION): boolean {
    return this.getSetting('parser_generation') !== generation
  }

  markReparsed(generation: string = AppService.PARSER_GENERATION): void {
    this.setSetting('parser_generation', generation)
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
        // Facts about the envelope are re-read too: the address a mail was
        // sent to was not recorded until recently, and the stored copy still
        // has it.
        this.db.prepare('UPDATE messages SET to_address = COALESCE(?, to_address) WHERE id = ?')
          .run(parsed.toAddress, row.id)
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
    // A barcode was not in the mail: it came from following a link, and a
    // redirect came from someone choosing to send a parcel elsewhere. Neither
    // can be derived again from the events, so both are carried across the
    // rebuild rather than thrown away with the rows they sit on.
    const parcels = this.db.prepare(
      `SELECT id, direction, carrier, tracking_number, tracking_url, postal_code, status,
              delivery_window, expected_delivery_at, last_polled_at, created_at
       FROM shipments WHERE tracking_number IS NOT NULL`,
    ).all() as Record<string, string | null>[]
    const redirects = this.db.prepare('SELECT * FROM redirects').all() as Record<string, unknown>[]
    // A sale made by hand is not derived from mail and cannot be derived again.
    // Deleting the items unhooks every sale from what it sold, so the links are
    // taken first and put back afterwards — the item ids are deterministic, so
    // they come back exactly as they were.
    const sales = this.db.prepare(
      'SELECT id, item_id FROM sales WHERE item_id IS NOT NULL',
    ).all() as { id: string; item_id: string }[]

    const rebuild = this.db.transaction(() => {
      this.db.exec('DELETE FROM refunds')
      this.db.exec('DELETE FROM items')
      this.db.exec('DELETE FROM shipments')
      this.db.exec('DELETE FROM purchases')
      this.db.exec('UPDATE events SET reconciled_at = NULL')

      // Put the known parcels back before anything is re-applied, rather than
      // afterwards. A carrier's mail is recognised by its barcode, so the
      // barcode has to be there when the mail is read again — otherwise the
      // same parcel is recorded twice and the original loses the code that
      // took a network round trip to find.
      for (const parcel of parcels) {
        this.db.prepare(
          `INSERT INTO shipments
             (id, direction, carrier, tracking_number, tracking_url, postal_code, status,
              delivery_window, expected_delivery_at, last_polled_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          parcel.id,
          parcel.direction ?? 'inbound',
          parcel.carrier ?? 'unknown',
          parcel.tracking_number,
          parcel.tracking_url,
          parcel.postal_code,
          parcel.status ?? 'in_transit',
          parcel.delivery_window,
          parcel.expected_delivery_at,
          parcel.last_polled_at,
          parcel.created_at ?? now,
        )
      }
    })
    rebuild()
    const result = this.reconciler.run(now)
    this.restoreRedirects(redirects)
    this.restoreSales(sales)
    return result
  }

  /**
   * Reconnects sales that lost the unit they sold.
   *
   * Before this was fixed, re-reading mail deleted the items and left every
   * hand-made sale pointing at nothing: the units went back into stock and
   * their money counted as profit with no cost against it. The sale's identity
   * is derived from the unit and the date it was sold, so the pairing can be
   * worked out again rather than being lost — which matters, because a sale is
   * something a person recorded and nothing else can re-derive it.
   */
  private repairUnlinkedSales(): void {
    const orphans = this.db.prepare(
      "SELECT id, sold_at FROM sales WHERE item_id IS NULL AND marketplace = 'offline'",
    ).all() as { id: string; sold_at: string }[]
    if (orphans.length === 0) return

    const items = this.db.prepare('SELECT id FROM items').all() as { id: string }[]
    const claimed = new Set(
      (this.db.prepare('SELECT item_id FROM sales WHERE item_id IS NOT NULL').all() as
        { item_id: string }[]).map((row) => row.item_id),
    )

    let repaired = 0
    for (const orphan of orphans) {
      const match = items.find(
        (item) => !claimed.has(item.id) && saleKey(item.id, orphan.sold_at) === orphan.id,
      )
      if (!match) continue
      this.db.prepare('UPDATE sales SET item_id = ? WHERE id = ?').run(match.id, orphan.id)
      this.db.prepare("UPDATE items SET status = 'sold' WHERE id = ?").run(match.id)
      claimed.add(match.id)
      repaired += 1
    }

    if (repaired > 0) {
      this.setSetting('sales_repaired_at', new Date().toISOString())
    }
  }

  /**
   * Puts hand-made sales back on the rebuilt items.
   *
   * A sold unit is sold whatever the mail says: the mail describes buying it,
   * never selling it, so the rebuild has nothing to re-derive from.
   */
  private restoreSales(sales: { id: string; item_id: string }[]): void {
    for (const sale of sales) {
      const exists = this.db.prepare('SELECT 1 FROM items WHERE id = ?').get(sale.item_id)
      if (!exists) continue
      this.db.prepare('UPDATE sales SET item_id = ? WHERE id = ?').run(sale.item_id, sale.id)
      this.db.prepare("UPDATE items SET status = 'sold' WHERE id = ?").run(sale.item_id)
    }
  }

  /** Puts redirect records back on the rebuilt parcels. */
  private restoreRedirects(redirects: Record<string, unknown>[]): void {
    for (const redirect of redirects) {
      const exists = this.db
        .prepare('SELECT 1 FROM shipments WHERE id = ?')
        .get(redirect.shipment_id as string)
      if (!exists) continue
      this.db.prepare(
        `INSERT INTO redirects
           (shipment_id, tracking_number, outcome, message, service_point, dry_run, attempted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shipment_id) DO NOTHING`,
      ).run(
        redirect.shipment_id,
        redirect.tracking_number,
        redirect.outcome,
        redirect.message,
        redirect.service_point,
        redirect.dry_run,
        redirect.attempted_at,
      )
    }
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
      toAddress: parsed.toAddress,
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
      `SELECT s.*, e.payload_json, e.retailer, e.external_order_id,
              p.title AS purchase_title,
              (SELECT COUNT(*) FROM items i WHERE i.purchase_id = s.purchase_id) AS item_count,
              (SELECT i.image_url FROM items i
                WHERE i.purchase_id = s.purchase_id AND i.image_url IS NOT NULL
                LIMIT 1) AS item_image,
              r.outcome AS redirect_outcome, r.message AS redirect_message,
              r.service_point AS redirect_point, r.attempted_at AS redirect_at
       FROM shipments s
       LEFT JOIN events e ON e.id = s.id
       LEFT JOIN purchases p ON p.id = s.purchase_id
       LEFT JOIN redirects r ON r.shipment_id = s.id
       ORDER BY s.created_at DESC`,
    ).all() as Record<string, unknown>[]

    return rows.map((row) => {
      const payload = row.payload_json
        ? (JSON.parse(row.payload_json as string) as Record<string, unknown>)
        : {}
      const reference = (row.external_order_id as string | null) ?? null
      const carrier = row.carrier as string
      const trackingNumber = (row.tracking_number as string | null) ?? null
      const postalCode = (payload.deliveryPostalCode as string | null)
        ?? (row.postal_code as string | null)
        ?? null
      // Once the barcode and the postcode are both known, the carrier's own
      // page can be addressed directly — which beats the retailer's redirect,
      // and is the page that offers to redirect the parcel.
      const built = carrierTrackingUrl(carrier, trackingNumber, postalCode)
      return {
        id: row.id as string,
        direction: row.direction as string,
        carrier,
        trackingNumber,
        trackingUrl: built ?? (row.tracking_url as string | null) ?? null,
        linked: `${(row.retailer as string) ?? 'unknown'} \u00b7 ${reference ?? '\u2014'}`,
        // The shipping mail names the contents; where it did not, the linked
        // order does, which is the point of matching them at all.
        title: (payload.title as string | null) ?? (row.purchase_title as string | null) ?? null,
        // The shipping mail's own picture first, then the one the order left
        // on the item it is carrying.
        imageUrl: (payload.imageUrl as string | null) ?? (row.item_image as string | null) ?? null,
        quantity: (payload.quantity as number) ?? (row.item_count as number) ?? 1,
        // "Awaiting code" cannot be true of a parcel whose code is right
        // there. Rows that kept the earlier status are read as followable
        // rather than needing a migration to say so.
        status: trackingNumber && row.status === 'pending' ? 'in_transit' : (row.status as string),
        lastMovementAt: (row.last_movement_at as string | null) ?? null,
        expectedDeliveryAt: (row.expected_delivery_at as string | null) ?? null,
        // The parcel's own record first: the mail that stated the window may
        // have been folded into this parcel rather than being its own row.
        deliveryWindow: (row.delivery_window as string | null)
          ?? (payload.deliveryWindow as string | null)
          ?? null,
        postalCode,
        city: (payload.deliveryCity as string | null) ?? null,
        // Redirectable means it can be done now: DHL, barcode and postcode
        // all present. The mail's own hint only ever said the postcode was
        // there, which is half the requirement.
        dhlRedirectable: carrier === 'dhl' && trackingNumber !== null && postalCode !== null,
        hasLabel: row.label_message_id !== null,
        redirect: row.redirect_outcome
          ? {
            outcome: row.redirect_outcome as string,
            message: (row.redirect_message as string | null) ?? '',
            servicePoint: (row.redirect_point as string | null) ?? null,
            attemptedAt: (row.redirect_at as string | null) ?? null,
          }
          : null,
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
                WHERE r.purchase_id = p.id AND r.received_at IS NULL) AS refund_outstanding,
              (SELECT s.carrier FROM shipments s WHERE s.purchase_id = p.id LIMIT 1) AS carrier,
              (SELECT s.tracking_number FROM shipments s WHERE s.purchase_id = p.id LIMIT 1) AS tracking_number,
              (SELECT s.status FROM shipments s WHERE s.purchase_id = p.id LIMIT 1) AS shipment_status,
              -- The mailbox the order arrived in. With more than one connected
              -- it is the difference between two accounts buying the same
              -- thing, and it is the mail this row was built from.
              -- The address the mail was sent to, which is not always the
              -- mailbox that collected it: an alias or a forward means one
              -- mailbox gathers mail for many addresses.
              (SELECT COALESCE(m.to_address, a.email) FROM events e
                 JOIN messages m ON m.id = e.message_id
                 JOIN accounts a ON a.id = m.account_id
                WHERE e.retailer = p.retailer AND e.external_order_id = p.external_order_id
                ORDER BY e.occurred_at LIMIT 1) AS mailbox,
              (SELECT m.subject FROM events e
                 JOIN messages m ON m.id = e.message_id
                WHERE e.retailer = p.retailer AND e.external_order_id = p.external_order_id
                ORDER BY e.occurred_at LIMIT 1) AS mail_subject
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
        mailbox: (row.mailbox as string | null) ?? null,
        mailSubject: (row.mail_subject as string | null) ?? null,
        quantity: (row.item_count as number) || 1,
        unit: formatMoney(money((row.unit_minor as number) ?? 0, currency)),
        shipping: formatMoney(money(row.shipping_minor as number, currency)),
        total: formatMoney(total),
        totalMinor: total.minor,
        totalsConsistent: row.totals_consistent === 1,
        status: row.status as string,
        refundOutstanding: outstanding > 0 ? formatMoney(money(outstanding, currency)) : null,
        carrier: (row.carrier as string | null) ?? null,
        trackingNumber: (row.tracking_number as string | null) ?? null,
        shipmentStatus: (row.shipment_status as string | null) ?? null,
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
        mailbox: c.mailbox,
        mailSubject: c.mailSubject,
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
    const mailboxes = new Map(
      (this.db.prepare(
        `SELECT e.id, COALESCE(m.to_address, a.email) AS email, m.subject FROM events e
           JOIN messages m ON m.id = e.message_id
           JOIN accounts a ON a.id = m.account_id`,
      ).all() as { id: string; email: string; subject: string }[])
        .map((row) => [row.id, row]),
    )

    return this.allEvents()
      .filter((event) => event.type === 'cancelled')
      .map((event) => ({
        id: event.id,
        retailer: event.retailer,
        reference: event.externalOrderId,
        occurredAt: event.occurredAt,
        title: (event.payload.title as string | null) ?? null,
        mailbox: mailboxes.get(event.id)?.email ?? null,
        mailSubject: mailboxes.get(event.id)?.subject ?? null,
        refundExpected: Boolean(event.payload.refundExpected),
      }))
  }

  /** Individual units, straight out of the reconciled `items` table. */
  listInventory(): ItemView[] {
    const rows = this.db.prepare(
      `SELECT i.*,
              p.retailer AS retailer,
              p.external_order_id AS order_ref,
              p.status AS purchase_status,
              (SELECT s.carrier FROM shipments s WHERE s.purchase_id = i.purchase_id LIMIT 1) AS carrier,
              (SELECT s.tracking_number FROM shipments s WHERE s.purchase_id = i.purchase_id LIMIT 1) AS tracking_number,
              (SELECT s.status FROM shipments s WHERE s.purchase_id = i.purchase_id LIMIT 1) AS shipment_status,
              (SELECT s.expected_delivery_at FROM shipments s WHERE s.purchase_id = i.purchase_id LIMIT 1) AS expected,
              sa.gross_minor AS sold_gross, sa.vat_minor AS sold_vat, sa.buyer AS buyer,
              sa.sold_at AS sold_at, sa.marketplace AS sold_via
       FROM items i
       LEFT JOIN purchases p ON p.id = i.purchase_id
       LEFT JOIN sales sa ON sa.item_id = i.id
       ORDER BY i.purchased_at DESC, i.id`,
    ).all() as Record<string, unknown>[]

    const today = Date.now()
    return rows.map((row) => {
      const purchasedAt = row.purchased_at as string | null
      const daysHeld = purchasedAt
        ? Math.max(0, Math.floor((today - Date.parse(purchasedAt)) / 86_400_000))
        : null
      // Retailer mail states prices with VAT in them, so the VAT inside a cost
      // is money that comes back rather than money spent.
      const costMinor = row.cost_minor as number
      const costVatMinor = vatWithinCost(costMinor)
      const soldGross = (row.sold_gross as number | null) ?? null
      const soldVat = (row.sold_vat as number | null) ?? null
      // What it fetched less what it cost. The VAT on both sides is carried
      // separately, for the return, rather than being netted out here.
      const profitMinor = soldGross === null ? null : soldGross - costMinor

      return {
        id: row.id as string,
        title: row.title as string,
        imageUrl: (row.image_url as string | null) ?? null,
        costVatMinor,
        costNetMinor: costMinor - costVatMinor,
        soldMinor: soldGross,
        sold: soldGross === null ? null : formatMoney(money(soldGross, 'EUR')),
        soldVatMinor: soldVat,
        soldAt: (row.sold_at as string | null) ?? null,
        soldVia: (row.sold_via as string | null) ?? null,
        buyer: (row.buyer as string | null) ?? null,
        profitMinor,
        profit: profitMinor === null ? null : formatMoney(money(profitMinor, 'EUR')),
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
        carrier: (row.carrier as string | null) ?? null,
        trackingNumber: (row.tracking_number as string | null) ?? null,
        shipmentStatus: (row.shipment_status as string | null) ?? null,
        expectedDeliveryAt: (row.expected as string | null) ?? null,
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
          { limit: 500, initialLookbackDays: this.syncLookbackDays() },
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
      toAddress: parsed.toAddress,
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
    options: {
      limit?: number
      onProgress?: (done: number, total: number) => void
      /** Injected in tests; the real one follows the link over the network. */
      resolve?: typeof resolveTrackingLink
    } = {},
  ): Promise<{ attempted: number; resolved: number; failed: number }> {
    const follow = options.resolve ?? resolveTrackingLink
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

      let found: ResolvedTracking | null = null
      for (const candidate of candidates) {
        const result = await follow(candidate)
        // Landing on the retailer's own login page means this link was never a
        // tracking link; try the next candidate rather than giving up.
        if (result && !isNonCarrierBolLanding(result.finalUrl)) {
          found = result
          break
        }
      }

      if (found) {
        // Now that the barcode is known, the carrier's own page can be stored
        // in place of the retailer redirect that expires.
        // DHL states the postcode in its own tracking URL, so a parcel whose
        // mail never gave an address can still get one.
        const postalCode = (payload.deliveryPostalCode as string | null)
          ?? found.postalCode
          ?? null
        const direct = carrierTrackingUrl(found.carrier, found.trackingNumber, postalCode)

        // Another mail about this same parcel may have resolved first. Two
        // rows for one barcode is what the unique index exists to prevent, so
        // this one is folded into the row that got there first rather than
        // failing the sync.
        const existing = findParcel(this.db, found.carrier, found.trackingNumber, row.id)
        if (existing) {
          foldShipment(this.db, row.id, existing)
          mergeInto(this.db, existing, {
            // The parcel is followable now, whichever of the two rows was kept.
            status: 'in_transit',
            trackingUrl: direct ?? found.finalUrl ?? null,
            postalCode,
            lastPolledAt: new Date().toISOString(),
          })
          resolved += 1
          options.onProgress?.(index + 1, rows.length)
          continue
        }

        // Finding the barcode says the parcel is followable, not that it is
        // back at the depot: a parcel already out with the courier stays out
        // with the courier.
        const current = this.db
          .prepare('SELECT status FROM shipments WHERE id = ?')
          .get(row.id) as { status: string } | undefined
        this.db.prepare(
          `UPDATE shipments
           SET tracking_number = ?, carrier = ?, tracking_url = COALESCE(?, tracking_url),
               postal_code = COALESCE(?, postal_code), status = ?, last_polled_at = ?
           WHERE id = ?`,
        ).run(
          found.trackingNumber,
          found.carrier,
          direct ?? found.finalUrl ?? null,
          postalCode,
          furthestStatus(current?.status ?? null, 'in_transit'),
          new Date().toISOString(),
          row.id,
        )
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

  /**
   * Removes one record by hand.
   *
   * The event that produced it is marked as ignored rather than deleted, so a
   * later re-parse does not quietly bring back something deliberately removed —
   * which would make manual deletion feel broken rather than final.
   */
  deleteRecord(kind: 'item' | 'purchase' | 'shipment' | 'sale', id: string): { deleted: boolean } {
    const remove = this.db.transaction(() => {
      if (kind === 'item') {
        this.db.prepare('DELETE FROM items WHERE id = ?').run(id)
        return
      }
      if (kind === 'purchase') {
        // Its units and refunds go with it; keeping them would leave stock
        // belonging to an order that no longer exists.
        this.db.prepare('DELETE FROM items WHERE purchase_id = ?').run(id)
        this.db.prepare('DELETE FROM refunds WHERE purchase_id = ?').run(id)
        this.db.prepare('UPDATE shipments SET purchase_id = NULL WHERE purchase_id = ?').run(id)
        this.suppressPurchase(id)
        this.db.prepare('DELETE FROM purchases WHERE id = ?').run(id)
        return
      }
      if (kind === 'shipment') {
        this.suppress('shipment', id)
        this.db.prepare('DELETE FROM shipments WHERE id = ?').run(id)
        return
      }
      this.db.prepare('DELETE FROM sales WHERE id = ?').run(id)
    })
    remove()
    return { deleted: true }
  }

  private suppress(kind: string, key: string): void {
    this.db.prepare(
      `INSERT INTO suppressions (kind, key, created_at) VALUES (?, ?, ?)
       ON CONFLICT(kind, key) DO NOTHING`,
    ).run(kind, key, new Date().toISOString())
  }

  /** Remembers the order itself, not the events that produced it, so a later
   *  re-read cannot bring it back. */
  private suppressPurchase(id: string): void {
    const row = this.db
      .prepare('SELECT retailer, external_order_id FROM purchases WHERE id = ?')
      .get(id) as { retailer: string; external_order_id: string | null } | undefined
    if (!row?.external_order_id) return
    this.suppress('purchase', `${row.retailer}|${row.external_order_id}`)
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
  /**
   * Events that have happened and not yet been announced.
   *
   * Read from the reconciled record rather than from the sync, so a parcel
   * that changed status through any route — mail, a resolved barcode, a
   * re-read — is announced exactly once.
   */
  pendingNotifications(
    limit = 50,
    now = Date.now(),
  ): { id: string; input: NotificationInput; subject: string }[] {
    const rows = this.db.prepare(
      `SELECT e.id, e.type, e.retailer, e.external_order_id, e.occurred_at, e.payload_json,
              s.carrier AS parcel_carrier, s.tracking_number AS parcel_tracking,
              s.tracking_url AS parcel_url, s.status AS parcel_status,
              s.id AS parcel_id,
              s.expected_delivery_at AS parcel_expected, s.delivery_window AS parcel_window,
              pu.retailer AS parcel_retailer, pu.title AS parcel_title,
              (SELECT COUNT(*) FROM items i WHERE i.purchase_id = s.purchase_id) AS parcel_units,
              (SELECT group_concat(t, ' + ') FROM
                (SELECT DISTINCT i.title AS t FROM items i
                  WHERE i.purchase_id = s.purchase_id LIMIT 3)) AS parcel_contents,
              -- Where no order is linked, the mail that created the parcel
              -- still named what is in it.
              (SELECT json_extract(e2.payload_json, '$.title') FROM events e2
                WHERE e2.id = s.id) AS parcel_own_title,
              (SELECT e2.retailer FROM events e2 WHERE e2.id = s.id) AS parcel_own_retailer
       FROM events e
       LEFT JOIN shipments s
         ON s.id = COALESCE((SELECT m.into_id FROM parcel_merges m WHERE m.event_id = e.id), e.id)
       LEFT JOIN purchases pu ON pu.id = s.purchase_id
       WHERE e.reconciled_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM notifications_sent n WHERE n.event_id = e.id)
       ORDER BY e.occurred_at
       LIMIT ?`,
    ).all(limit) as Record<string, unknown>[]

    const pending: { id: string; input: NotificationInput; subject: string }[] = []
    const announcedHere = new Set<string>()
    for (const row of rows) {
      const input = toNotification({
        id: row.id as string,
        type: row.type as string,
        retailer: row.retailer as string,
        externalOrderId: (row.external_order_id as string | null) ?? null,
        occurredAt: row.occurred_at as string,
        payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
        parcel: row.parcel_status
          ? {
            carrier: (row.parcel_carrier as string | null) ?? null,
            trackingNumber: (row.parcel_tracking as string | null) ?? null,
            trackingUrl: (row.parcel_url as string | null) ?? null,
            status: (row.parcel_status as string | null) ?? null,
            expectedDeliveryAt: (row.parcel_expected as string | null) ?? null,
            deliveryWindow: (row.parcel_window as string | null) ?? null,
            // What the parcel holds, so a delivery can say what arrived.
            contents: (row.parcel_contents as string | null)
              ?? (row.parcel_title as string | null)
              ?? (row.parcel_own_title as string | null)
              ?? null,
            units: (row.parcel_units as number | null) ?? null,
            retailer: (row.parcel_retailer as string | null)
              ?? (row.parcel_own_retailer as string | null)
              ?? null,
          }
          : null,
      })
      // An event nobody asked to hear about is still marked, so it is not
      // reconsidered on every pass for the rest of its life.
      if (!input) {
        this.markNotified(row.id as string, row.type as string)
        continue
      }

      // A notification is news. Mail collected for the first time can be weeks
      // deep, and announcing a delivery that happened last Tuesday is noise —
      // it is recorded as said, and only what is actually recent goes out.
      const age = now - Date.parse(input.occurredAt)
      if (Number.isFinite(age) && age > NOTIFY_MAX_AGE_MS) {
        this.markNotified(row.id as string, input.event)
        continue
      }

      // The carrier and the retailer both announce the same arrival. Both
      // mails are real; only one of them is news.
      const subject = subjectKey(input, (row.parcel_id as string | null) ?? null)
      if (announcedHere.has(subject) || this.alreadyAnnounced(subject)) {
        this.markNotified(row.id as string, input.event, subject)
        continue
      }
      announcedHere.add(subject)

      pending.push({ id: row.id as string, input, subject })
    }
    return pending
  }

  /**
   * Announces what has happened since the last time.
   *
   * Discord takes at most ten embeds in a message, so this goes in tens, and a
   * batch is only marked as sent once Discord has actually accepted it — a
   * failed send is worth repeating, an announced delivery is not.
   *
   * With no webhook configured, everything is marked as seen without being
   * sent. Otherwise the day someone adds a webhook they would be told about
   * every parcel of the past month at once.
   */
  async flushNotifications(
    options: { send?: typeof sendToDiscord; limit?: number } = {},
  ): Promise<{ sent: number; skipped: number; failed: number }> {
    const pending = this.pendingNotifications(options.limit ?? 50)
    if (pending.length === 0) return { sent: 0, skipped: 0, failed: 0 }

    const url = this.discordWebhook()
    if (!url) {
      // No webhook at all is a decision: these events are recorded as said, so
      // adding one later does not replay the past.
      for (const { id, input, subject } of pending) this.markNotified(id, input.event, subject)
      return { sent: 0, skipped: pending.length, failed: 0 }
    }
    if (!isWebhookUrl(url)) {
      // A webhook is configured but cannot be read — a stored value that no
      // longer decrypts, most likely. Nothing is marked: losing notifications
      // silently over a fixable problem is the worst of both.
      return { sent: 0, skipped: 0, failed: pending.length }
    }

    const allowed = new Set(
      this.discordSettings().rules.filter((rule) => rule.enabled).map((rule) => rule.event),
    )
    const wanted: typeof pending = []
    for (const entry of pending) {
      if (allowed.has(entry.input.event)) wanted.push(entry)
      else this.markNotified(entry.id, entry.input.event, entry.subject)
    }
    if (wanted.length === 0) return { sent: 0, skipped: pending.length, failed: 0 }

    const send = options.send ?? sendToDiscord
    let sent = 0
    let failed = 0

    for (let index = 0; index < wanted.length; index += 10) {
      const batch = wanted.slice(index, index + 10)
      const result = await send(url, batch.map((entry) => entry.input))
      if (!result.ok) {
        failed += batch.length
        // Stop at the first refusal: the rest would fail the same way, and a
        // rate limit is best answered by waiting rather than by pressing on.
        break
      }
      for (const entry of batch) {
        this.markNotified(entry.id, entry.input.event, entry.subject)
      }
      sent += batch.length
    }

    return { sent, skipped: pending.length - wanted.length, failed }
  }

  private markNotified(eventId: string, event: string, subject: string | null = null): void {
    this.db.prepare(
      `INSERT INTO notifications_sent (event_id, event, subject_key, sent_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    ).run(eventId, event, subject, new Date().toISOString())
  }

  /** True when this same thing has already been announced by another mail. */
  private alreadyAnnounced(subject: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM notifications_sent WHERE subject_key = ?')
      .get(subject) !== undefined
  }

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
      // A capture has no envelope of its own: Inbox reports the event, not the
      // mail it came from.
      toAddress: null,
      subject: `${event.retailer} ${event.type} ${event.externalOrderId ?? '(no reference)'}`,
      receivedAt: event.occurredAt,
      rawPath: '',
      bodyPreview: JSON.stringify(event.payload).slice(0, 400),
    })

    this.events.replaceForMessage(message.id, captured.builderId, [event], now)
    this.messages.markParsed(message.id, captured.builderId, now)
    this.reconciler.run(now)
  }

  /**
   * What the operation is doing, rather than what the plumbing is doing.
   *
   * Message and event counts say nothing about the business; how much was
   * bought, what is still coming, and where the money went does. Sales are
   * included in the money-in series even though no marketplace parser exists
   * yet, so the shape does not change when one is added.
   */
  dashboard(weeks = 12): DashboardView {
    const count = (sql: string, ...args: unknown[]): number =>
      (this.db.prepare(sql).get(...args) as { n: number }).n
    const sum = (sql: string, ...args: unknown[]): number =>
      (this.db.prepare(sql).get(...args) as { total: number | null }).total ?? 0

    const HELD = ["'incoming'", "'in_stock'", "'listed'"].join(',')

    // --- Pipeline: units at each stage, in the order they move through -----
    const STAGES: { key: string; label: string; hue: number }[] = [
      { key: 'incoming', label: 'Incoming', hue: 285 },
      { key: 'in_stock', label: 'In stock', hue: 250 },
      { key: 'listed', label: 'Listed', hue: 225 },
      { key: 'sold', label: 'Sold', hue: 195 },
      { key: 'shipped_to_buyer', label: 'Shipped', hue: 170 },
      { key: 'delivered', label: 'Delivered', hue: 148 },
    ]
    const funnel = STAGES.map((stage) => ({
      label: stage.label,
      hue: stage.hue,
      units: count('SELECT COUNT(*) AS n FROM items WHERE status = ?', stage.key),
      value: formatMoney(money(
        sum('SELECT SUM(cost_minor) AS total FROM items WHERE status = ?', stage.key), 'EUR',
      )),
    }))

    // --- What is bought most often ----------------------------------------
    // Grouped on the visible title with spacing and case ignored: the same
    // product arrives worded identically from a retailer but not always spaced
    // identically, and one row per spelling would answer nothing.
    const topProducts = this.db.prepare(
      `SELECT trim(replace(replace(title, char(10), ' '), '  ', ' ')) AS title,
              COUNT(*) AS units,
              SUM(cost_minor) AS spend,
              MAX(purchased_at) AS last_bought,
              MAX(image_url) AS image_url
       FROM items
       GROUP BY lower(trim(replace(replace(title, char(10), ' '), '  ', ' ')))
       ORDER BY units DESC, spend DESC
       LIMIT 6`,
    ).all() as {
      title: string; units: number; spend: number
      last_bought: string | null; image_url: string | null
    }[]

    // --- Profit: only real once a sale exists ------------------------------
    const revenue = sum('SELECT SUM(payout_minor) AS total FROM sales')
    const fees = sum('SELECT SUM(fees_minor) AS total FROM sales')
    const soldCost = sum(
      `SELECT SUM(i.cost_minor) AS total FROM items i
       JOIN sales sa ON sa.item_id = i.id`,
    )
    // Only sales whose goods are known can say what was earned. A marketplace
    // sale of something bought elsewhere has revenue and no cost, and counting
    // it as profit is how a dashboard ends up claiming money nobody made.
    const costedRevenue = sum(
      `SELECT SUM(sa.payout_minor) AS total FROM sales sa
       JOIN items i ON i.id = sa.item_id`,
    )
    const uncosted = count('SELECT COUNT(*) AS n FROM sales WHERE item_id IS NULL')
    const netProfit = costedRevenue - soldCost
    const salesRecorded = count('SELECT COUNT(*) AS n FROM sales')

    const channels = (this.db.prepare(
      `SELECT marketplace AS name, SUM(payout_minor) AS total
       FROM sales GROUP BY marketplace ORDER BY total DESC LIMIT 4`,
    ).all() as { name: string; total: number }[]).map((row) => ({
      name: row.name,
      value: formatMoney(money(row.total, 'EUR')),
      minor: row.total,
    }))

    // --- Capital tied up, month by month -----------------------------------
    const months: { label: string; capital: number }[] = []
    const now = new Date()
    for (let index = 5; index >= 0; index -= 1) {
      const point = new Date(now.getFullYear(), now.getMonth() - index + 1, 1)
      const iso = point.toISOString()
      months.push({
        label: point.toLocaleString('en-GB', { month: 'short' }),
        // Everything bought before this month that has not left stock: the
        // running total of money sitting in goods.
        capital: sum(
          `SELECT SUM(cost_minor) AS total FROM items
           WHERE purchased_at < ? AND status IN (${HELD})`,
          iso,
        ),
      })
    }

    // --- Aging: how long stock has been sitting ----------------------------
    const AGING: { bucket: string; from: number; to: number | null }[] = [
      { bucket: '0-30', from: 0, to: 30 },
      { bucket: '31-60', from: 31, to: 60 },
      { bucket: '61-90', from: 61, to: 90 },
      { bucket: '90+', from: 91, to: null },
    ]
    const today = Date.now()
    const heldRows = this.db.prepare(
      `SELECT cost_minor, purchased_at FROM items WHERE status IN (${HELD})`,
    ).all() as { cost_minor: number; purchased_at: string | null }[]

    const aging = AGING.map((band) => {
      const inBand = heldRows.filter((row) => {
        if (!row.purchased_at) return band.from === 0
        const days = Math.floor((today - Date.parse(row.purchased_at)) / 86_400_000)
        return days >= band.from && (band.to === null || days <= band.to)
      })
      return {
        bucket: band.bucket,
        units: inBand.length,
        value: formatMoney(money(inBand.reduce((total, row) => total + row.cost_minor, 0), 'EUR')),
        minor: inBand.reduce((total, row) => total + row.cost_minor, 0),
        stalled: band.bucket === '90+',
      }
    })

    // --- Money out and in, week by week ------------------------------------
    const series: { period: string; out: number; in: number }[] = []
    for (let index = weeks - 1; index >= 0; index -= 1) {
      const end = new Date(now.getTime() - index * 7 * 86_400_000)
      const start = new Date(end.getTime() - 7 * 86_400_000)
      const from = start.toISOString()
      const to = end.toISOString()
      series.push({
        period: to.slice(5, 10),
        out: sum(
          'SELECT SUM(total_minor) AS total FROM purchases WHERE ordered_at >= ? AND ordered_at < ?',
          from, to,
        ),
        in:
          sum('SELECT SUM(payout_minor) AS total FROM sales WHERE sold_at >= ? AND sold_at < ?', from, to)
          + sum(
            `SELECT SUM(amount_minor) AS total FROM refunds
             WHERE received_at IS NOT NULL AND received_at >= ? AND received_at < ?`,
            from, to,
          ),
      })
    }

    const owed = sum('SELECT SUM(amount_minor) AS total FROM refunds WHERE received_at IS NULL')
    const capitalMinor = sum(`SELECT SUM(cost_minor) AS total FROM items WHERE status IN (${HELD})`)

    return {
      bought: {
        orders: count("SELECT COUNT(*) AS n FROM purchases WHERE status != 'cancelled'"),
        units: count('SELECT COUNT(*) AS n FROM items'),
        spend: formatMoney(money(sum('SELECT SUM(total_minor) AS total FROM purchases'), 'EUR')),
        // Of the orders being watched, how many have actually left the retailer.
        shipped: count(
          `SELECT COUNT(DISTINCT p.id) AS n FROM purchases p
           JOIN shipments s ON s.purchase_id = p.id
           WHERE p.status != 'cancelled'`,
        ),
        delivered: count(
          `SELECT COUNT(DISTINCT p.id) AS n FROM purchases p
           JOIN shipments s ON s.purchase_id = p.id
           WHERE p.status != 'cancelled' AND s.status = 'delivered'`,
        ),
      },
      inFlight: {
        units: count("SELECT COUNT(*) AS n FROM items WHERE status = 'incoming'"),
        parcels: count("SELECT COUNT(*) AS n FROM shipments WHERE status != 'delivered'"),
        awaitingCode: count('SELECT COUNT(*) AS n FROM shipments WHERE tracking_number IS NULL'),
      },
      stock: {
        units: count(`SELECT COUNT(*) AS n FROM items WHERE status IN (${HELD})`),
        capital: formatMoney(money(capitalMinor, 'EUR')),
        capitalMinor,
      },
      cancelled: {
        units: count("SELECT COUNT(*) AS n FROM items WHERE status = 'cancelled'"),
        owed: formatMoney(money(owed, 'EUR')),
        owedMinor: owed,
      },
      topProducts: topProducts.map((product) => ({
        title: product.title,
        units: product.units,
        spend: formatMoney(money(product.spend, 'EUR')),
        spendMinor: product.spend,
        lastBoughtAt: product.last_bought,
        imageUrl: product.image_url,
      })),
      profit: {
        net: formatMoney(money(netProfit, 'EUR')),
        netMinor: netProfit,
        revenue: formatMoney(money(revenue, 'EUR')),
        fees: formatMoney(money(fees, 'EUR')),
        marginPercent: costedRevenue > 0 ? Math.round((netProfit / costedRevenue) * 1000) / 10 : 0,
        salesRecorded,
        uncosted,
        channels,
      },
      money: {
        out: formatMoney(money(sum('SELECT SUM(total_minor) AS total FROM purchases'), 'EUR')),
        in: formatMoney(money(
          revenue + sum('SELECT SUM(amount_minor) AS total FROM refunds WHERE received_at IS NOT NULL'),
          'EUR',
        )),
        salesRecorded,
      },
      funnel,
      months,
      aging,
      series,
      bestSellers: this.bestSellers(3, 30),
      allTimeBest: this.bestSellers(1)[0] ?? null,
      salesSeries: this.salesSeries(30),
      activity: this.recentActivity(8),
      // What is still coming, priced, and how long the oldest has been waiting.
      pending: (() => {
        const incoming = this.listInventory().filter((item) => item.status === 'incoming')
        const oldest = incoming
          .map((item) => item.daysHeld ?? 0)
          .reduce((worst, days) => Math.max(worst, days), 0)
        return {
          units: incoming.length,
          value: formatMoney(money(incoming.reduce((total, item) => total + item.costMinor, 0), 'EUR')),
          oldestDays: incoming.length === 0 ? null : oldest,
        }
      })(),
      vat: this.vatPosition(),
      reviewCount: count("SELECT COUNT(*) AS n FROM messages WHERE parse_status = 'unrecognized'"),
    }
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

  /**
   * The address DHL sends the confirmation to.
   *
   * Defaults to the first connected mailbox, which is where the parcel's own
   * mail already arrives, so the confirmation lands beside it.
   */
  redirectEmail(): string | null {
    const configured = this.getSetting(REDIRECT_EMAIL_SETTING)
    if (configured) return configured
    return this.listAccounts()[0]?.email ?? null
  }

  setRedirectEmail(email: string): string | null {
    const trimmed = email.trim()
    if (trimmed.length === 0) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(REDIRECT_EMAIL_SETTING)
      return this.redirectEmail()
    }
    this.setSetting(REDIRECT_EMAIL_SETTING, trimmed)
    return trimmed
  }

  /** Parcels this can be done to: DHL, barcode known, postcode known. */
  redirectableShipments(): ShipmentView[] {
    return this.listShipments().filter(
      (shipment) =>
        shipment.carrier === 'dhl'
        && shipment.trackingNumber !== null
        && shipment.postalCode !== null
        && shipment.status !== 'delivered',
    )
  }

  /**
   * Sends chosen parcels to a ServicePoint.
   *
   * One at a time, with a pause between: this is a person's page being driven,
   * and hammering it would be both rude and unreliable. Every parcel is
   * recorded with what happened to it, including the ones DHL refused, so the
   * screen can say which are actually going somewhere else.
   *
   * Nothing here decides on its own that a parcel should be redirected. The
   * caller passes exactly the parcels a person picked.
   */
  async redirectShipments(
    ids: string[],
    options: {
      page: Page
      dryRun?: boolean
      onProgress?: (done: number, total: number, current: RedirectProgress) => void
      sleep?: (ms: number) => Promise<void>
    },
  ): Promise<RedirectReport[]> {
    const wait = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const email = this.redirectEmail()
    const byId = new Map(this.listShipments().map((shipment) => [shipment.id, shipment]))
    const reports: RedirectReport[] = []

    for (const [index, id] of ids.entries()) {
      const shipment = byId.get(id)
      if (!shipment) continue

      options.onProgress?.(index, ids.length, {
        id, trackingNumber: shipment.trackingNumber, step: 'starting',
      })

      const outcome = await redirectParcel(
        options.page,
        { trackingNumber: shipment.trackingNumber, postalCode: shipment.postalCode },
        {
          email,
          dryRun: options.dryRun,
          sleep: options.sleep,
          onStep: (step) => options.onProgress?.(index, ids.length, {
            id, trackingNumber: shipment.trackingNumber, step,
          }),
        },
      )

      const report: RedirectReport = {
        id,
        trackingNumber: shipment.trackingNumber,
        title: shipment.title,
        ok: outcome.ok,
        dryRun: outcome.ok ? outcome.dryRun : Boolean(options.dryRun),
        servicePoint: outcome.ok ? outcome.servicePoint : null,
        reason: outcome.ok ? null : outcome.reason,
        message: outcome.ok
          ? describePoint(outcome.servicePoint, outcome.dryRun)
          : outcome.message,
      }
      reports.push(report)
      this.recordRedirect(report)

      options.onProgress?.(index + 1, ids.length, {
        id, trackingNumber: shipment.trackingNumber, step: report.ok ? 'done' : 'refused',
      })

      // The standalone tool waits between parcels for the same reason.
      if (index < ids.length - 1) await wait(2_500)
    }

    return reports
  }

  private recordRedirect(report: RedirectReport): void {
    this.db.prepare(
      `INSERT INTO redirects
         (shipment_id, tracking_number, outcome, message, service_point, dry_run, attempted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(shipment_id) DO UPDATE SET
         tracking_number = excluded.tracking_number,
         outcome = excluded.outcome,
         message = excluded.message,
         service_point = excluded.service_point,
         dry_run = excluded.dry_run,
         attempted_at = excluded.attempted_at`,
    ).run(
      report.id,
      report.trackingNumber ?? '',
      report.ok ? (report.dryRun ? 'test' : 'redirected') : (report.reason ?? 'failed'),
      report.message,
      report.servicePoint?.name ?? null,
      report.dryRun ? 1 : 0,
      new Date().toISOString(),
    )
  }

  /**
   * Records a sale made by hand, to a buyer who is not a marketplace.
   *
   * One call covers however many units went in the same deal: a private sale
   * is usually "these three, one price, one buyer", and making the user record
   * it three times would invite three different prices.
   *
   * The units are marked sold, their sale rows replace any earlier one for the
   * same unit, and the VAT split is worked out here rather than being typed —
   * because it follows from the price and whether it already had VAT in it.
   */
  sellItems(
    itemIds: string[],
    input: {
      amountMinor: number
      includesVat: boolean
      perUnit?: boolean
      buyer?: string | null
      note?: string | null
      soldAt?: string
    },
  ): { sold: number; grossMinor: number; profitMinor: number; vatMinor: number } {
    const rows = this.db.prepare(
      `SELECT id, title, cost_minor, cost_currency FROM items
       WHERE id IN (${itemIds.map(() => '?').join(',')})`,
    ).all(...itemIds) as {
      id: string; title: string; cost_minor: number; cost_currency: string
    }[]

    if (rows.length === 0) return { sold: 0, grossMinor: 0, profitMinor: 0, vatMinor: 0 }

    const breakdown = breakDownSale({
      lines: rows.map((row) => ({ itemId: row.id, costMinor: row.cost_minor })),
      amountMinor: input.amountMinor,
      includesVat: input.includesVat,
      perUnit: input.perUnit,
    })

    const soldAt = input.soldAt ?? new Date().toISOString()
    const now = new Date().toISOString()
    const buyer = input.buyer?.trim() || null

    const write = this.db.transaction(() => {
      for (const line of breakdown.lines) {
        this.db.prepare('DELETE FROM sales WHERE item_id = ?').run(line.itemId)
        this.db.prepare(
          `INSERT INTO sales
             (id, item_id, marketplace, external_order_id, buyer, note, title,
              price_included_vat, sold_at, currency, gross_minor, vat_minor,
              vat_rate_bp, payout_minor, created_at)
           VALUES (?, ?, 'offline', NULL, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, ?, ?)`,
        ).run(
          saleKey(line.itemId, soldAt),
          line.itemId,
          buyer,
          input.note?.trim() || null,
          rows.find((row) => row.id === line.itemId)?.title ?? null,
          input.includesVat ? 1 : 0,
          soldAt,
          line.grossMinor,
          line.vatMinor,
          breakdown.rateBasisPoints,
          line.grossMinor,
          now,
        )
        this.db.prepare("UPDATE items SET status = 'sold' WHERE id = ?").run(line.itemId)
      }
    })
    write()

    return {
      sold: breakdown.lines.length,
      grossMinor: breakdown.grossMinor,
      profitMinor: breakdown.profitMinor,
      vatMinor: breakdown.vatMinor,
    }
  }

  /** Undoes a sale recorded by hand, putting the unit back in stock. */
  unsellItems(itemIds: string[]): number {
    if (itemIds.length === 0) return 0
    const placeholders = itemIds.map(() => '?').join(',')
    const undo = this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM sales WHERE marketplace = 'offline' AND item_id IN (${placeholders})`,
      ).run(...itemIds)
      this.db.prepare(
        `UPDATE items SET status = 'in_stock' WHERE id IN (${placeholders}) AND status = 'sold'`,
      ).run(...itemIds)
    })
    undo()
    return itemIds.length
  }

  /** The VAT position across everything: paid on stock, collected on sales. */
  vatPosition(): {
    rateBasisPoints: number
    paidOnPurchases: string
    collectedOnSales: string
    balance: string
    balanceMinor: number
  } {
    const items = this.listInventory()
    const paid = items.reduce((sum, item) => sum + item.costVatMinor, 0)
    const collected = items.reduce((sum, item) => sum + (item.soldVatMinor ?? 0), 0)
    return {
      rateBasisPoints: NL_VAT_BASIS_POINTS,
      paidOnPurchases: formatMoney(money(paid, 'EUR')),
      collectedOnSales: formatMoney(money(collected, 'EUR')),
      balance: formatMoney(money(collected - paid, 'EUR')),
      balanceMinor: collected - paid,
    }
  }

  /**
   * Asks DHL where its parcels are.
   *
   * Mail is the first source and usually the fastest, but a mail can be
   * missed and a parcel that quietly arrived should not sit in the list saying
   * "out for delivery" for days. Only DHL offers a public answer, so only DHL
   * parcels are asked; PostNL is settled by its own delivery mail.
   *
   * A parcel only ever moves forward, and a barcode DHL does not recognise
   * changes nothing at all.
   */
  async pollCarrierStatus(
    options: {
      fetcher?: Fetcher
      limit?: number
      onProgress?: (done: number, total: number) => void
    } = {},
  ): Promise<{ asked: number; moved: number; delivered: number; failed: number }> {
    const parcels = this.db.prepare(
      `SELECT id, tracking_number, status, purchase_id FROM shipments
       WHERE carrier = 'dhl' AND tracking_number IS NOT NULL AND status != 'delivered'
       ORDER BY COALESCE(last_polled_at, '') ASC
       LIMIT ?`,
    ).all(options.limit ?? 25) as {
      id: string; tracking_number: string; status: string; purchase_id: string | null
    }[]

    let moved = 0
    let delivered = 0
    let failed = 0
    const now = new Date().toISOString()

    for (const [index, parcel] of parcels.entries()) {
      try {
        const summary = summarizeShipment(await fetchShipment(parcel.tracking_number, options.fetcher))
        const status = toShipmentStatus(summary.state)
        this.db.prepare('UPDATE shipments SET last_polled_at = ? WHERE id = ?').run(now, parcel.id)

        if (status && status !== parcel.status) {
          const next = furthestStatus(parcel.status, status)
          if (next !== parcel.status) {
            this.db.prepare(
              'UPDATE shipments SET status = ?, last_movement_at = ? WHERE id = ?',
            ).run(next, summary.lastEventAt ?? now, parcel.id)
            moved += 1
            if (next === 'delivered') {
              delivered += 1
              this.settleDelivered(parcel.purchase_id)
            }
          }
        }
      } catch {
        // A carrier that cannot be reached is a carrier to ask again later.
        failed += 1
      }
      options.onProgress?.(index + 1, parcels.length)
    }

    return { asked: parcels.length, moved, delivered, failed }
  }

  /** What a delivery means for the goods: they are in stock now. */
  private settleDelivered(purchaseId: string | null): void {
    if (!purchaseId) return
    this.db.prepare(
      "UPDATE items SET status = 'in_stock' WHERE purchase_id = ? AND status = 'incoming'",
    ).run(purchaseId)
    this.db.prepare(
      "UPDATE purchases SET status = 'delivered' WHERE id = ? AND status != 'cancelled'",
    ).run(purchaseId)
  }

  /**
   * Everything sold, newest first.
   *
   * A sale is a row of its own rather than a state of an item, because it has
   * facts an item does not: who bought it, when, for how much, and whether the
   * price they paid already had VAT in it. Editing any of those is editing the
   * sale, not the goods.
   */
  listSales(): SaleView[] {
    const rows = this.db.prepare(
      `SELECT sa.id, sa.item_id, sa.marketplace, sa.buyer, sa.note, sa.sold_at,
              sa.gross_minor, sa.vat_minor, sa.price_included_vat, sa.currency,
              COALESCE(sa.title, i.title) AS title,
              i.image_url AS image_url, i.cost_minor AS cost_minor,
              p.retailer AS retailer,
              COALESCE(sa.external_order_id, p.external_order_id) AS order_ref
       FROM sales sa
       LEFT JOIN items i ON i.id = sa.item_id
       LEFT JOIN purchases p ON p.id = i.purchase_id
       ORDER BY sa.sold_at DESC, sa.id`,
    ).all() as Record<string, unknown>[]

    return rows.map((row) => {
      const gross = (row.gross_minor as number) ?? 0
      // A marketplace sale of something never bought through this application
      // has no cost to measure against, and inventing zero would read as pure
      // profit.
      const cost = (row.cost_minor as number | null) ?? null
      const profit = cost === null ? null : gross - cost
      return {
        id: row.id as string,
        itemId: (row.item_id as string | null) ?? null,
        title: (row.title as string | null) ?? 'Unknown item',
        imageUrl: (row.image_url as string | null) ?? null,
        buyer: (row.buyer as string | null) ?? null,
        note: (row.note as string | null) ?? null,
        soldAt: row.sold_at as string,
        channel: row.marketplace as string,
        retailer: (row.retailer as string | null) ?? null,
        orderRef: (row.order_ref as string | null) ?? null,
        grossMinor: gross,
        gross: formatMoney(money(gross, 'EUR')),
        vatMinor: (row.vat_minor as number) ?? 0,
        vat: formatMoney(money((row.vat_minor as number) ?? 0, 'EUR')),
        includedVat: (row.price_included_vat as number) === 1,
        costMinor: cost,
        cost: cost === null ? null : formatMoney(money(cost, 'EUR')),
        profitMinor: profit,
        profit: profit === null ? null : formatMoney(money(profit, 'EUR')),
      }
    })
  }

  /**
   * Corrects a sale already recorded.
   *
   * A price agreed in a hurry is often written down wrong, and the VAT split
   * follows from the price rather than being typed, so it is worked out again
   * here rather than being left as it was.
   */
  updateSale(
    saleId: string,
    input: {
      amountMinor?: number
      includesVat?: boolean
      buyer?: string | null
      note?: string | null
      soldAt?: string
    },
  ): SaleView | null {
    const existing = this.db.prepare(
      `SELECT id, item_id, gross_minor, price_included_vat, sold_at, buyer, note
       FROM sales WHERE id = ?`,
    ).get(saleId) as {
      id: string; item_id: string | null; gross_minor: number
      price_included_vat: number; sold_at: string
      buyer: string | null; note: string | null
    } | undefined
    if (!existing) return null

    const includesVat = input.includesVat ?? existing.price_included_vat === 1
    const amountMinor = input.amountMinor ?? existing.gross_minor
    const cost = existing.item_id
      ? ((this.db.prepare('SELECT cost_minor FROM items WHERE id = ?').get(existing.item_id) as
        { cost_minor: number } | undefined)?.cost_minor ?? 0)
      : 0

    const breakdown = breakDownSale({
      lines: [{ itemId: existing.item_id ?? saleId, costMinor: cost }],
      amountMinor,
      includesVat,
    })
    const line = breakdown.lines[0]!

    this.db.prepare(
      `UPDATE sales
       SET gross_minor = ?, payout_minor = ?, vat_minor = ?, vat_rate_bp = ?,
           price_included_vat = ?, buyer = ?, note = ?, sold_at = ?
       WHERE id = ?`,
    ).run(
      line.grossMinor,
      line.grossMinor,
      line.vatMinor,
      breakdown.rateBasisPoints,
      includesVat ? 1 : 0,
      // Left out means left alone; given but blank means cleared.
      input.buyer === undefined ? existing.buyer : (input.buyer?.trim() || null),
      input.note === undefined ? existing.note : (input.note?.trim() || null),
      input.soldAt ?? existing.sold_at,
      saleId,
    )

    return this.listSales().find((sale) => sale.id === saleId) ?? null
  }

  /** Undoes one sale, putting its unit back in stock. */
  deleteSale(saleId: string): boolean {
    const sale = this.db
      .prepare('SELECT item_id FROM sales WHERE id = ?')
      .get(saleId) as { item_id: string | null } | undefined
    if (!sale) return false

    this.db.prepare('DELETE FROM sales WHERE id = ?').run(saleId)
    if (sale.item_id) {
      this.db.prepare("UPDATE items SET status = 'in_stock' WHERE id = ? AND status = 'sold'")
        .run(sale.item_id)
    }
    return true
  }

  /**
   * The shipping label a marketplace sent, as the file it was attached as.
   *
   * The PDF is not copied anywhere when the mail is read — the stored mail is
   * the copy — so it is fetched from there at the moment someone asks to print
   * it. Nothing is generated: this is the carrier's own label, unchanged.
   */
  async labelFor(shipmentId: string): Promise<{ name: string; content: Buffer } | null> {
    const parcel = this.db.prepare(
      'SELECT label_message_id, tracking_number FROM shipments WHERE id = ?',
    ).get(shipmentId) as { label_message_id: string | null; tracking_number: string | null } | undefined
    if (!parcel?.label_message_id) return null

    const message = this.db.prepare(
      'SELECT raw_path FROM messages WHERE message_id = ? OR id = ?',
    ).get(parcel.label_message_id, parcel.label_message_id) as { raw_path: string } | undefined
    if (!message?.raw_path || !existsSync(message.raw_path)) return null

    const parsed = await simpleParser(readFileSync(message.raw_path))
    const pdf = (parsed.attachments ?? []).find((file) => /pdf/i.test(file.contentType))
    if (!pdf) return null

    return {
      name: pdf.filename ?? `label-${parcel.tracking_number ?? shipmentId}.pdf`,
      content: Buffer.from(pdf.content as Buffer),
    }
  }

  /**
   * What has sold best, by units.
   *
   * Only sales say this: what you buy most and what you sell most are
   * different questions, and the second is the one that decides what to buy
   * next. Revenue is what came in; profit is stated only where the goods have
   * a known cost, because a marketplace sale of something bought elsewhere has
   * none.
   */
  bestSellers(limit = 3, sinceDays: number | null = null): BestSellerView[] {
    const since = sinceDays === null
      ? null
      : new Date(Date.now() - sinceDays * 86_400_000).toISOString()

    const rows = this.db.prepare(
      `SELECT COALESCE(sa.title, i.title) AS title,
              COUNT(*) AS units,
              SUM(sa.payout_minor) AS revenue,
              SUM(CASE WHEN i.id IS NULL THEN 0 ELSE sa.payout_minor - i.cost_minor END) AS profit,
              SUM(CASE WHEN i.id IS NULL THEN 0 ELSE 1 END) AS costed,
              MAX(sa.sold_at) AS last_sold,
              MAX(i.image_url) AS image_url
       FROM sales sa
       LEFT JOIN items i ON i.id = sa.item_id
       WHERE (? IS NULL OR sa.sold_at >= ?)
       GROUP BY lower(trim(COALESCE(sa.title, i.title)))
       ORDER BY units DESC, revenue DESC
       LIMIT ?`,
    ).all(since, since, limit) as {
      title: string | null; units: number; revenue: number; profit: number
      costed: number; last_sold: string; image_url: string | null
    }[]

    return rows.map((row) => ({
      title: row.title ?? 'Unknown item',
      units: row.units,
      revenue: formatMoney(money(row.revenue, 'EUR')),
      revenueMinor: row.revenue,
      // Null rather than zero where nothing sold has a cost behind it: zero
      // would read as breaking even.
      profit: row.costed === 0 ? null : formatMoney(money(row.profit, 'EUR')),
      profitMinor: row.costed === 0 ? null : row.profit,
      lastSoldAt: row.last_sold,
      imageUrl: row.image_url,
    }))
  }

  /**
   * Revenue and profit over time, at the resolution the span deserves.
   *
   * A week reads by day; a year by month. The buckets are filled from what is
   * recorded rather than interpolated, so a flat stretch means nothing
   * happened rather than nothing being known.
   */
  salesSeries(days: number | null = 30): SeriesPointView[] {
    const span = days ?? 3650
    const bucket = span <= 31 ? 'day' : span <= 120 ? 'week' : 'month'
    const format = bucket === 'day' ? '%Y-%m-%d' : bucket === 'week' ? '%Y-W%W' : '%Y-%m'
    const since = new Date(Date.now() - span * 86_400_000).toISOString()

    const rows = this.db.prepare(
      `SELECT strftime('${format}', sa.sold_at) AS period,
              SUM(sa.payout_minor) AS revenue,
              SUM(CASE WHEN i.id IS NULL THEN 0 ELSE sa.payout_minor - i.cost_minor END) AS profit
       FROM sales sa
       LEFT JOIN items i ON i.id = sa.item_id
       WHERE sa.sold_at >= ?
       GROUP BY period
       ORDER BY period`,
    ).all(since) as { period: string; revenue: number; profit: number }[]

    return rows.map((row) => ({
      period: row.period,
      revenueMinor: row.revenue,
      profitMinor: row.profit,
    }))
  }

  /** The latest thing that happened, whatever kind of thing it was. */
  recentActivity(limit = 8): ActivityRowView[] {
    const orders = this.listPurchases().slice(0, limit).map((purchase) => ({
      kind: 'order' as const,
      id: purchase.id,
      title: purchase.title ?? purchase.reference ?? 'Order',
      meta: [purchase.retailer, purchase.reference].filter(Boolean).join(' · '),
      amount: purchase.total,
      at: purchase.orderedAt,
      status: purchase.status,
      imageUrl: null as string | null,
    }))

    const sales = this.listSales().slice(0, limit).map((sale) => ({
      kind: 'sale' as const,
      id: sale.id,
      title: sale.title,
      meta: [sale.channel === 'offline' ? 'sold privately' : sale.channel, sale.buyer]
        .filter(Boolean).join(' · '),
      amount: sale.gross,
      at: sale.soldAt,
      status: 'sold',
      imageUrl: sale.imageUrl,
    }))

    const parcels = this.listShipments().slice(0, limit).map((parcel) => ({
      kind: 'parcel' as const,
      id: parcel.id,
      title: parcel.title ?? parcel.trackingNumber ?? 'Parcel',
      meta: [parcel.carrier.toUpperCase(), parcel.trackingNumber].filter(Boolean).join(' · '),
      amount: null as string | null,
      at: parcel.lastMovementAt ?? parcel.expectedDeliveryAt ?? parcel.id,
      status: parcel.status,
      imageUrl: parcel.imageUrl,
    }))

    return [...orders, ...sales, ...parcels]
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
      .slice(0, limit)
  }

  /**
   * How far back a first sync of a mailbox reaches.
   *
   * A week by default: a busy mailbox holds thousands of messages a month,
   * almost none of them relevant, and a first run that grinds through a year
   * of them reads as broken. Someone who has just connected a mailbox and
   * wants their whole history can say so.
   */
  syncLookbackDays(): number {
    const stored = Number(this.getSetting(SYNC_LOOKBACK_SETTING))
    return Number.isFinite(stored) && stored > 0 ? Math.floor(stored) : DEFAULT_LOOKBACK_DAYS
  }

  /**
   * Changes how far back mail is collected from.
   *
   * Reaching further back only means something if the mailboxes are asked
   * again, so widening the window forgets where each folder had got to: the
   * next sync starts from the new date instead of from the last message it
   * read. Nothing is duplicated by that — mail is recognised by its content —
   * and narrowing the window changes nothing already collected, because mail
   * already read is not thrown away for being old.
   */
  setSyncLookbackDays(days: number): number {
    const wanted = Math.max(1, Math.min(3650, Math.floor(days)))
    const previous = this.syncLookbackDays()
    this.setSetting(SYNC_LOOKBACK_SETTING, String(wanted))

    if (wanted > previous) this.db.prepare('DELETE FROM folder_cursors').run()
    return wanted
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
  imageUrl: string | null
  quantity: number
  status: string
  lastMovementAt: string | null
  expectedDeliveryAt: string | null
  /** `17:00–19:00` when the courier gave a window for today. */
  deliveryWindow: string | null
  postalCode: string | null
  city: string | null
  dhlRedirectable: boolean
  /** True when a marketplace attached a shipping label to its mail. */
  hasLabel: boolean
  /** The last attempt to send this parcel to a ServicePoint, if there was one. */
  redirect: {
    outcome: string
    message: string
    servicePoint: string | null
    attemptedAt: string | null
  } | null
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
  /** The mailbox this order's mail arrived in, and what that mail said. */
  mailbox: string | null
  mailSubject: string | null
  quantity: number
  unit: string
  shipping: string
  total: string
  totalMinor: number
  totalsConsistent: boolean
  status: string
  refundOutstanding: string | null
  /** Where the parcel is, when a shipment has been matched to this order. */
  carrier?: string | null
  trackingNumber?: string | null
  shipmentStatus?: string | null
}

export interface CancellationView {
  id: string
  retailer: string
  reference: string | null
  occurredAt: string
  title: string | null
  /** The mailbox the cancellation arrived in, and what that mail was called. */
  mailbox: string | null
  mailSubject: string | null
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
  /** The article photograph from the retailer's mail, if one was carried. */
  imageUrl: string | null
  /** VAT inside the purchase price, which the mail always states gross. */
  costVatMinor: number
  costNetMinor: number
  /** What it sold for, gross, once it has been sold. */
  soldMinor: number | null
  sold: string | null
  soldVatMinor: number | null
  soldAt: string | null
  soldVia: string | null
  buyer: string | null
  /** Net revenue less net cost. Null until it is sold. */
  profitMinor: number | null
  profit: string | null
  /** The parcel carrying this unit, once one is known. */
  carrier?: string | null
  trackingNumber?: string | null
  shipmentStatus?: string | null
  expectedDeliveryAt?: string | null
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

export interface BestSellerView {
  title: string
  units: number
  revenue: string
  revenueMinor: number
  /** Null when none of these sales has a cost behind it. */
  profit: string | null
  profitMinor: number | null
  lastSoldAt: string
  imageUrl: string | null
}

export interface SeriesPointView {
  period: string
  revenueMinor: number
  profitMinor: number
}

export interface ActivityRowView {
  kind: 'order' | 'sale' | 'parcel'
  id: string
  title: string
  meta: string
  amount: string | null
  at: string
  status: string
  imageUrl: string | null
}

export interface SaleView {
  id: string
  itemId: string | null
  title: string
  imageUrl: string | null
  buyer: string | null
  note: string | null
  soldAt: string
  /** `offline` for a private sale; a marketplace name once one is connected. */
  channel: string
  retailer: string | null
  orderRef: string | null
  grossMinor: number
  gross: string
  vatMinor: number
  vat: string
  /** True when the price already had VAT in it, as a private buyer pays. */
  includedVat: boolean
  /** Null when the goods were never bought through this application. */
  costMinor: number | null
  cost: string | null
  profitMinor: number | null
  profit: string | null
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

export interface DashboardView {
  bought: { orders: number; units: number; spend: string; shipped: number; delivered: number }
  bestSellers: BestSellerView[]
  allTimeBest: BestSellerView | null
  salesSeries: SeriesPointView[]
  activity: ActivityRowView[]
  /** Units bought and not yet arrived, what they cost, and how long the
   *  oldest has been outstanding. */
  pending: { units: number; value: string; oldestDays: number | null }
  vat: {
    rateBasisPoints: number
    paidOnPurchases: string
    collectedOnSales: string
    balance: string
    balanceMinor: number
  }
  inFlight: { units: number; parcels: number; awaitingCode: number }
  stock: { units: number; capital: string; capitalMinor: number }
  cancelled: { units: number; owed: string; owedMinor: number }
  /** The articles bought most often, most units first. */
  topProducts: {
    title: string
    units: number
    spend: string
    spendMinor: number
    lastBoughtAt: string | null
    imageUrl: string | null
  }[]
  profit: {
    net: string
    netMinor: number
    revenue: string
    fees: string
    marginPercent: number
    salesRecorded: number
    /** Sales whose goods were bought outside this application. */
    uncosted: number
    channels: { name: string; value: string; minor: number }[]
  }
  money: { out: string; in: string; salesRecorded: number }
  funnel: { label: string; hue: number; units: number; value: string }[]
  months: { label: string; capital: number }[]
  aging: { bucket: string; units: number; value: string; minor: number; stalled: boolean }[]
  series: { period: string; out: number; in: number }[]
  reviewCount: number
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

export interface RedirectProgress {
  id: string
  trackingNumber: string | null
  step: string
}

export interface RedirectReport {
  id: string
  trackingNumber: string | null
  title: string | null
  ok: boolean
  /** True when the run deliberately stopped before the last click. */
  dryRun: boolean
  servicePoint: ServicePoint | null
  reason: string | null
  message: string
}

/** How a successful redirect reads once it is done. */
function describePoint(point: ServicePoint | null, dryRun: boolean): string {
  const where = point?.name
    ? `${point.name}${point.distance ? ` (${point.distance})` : ''}`
    : 'the nearest ServicePoint'
  return dryRun
    ? `Test run only: everything up to the last step worked, and it would have gone to ${where}.`
    : `Going to ${where}.`
}

/** A sale's identity: the unit it covers and when it was sold, so recording
 *  the same deal twice replaces it rather than duplicating it. */
function saleKey(itemId: string, soldAt: string): string {
  return createHash('sha256').update(`${itemId}|${soldAt}`).digest('hex').slice(0, 32)
}

/**
 * What a notification is about.
 *
 * A parcel arriving is one piece of news however many mails report it, so the
 * parcel is the subject where there is one. Without a parcel the event itself
 * is the subject, which is the honest answer for an order or a refund.
 */
function subjectKey(input: NotificationInput, parcelId: string | null): string {
  const about = parcelId ?? input.trackingNumber ?? input.reference ?? input.occurredAt
  return `${input.event}:${input.status ?? ''}:${about}`
}
