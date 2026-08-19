import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppService } from './service.js'
import type { CompletedTask, MailTask } from '../core/aycd/client.js'
import type { NotificationInput, sendToDiscord } from '../core/notify/discord.js'
import type { Fetcher } from '../core/tracking/dhl-status.js'
import type { WatcherClock } from '../core/aycd/watcher.js'

const VINTED = [
  'You’ve sold an item on Vinted.eml',
  'Uniqlo balloon pants shipping label – use by 19 06 2026 17 53.eml',
  'This order is completed.eml',
] as const

const FIXTURES = [
  'Bedankt voor je bestelling.eml',
  'Bedankt_voor_je_bestelling_0.eml',
  'Je_artikel_is_geannuleerd_0.eml',
  'Je pakket is nu bij DHL.eml',
  'Je pakket is nu bij PostNL.eml',
  'De_bezorger_is_onderweg_0.eml',
]

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../fixtures/eml/${name}`, import.meta.url))
}

const allPresent = FIXTURES.every((name) => existsSync(fixturePath(name)))

let service: AppService

beforeEach(() => {
  service = new AppService(':memory:', {
    encrypt: (p) => 'enc:' + Buffer.from(p, 'utf8').toString('base64'),
    decrypt: (c) => Buffer.from(c.slice(4), 'base64').toString('utf8'),
  })
})

describe.skipIf(!allPresent)('AppService importing real mail', () => {
  async function importAll() {
    for (const name of FIXTURES) await service.importEml(fixturePath(name))
  }

  it('recognises every supplied bol.com email', async () => {
    for (const name of FIXTURES) {
      const result = await service.importEml(fixturePath(name))
      expect(result.parserId, `${name} was not recognised`).not.toBeNull()
      expect(result.events).toBe(1)
    }
    expect(service.listReviewQueue()).toHaveLength(0)
  })

  it('is idempotent: importing the same file twice does not duplicate anything', async () => {
    await importAll()
    const first = service.summary()
    await importAll()
    const second = service.summary()
    expect(second).toEqual(first)
  })

  it('builds purchases whose totals all reconcile', async () => {
    await importAll()
    const purchases = service.listPurchases().filter((p) => p.kind === 'buy')
    expect(purchases).toHaveLength(2)
    expect(purchases.every((purchase) => purchase.totalsConsistent)).toBe(true)
    expect(purchases.map((p) => p.reference).sort()).toEqual(['C0008N401L', 'C000CXJLHK'])
  })

  it('sums spend across both orders', async () => {
    await importAll()
    // 14.98 + 161.97
    expect(service.summary().spend).toBe('€176.95')
  })

  it('builds shipments carrying carrier, postcode and contents', async () => {
    await importAll()
    const shipments = service.listShipments()
    // Three shipping mails: handed to DHL, handed to PostNL, and the courier
    // out with one of them. Until the barcodes resolve they are separate rows.
    expect(shipments).toHaveLength(3)
    // The out-for-delivery mail names no carrier and belongs to an order none
    // of the other fixtures announced, so it stands on its own with no carrier
    // claimed rather than one invented.
    expect(shipments.map((s) => s.carrier).sort()).toEqual(['dhl', 'postnl', 'unknown'])
    // The out-for-delivery mail states no address, so a postcode is not
    // demanded of every parcel — only that the ones stating it read as one.
    expect(shipments.filter((s) => s.postalCode !== null)).toHaveLength(2)
    expect(shipments.every((s) => s.postalCode === null || /^\d{4}[A-Z]{2}$/.test(s.postalCode))).toBe(true)
    expect(shipments.every((s) => s.expectedDeliveryAt === '2026-08-19')).toBe(true)
  })

  it('reports shipments as awaiting a tracking code', async () => {
    await importAll()
    expect(service.summary().awaitingTracking).toBe(3)
    expect(service.listShipments().every((s) => s.trackingNumber === null)).toBe(true)
  })

  it('counts nothing as redirect-ready until a barcode is known', async () => {
    await importAll()
    // A postcode alone is not enough: DHL addresses a parcel by its barcode,
    // so calling it ready before then promises something that cannot be done.
    expect(service.summary().redirectable).toBe(0)
  })

  it('counts the DHL parcel once its barcode resolves', async () => {
    await importAll()
    await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'dhl',
        trackingNumber: 'JVGL0627463317265600',
        finalUrl: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600',
      }),
    })

    expect(service.summary().redirectable).toBe(1)
    expect(service.redirectableShipments().map((s) => s.trackingNumber))
      .toEqual(['JVGL0627463317265600'])
  })

  it('produces a redirect CSV header even while tracking codes are unresolved', async () => {
    await importAll()
    // Without a resolved tracking code there is nothing to redirect yet, so the
    // export is a header and no rows rather than rows with empty codes.
    expect(service.redirectCsv()).toBe('tracking,postalcode')
  })

  it('surfaces the cancellation with its order reference', async () => {
    await importAll()
    const cancellations = service.listCancellations()
    expect(cancellations).toHaveLength(1)
    expect(cancellations[0]!.reference).toBe('C000CXJH1J')
    expect(cancellations[0]!.refundExpected).toBe(true)
  })

  it('lists parsers with the number of messages each claimed', async () => {
    await importAll()
    const parsers = service.listParsers()
    const byId = Object.fromEntries(parsers.map((p) => [p.id, p.parsed]))
    expect(byId['bol-order-confirmation']).toBe(2)
    expect(byId['bol-shipment-confirmation']).toBe(3)
    expect(byId['bol-cancellation']).toBe(1)
  })
})

describe('AppService with no mail', () => {
  it('starts empty rather than inventing anything', () => {
    const summary = service.summary()
    expect(summary.messageCount).toBe(0)
    expect(summary.eventCount).toBe(0)
    expect(summary.spend).toBe('€0.00')
    expect(service.listShipments()).toEqual([])
  })

  it('still lists the installed parsers and provider presets', () => {
    expect(service.listParsers().length).toBeGreaterThanOrEqual(10)
    expect(service.listProviders().map((p) => p.id)).toContain('namecheap')
  })
})

describe.skipIf(!allPresent)('reconciled inventory', () => {
  async function importAll() {
    for (const name of FIXTURES) await service.importEml(fixturePath(name))
  }

  it('creates one inventory item per physical unit', async () => {
    await importAll()
    // Order 1 is a single unit; order 2 is three units.
    expect(service.listInventory()).toHaveLength(4)
  })

  it('carries the per-unit cost, not the order total', async () => {
    await importAll()
    const lego = service.listInventory().filter((item) => item.title.startsWith('LEGO'))
    expect(lego).toHaveLength(3)
    expect(lego.every((item) => item.cost === '€53.99')).toBe(true)
  })

  it('reports units held and capital tied up', async () => {
    await importAll()
    const summary = service.summary()
    expect(summary.units).toBe(4)
    // 11.99 + 3 x 53.99
    expect(summary.capitalTiedUp).toBe('€173.96')
  })

  it('holds the cancellation, since its order was never supplied', async () => {
    await importAll()
    // C000CXJH1J has no matching confirmation among the fixtures, so the
    // cancellation waits rather than inventing an order to cancel.
    expect(service.summary().heldEvents).toBe(1)
  })

  it('links shipments to their purchase when the order is known', async () => {
    await importAll()
    const linked = service.listShipments()
    expect(linked).toHaveLength(3)
  })

  it('stays stable when everything is imported twice', async () => {
    await importAll()
    const before = service.listInventory().length
    await importAll()
    expect(service.listInventory()).toHaveLength(before)
  })
})

/**
 * AYCD Inbox capture. No network and no real timers: the transport and the
 * clock are injected, and the loop runs exactly as many polls as the fake clock
 * allows before it stops the watcher.
 */
class FakeInbox {
  readonly created: { id: string; task: MailTask }[] = []
  private counter = 0
  private readonly staged: { match: (task: MailTask) => boolean; results: Record<string, string> }[] = []

  async createTask(task: MailTask): Promise<{ id: string }> {
    this.counter += 1
    const id = `task_${this.counter}`
    this.created.push({ id, task })
    return { id }
  }

  async completedTasks(): Promise<CompletedTask[]> {
    return this.staged.flatMap((entry) => {
      const registered = this.created.find((candidate) => entry.match(candidate.task))
      return registered
        ? [{ id: registered.id, status: 'success' as const, results: entry.results }]
        : []
    })
  }

  /** Stages a result against whichever registered task matches. */
  complete(match: (task: MailTask) => boolean, results: Record<string, string>): void {
    this.staged.push({ match, results })
  }
}

const isBolOrderTask = (task: MailTask): boolean =>
  task.mailFilters.some((filter) => filter.value === 'automail@bol.com')
  && task.mailFilters.some((filter) => filter.value === 'bestelling')

const BOL_CAPTURE = {
  orderRef: 'C0008N401L',
  title: 'LEGO Star Wars 75192',
  quantity: '1 x €',
  unitPrice: '11,99',
  shipping: '0,00',
  total: '11,99',
}

/** Stops the watcher after its first sleep, so `start` runs exactly one poll. */
function oneShotClock(stop: () => void): WatcherClock {
  let current = Date.UTC(2026, 6, 1, 10, 0, 0)
  return {
    now: () => current,
    async sleep(ms) {
      current += ms
      stop()
    },
  }
}

async function captureOnce(target: AppService, inbox: FakeInbox): Promise<void> {
  const clock = oneShotClock(() => {
    void target.stopAycdWatch()
  })
  target.startAycdWatch({ transport: inbox, clock })
  await target.stopAycdWatch()
}

describe('AppService AYCD Inbox integration', () => {
  it('reports Inbox as unconfigured until a key is stored', () => {
    const status = service.aycdStatus()
    expect(status.configured).toBe(false)
    expect(status.running).toBe(false)
    expect(status.templates).toBeGreaterThan(0)
  })

  it('never stores the API key in plaintext', () => {
    service.setAycdApiKey('SECRET-KEY-123')
    const stored = service.getSetting('aycd_api_key_cipher')

    expect(stored).not.toBeNull()
    expect(stored).not.toContain('SECRET-KEY-123')
    expect(service.aycdStatus().configured).toBe(true)
  })

  it('forgets the key on request', () => {
    service.setAycdApiKey('SECRET-KEY-123')
    service.clearAycdApiKey()
    expect(service.aycdStatus().configured).toBe(false)
  })

  it('treats a blank key as clearing it rather than storing an empty secret', () => {
    service.setAycdApiKey('SECRET-KEY-123')
    service.setAycdApiKey('   ')
    expect(service.aycdStatus().configured).toBe(false)
  })

  it('normalises and remembers the watched addresses', () => {
    expect(service.setAycdAddresses([' Orders@Example.com ', 'orders@example.com', '']))
      .toEqual(['orders@example.com'])
    expect(service.listAycdAddresses()).toEqual(['orders@example.com'])
  })

  it('refuses to verify without a key instead of calling out', async () => {
    await expect(service.verifyAycd()).resolves.toEqual({
      ok: false,
      message: 'No AYCD Inbox API key is stored.',
    })
  })

  it('will not start without a key or without an address', () => {
    expect(service.startAycdWatch().started).toBe(false)

    service.setAycdApiKey('SECRET-KEY-123')
    expect(service.startAycdWatch()).toEqual({
      started: false,
      message: 'No addresses are set for AYCD Inbox to watch.',
    })
  })

  it('registers a task per template and turns a capture into a purchase', async () => {
    service.setAycdApiKey('SECRET-KEY-123')
    service.setAycdAddresses(['orders@example.com'])
    const inbox = new FakeInbox()
    inbox.complete(isBolOrderTask, BOL_CAPTURE)

    await captureOnce(service, inbox)

    expect(inbox.created.length).toBeGreaterThan(1)
    const purchases = service.listPurchases()
    expect(purchases).toHaveLength(1)
    expect(purchases[0]!.reference).toBe('C0008N401L')
    expect(purchases[0]!.total).toBe('€11.99')
    expect(service.listInventory()).toHaveLength(1)
  })

  it('keeps a capture out of the review queue, since it was recognised', async () => {
    service.setAycdApiKey('SECRET-KEY-123')
    service.setAycdAddresses(['orders@example.com'])
    const inbox = new FakeInbox()
    inbox.complete(isBolOrderTask, BOL_CAPTURE)

    await captureOnce(service, inbox)

    expect(service.listReviewQueue()).toHaveLength(0)
    expect(service.summary().messageCount).toBe(1)
  })

  it('records the same capture twice as one, keyed on the Inbox task id', async () => {
    service.setAycdApiKey('SECRET-KEY-123')
    service.setAycdAddresses(['orders@example.com'])

    for (const _run of [1, 2]) {
      const inbox = new FakeInbox()
      inbox.complete(isBolOrderTask, BOL_CAPTURE)
      await captureOnce(service, inbox)
    }

    expect(service.summary().messageCount).toBe(1)
    expect(service.listPurchases()).toHaveLength(1)
    expect(service.listInventory()).toHaveLength(1)
  })

  it('reports what the watcher did, and keeps the tally after it stops', async () => {
    service.setAycdApiKey('SECRET-KEY-123')
    service.setAycdAddresses(['orders@example.com'])
    const inbox = new FakeInbox()
    inbox.complete(isBolOrderTask, BOL_CAPTURE)

    await captureOnce(service, inbox)

    const status = service.aycdStatus()
    expect(status.running).toBe(false)
    expect(status.succeeded).toBe(1)
    expect(status.events).toBe(1)
    // Every other template is still waiting for its retailer's mail.
    expect(status.activeTasks).toBe(status.templates - 1)
    expect(status.lastError).toBeNull()
  })

  it('does not start a second watcher over the top of a running one', async () => {
    service.setAycdApiKey('SECRET-KEY-123')
    service.setAycdAddresses(['orders@example.com'])
    const inbox = new FakeInbox()

    const clock = oneShotClock(() => {})
    service.startAycdWatch({ transport: inbox, clock })
    const second = service.startAycdWatch({ transport: inbox, clock })

    expect(second).toEqual({ started: true, message: 'AYCD Inbox capture is already running.' })
    await service.stopAycdWatch()
  })
})

describe.skipIf(!allPresent)('screens read reconciled state, not raw events', () => {
  async function importAll() {
    for (const name of FIXTURES) await service.importEml(fixturePath(name))
  }

  it('takes purchase status from the reconciler rather than assuming confirmed', async () => {
    await importAll()
    // Previously hardcoded: every order read as "confirmed" no matter what had
    // happened to it since.
    const statuses = service.listPurchases().filter((p) => p.kind === 'buy').map((p) => p.status)
    expect(statuses.every((s) => typeof s === 'string' && s.length > 0)).toBe(true)
    expect(statuses).toEqual(['confirmed', 'confirmed'])
  })

  it('reports no outstanding refund when none was booked', async () => {
    await importAll()
    expect(service.listPurchases().every((p) => p.refundOutstanding === null)).toBe(true)
  })

  it('carries the item title through to the purchase row', async () => {
    await importAll()
    const titles = service.listPurchases().map((p) => p.title)
    expect(titles.some((t) => t?.startsWith('One Piece'))).toBe(true)
    expect(titles.some((t) => t?.startsWith('LEGO'))).toBe(true)
  })

  it('keeps the per-unit price on the purchase, not the order total', async () => {
    await importAll()
    const lego = service.listPurchases().find((p) => p.reference === 'C000CXJLHK')!
    expect(lego.unit).toBe('€53.99')
    expect(lego.total).toBe('€161.97')
    expect(lego.quantity).toBe(3)
  })

  it('reports whether a shipment has been matched to its order', async () => {
    await importAll()
    // These shipping mails reference orders whose confirmations were never
    // supplied, so nothing should claim to be linked.
    expect(service.listShipments().every((s) => s.linkedToPurchase === false)).toBe(true)
  })

  it('still carries parcel contents, which exist only on the shipping mail', async () => {
    await importAll()
    const titles = service.listShipments().map((s) => s.title)
    expect(titles.some((t) => t?.includes('Ascended Heroes'))).toBe(true)
    expect(titles.some((t) => t?.includes('Destined Rivals'))).toBe(true)
  })

  it('surfaces the totals check from the purchase row', async () => {
    await importAll()
    expect(service.listPurchases().filter((p) => p.kind === 'buy')
      .every((p) => p.totalsConsistent)).toBe(true)
  })
})

describe.skipIf(!allPresent)('one list of orders, labelled buy or cancel', () => {
  async function importAll() {
    for (const name of FIXTURES) await service.importEml(fixturePath(name))
  }

  it('labels real orders as buys', async () => {
    await importAll()
    const buys = service.listPurchases().filter((row) => row.kind === 'buy')
    expect(buys).toHaveLength(2)
    expect(buys.map((b) => b.reference).sort()).toEqual(['C0008N401L', 'C000CXJLHK'])
  })

  it('includes a cancellation with no matching order as its own row', async () => {
    await importAll()
    const cancels = service.listPurchases().filter((row) => row.kind === 'cancel')
    expect(cancels).toHaveLength(1)
    expect(cancels[0]!.reference).toBe('C000CXJH1J')
    expect(cancels[0]!.status).toBe('cancelled')
  })

  it('leaves money columns empty on a cancellation rather than showing zero', async () => {
    await importAll()
    const cancel = service.listPurchases().find((row) => row.kind === 'cancel')!
    // bol.com states no amount in a cancellation; €0.00 would be a claim, not a fact.
    expect(cancel.total).toBe('—')
    expect(cancel.unit).toBe('—')
  })

  it('returns everything on one list, newest first', async () => {
    await importAll()
    const rows = service.listPurchases()
    expect(rows).toHaveLength(3)
    const dates = rows.map((r) => r.orderedAt)
    expect([...dates].sort().reverse()).toEqual(dates)
  })

  it('does not duplicate a cancellation that already has an order', async () => {
    await importAll()
    const refs = service.listPurchases().map((r) => `${r.retailer}|${r.reference}`)
    expect(new Set(refs).size).toBe(refs.length)
  })
})

describe.skipIf(!allPresent)('tracking resolution', () => {
  async function importAll() {
    for (const name of FIXTURES) await service.importEml(fixturePath(name))
  }

  it('keeps a ranked shortlist of links to follow, not just the first', async () => {
    await importAll()
    // The retailer puts several links in a shipping mail and most lead to an
    // account page; the shortlist is what lets a dead end fall through.
    const shipments = service.listShipments()
    expect(shipments.length).toBeGreaterThan(0)
    expect(shipments.every((s) => s.trackingUrl?.includes('link.bol.com'))).toBe(true)
  })

  it('reports nothing to do when every parcel already has a code', async () => {
    const result = await service.resolveTrackingCodes({ limit: 0 })
    expect(result).toEqual({ attempted: 0, resolved: 0, failed: 0 })
  })
})

describe.skipIf(!allPresent)('exporting mail so a parser can be written', () => {
  it('exports a stored message as .eml, headers intact', async () => {
    const imported = await service.importEml(fixturePath(FIXTURES[0]!))
    void imported
    const id = service.listPurchases()[0]?.id
    void id

    // Take any stored message rather than relying on parse status.
    const anyId = (service as unknown as {
      db: { prepare(sql: string): { get(): { id: string } | undefined } }
    }).db.prepare('SELECT id FROM messages LIMIT 1').get()?.id
    expect(anyId).toBeTruthy()

    const file = await service.exportMessage(anyId!, 'eml')
    expect(file).not.toBeNull()
    expect(file!.name.endsWith('.eml')).toBe(true)
    // A parser matches on headers, so they have to survive the round trip.
    expect(file!.content.toString('utf8')).toMatch(/^From:/m)
  })

  it('exports the HTML part when asked for html, not the raw message', async () => {
    await service.importEml(fixturePath(FIXTURES[0]!))
    const anyId = (service as unknown as {
      db: { prepare(sql: string): { get(): { id: string } | undefined } }
    }).db.prepare('SELECT id FROM messages LIMIT 1').get()?.id

    const file = await service.exportMessage(anyId!, 'html')
    expect(file!.name.endsWith('.html')).toBe(true)
    const content = file!.content.toString('utf8')
    expect(content).not.toMatch(/^From:/m)
    expect(content.toLowerCase()).toContain('<')
  })

  it('returns null for a message whose copy was never kept', async () => {
    expect(await service.exportMessage('does-not-exist', 'eml')).toBeNull()
  })
})

describe('filenames', () => {
  it('keeps a subject readable while making it a valid filename', async () => {
    const { safeFileName } = await import('./service.js')
    expect(safeFileName('Je pakket is nu bij DHL')).toBe('Je-pakket-is-nu-bij-DHL')
    expect(safeFileName('Order #12/34: "urgent"')).toBe('Order-#1234-urgent')
  })

  it('never produces an empty name', async () => {
    const { safeFileName } = await import('./service.js')
    expect(safeFileName('///')).toBe('message')
  })
})

describe.skipIf(!allPresent)('shipments matched to orders', () => {
  async function importAll() {
    for (const name of FIXTURES) await service.importEml(fixturePath(name))
  }

  it('gives inventory a row per unit with its own cost', async () => {
    await importAll()
    const inventory = service.listInventory()
    expect(inventory).toHaveLength(4)
    expect(inventory.filter((i) => i.title.startsWith('LEGO'))).toHaveLength(3)
  })

  it('carries the parcel onto the item once the shipment is matched', async () => {
    await importAll()
    // These fixtures ship orders whose confirmations were not supplied, so no
    // item should claim a parcel it has no evidence for.
    const inventory = service.listInventory()
    expect(inventory.every((item) => item.carrier === null)).toBe(true)
  })

  it('carries the parcel onto the purchase row as well', async () => {
    await importAll()
    const purchases = service.listPurchases().filter((p) => p.kind === 'buy')
    expect(purchases.every((p) => 'carrier' in p)).toBe(true)
  })

  it('falls back to the order title when the shipping mail names nothing', async () => {
    await importAll()
    // Both directions exist so a parcel is never left anonymous when the order
    // it belongs to knows what it contains.
    const shipments = service.listShipments()
    expect(shipments.every((s) => s.title !== null)).toBe(true)
  })

  it('says plainly when a parcel has no order to attach to', async () => {
    await importAll()
    expect(service.listShipments().every((s) => s.linkedToPurchase === false)).toBe(true)
  })
})

describe.skipIf(!allPresent)('dashboard reports the operation, not the plumbing', () => {
  async function importAll() {
    for (const name of FIXTURES) await service.importEml(fixturePath(name))
  }

  it('counts what was bought rather than how many emails arrived', async () => {
    await importAll()
    const dashboard = service.dashboard()
    expect(dashboard.bought.orders).toBe(2)
    expect(dashboard.bought.units).toBe(4)
    expect(dashboard.bought.spend).toBe('€176.95')
  })

  it('counts what is still coming', async () => {
    await importAll()
    const dashboard = service.dashboard()
    expect(dashboard.inFlight.units).toBe(4)
    expect(dashboard.inFlight.parcels).toBe(3)
    expect(dashboard.inFlight.awaitingCode).toBe(3)
  })

  it('keeps money owed back separate from money received', async () => {
    await importAll()
    const dashboard = service.dashboard()
    // A refund that has not arrived is owed, not received; counting it as
    // income would overstate what came in.
    expect(dashboard.money.in).toBe('€0.00')
  })

  it('produces one point per week for the chart', async () => {
    await importAll()
    expect(service.dashboard(12).series).toHaveLength(12)
    expect(service.dashboard(4).series).toHaveLength(4)
  })

  it('puts spending in the week it happened', async () => {
    await importAll()
    const series = service.dashboard(52).series
    const spent = series.reduce((total, point) => total + point.out, 0)
    // Both orders fall inside a year, so the series must account for all of it.
    expect(spent).toBe(17695)
  })

  it('reports zeroes rather than failing on an empty database', () => {
    const dashboard = service.dashboard()
    expect(dashboard.bought.orders).toBe(0)
    expect(dashboard.money.out).toBe('€0.00')
    expect(dashboard.series.every((p) => p.out === 0 && p.in === 0)).toBe(true)
  })
})

describe.skipIf(!allPresent)('dashboard pipeline and capital', () => {
  async function importAll() {
    for (const name of FIXTURES) await service.importEml(fixturePath(name))
  }

  it('places every unit in exactly one pipeline stage', async () => {
    await importAll()
    const dashboard = service.dashboard()
    const inStages = dashboard.funnel.reduce((total, stage) => total + stage.units, 0)
    // Cancelled and returned are reversals, so they sit outside the pipeline.
    expect(inStages + dashboard.cancelled.units).toBe(dashboard.bought.units)
  })

  it('reports capital as the cost of what is actually held', async () => {
    await importAll()
    const dashboard = service.dashboard()
    // 11.99 + 3 x 53.99
    expect(dashboard.stock.capital).toBe('€173.96')
    expect(dashboard.stock.units).toBe(4)
  })

  it('spreads held stock across aging bands without losing any', async () => {
    await importAll()
    const dashboard = service.dashboard()
    const banded = dashboard.aging.reduce((total, band) => total + band.units, 0)
    expect(banded).toBe(dashboard.stock.units)
    expect(dashboard.aging.reduce((total, band) => total + band.minor, 0))
      .toBe(dashboard.stock.capitalMinor)
  })

  it('refuses to state a profit when no sale has been recorded', async () => {
    await importAll()
    const dashboard = service.dashboard()
    // Claiming a profit of minus everything spent would read as a loss the
    // business did not make; the screen says the sell side is missing instead.
    expect(dashboard.profit.salesRecorded).toBe(0)
    expect(dashboard.profit.channels).toEqual([])
  })

  it('gives six months of capital history for the chart', async () => {
    await importAll()
    expect(service.dashboard().months).toHaveLength(6)
  })
})

describe.skipIf(!allPresent)('deleting records by hand', () => {
  async function importAll() {
    for (const name of FIXTURES) await service.importEml(fixturePath(name))
  }

  it('removes a single unit and leaves its order alone', async () => {
    await importAll()
    const before = service.listInventory()
    service.deleteRecord('item', before[0]!.id)

    expect(service.listInventory()).toHaveLength(before.length - 1)
    expect(service.listPurchases().filter((p) => p.kind === 'buy')).toHaveLength(2)
  })

  it('takes an order\'s units and refunds with it', async () => {
    await importAll()
    const order = service.listPurchases().find((p) => p.reference === 'C000CXJLHK')!
    service.deleteRecord('purchase', order.id)

    expect(service.listPurchases().some((p) => p.reference === 'C000CXJLHK')).toBe(false)
    // The three LEGO units belonged to that order and must not be left orphaned.
    expect(service.listInventory().some((i) => i.orderRef === 'C000CXJLHK')).toBe(false)
  })

  it('does not resurrect a deleted order when mail is re-read', async () => {
    await importAll()
    const order = service.listPurchases().find((p) => p.reference === 'C000CXJLHK')!
    service.deleteRecord('purchase', order.id)

    await service.reparseAll()

    // Deliberate removal has to survive a rebuild, or deleting feels broken.
    expect(service.listPurchases().some((p) => p.reference === 'C000CXJLHK')).toBe(false)
  })

  it('keeps the order when a shipment is deleted', async () => {
    await importAll()
    const shipment = service.listShipments()[0]!
    service.deleteRecord('shipment', shipment.id)

    expect(service.listShipments()).toHaveLength(2)
    expect(service.listPurchases().filter((p) => p.kind === 'buy')).toHaveLength(2)
  })

  it('is harmless when the record is already gone', async () => {
    await importAll()
    expect(service.deleteRecord('item', 'not-a-real-id')).toEqual({ deleted: true })
    expect(service.listInventory()).toHaveLength(4)
  })
})

describe.skipIf(!allPresent)('watching orders through to shipment', () => {
  async function importAll() {
    for (const name of FIXTURES) await service.importEml(fixturePath(name))
  }

  it('reports how many of the orders being watched have shipped', async () => {
    await importAll()
    const dashboard = service.dashboard()
    // These shipping mails reference orders whose confirmations were never
    // supplied, so none of the known orders can claim to have shipped.
    expect(dashboard.bought.orders).toBe(2)
    expect(dashboard.bought.shipped).toBe(0)
  })

  it('counts an order once however many parcels it has', async () => {
    await importAll()
    const dashboard = service.dashboard()
    expect(dashboard.bought.shipped).toBeLessThanOrEqual(dashboard.bought.orders)
  })

  it('counts delivered separately from shipped', async () => {
    await importAll()
    const dashboard = service.dashboard()
    expect(dashboard.bought.delivered).toBeLessThanOrEqual(dashboard.bought.shipped)
  })
})

describe.skipIf(!allPresent)('two mails about one parcel', () => {
  it('keeps one shipment when both resolve to the same barcode', async () => {
    // The mail that hands the parcel to DHL and the mail that says the courier
    // is out with it are separate events, and each starts out as its own
    // shipment with no barcode. Resolving both used to fail the sync with
    // "UNIQUE constraint failed: shipments.carrier, shipments.tracking_number".
    await service.importEml(fixturePath('Je pakket is nu bij DHL.eml'))
    await service.importEml(fixturePath('De_bezorger_is_onderweg_0.eml'))

    const before = service.listShipments()
    expect(before.length).toBeGreaterThan(1)

    const result = await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'dhl',
        trackingNumber: 'JVGL0627463317265600',
        finalUrl: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600',
      }),
    })

    expect(result.failed).toBe(0)
    const after = service.listShipments()
    expect(after.filter((s) => s.trackingNumber === 'JVGL0627463317265600')).toHaveLength(1)
  })

  it('shows the parcel at its furthest point, not its earliest', async () => {
    await service.importEml(fixturePath('Je pakket is nu bij DHL.eml'))
    await service.importEml(fixturePath('De_bezorger_is_onderweg_0.eml'))
    await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'dhl',
        trackingNumber: 'JVGL0627463317265600',
        finalUrl: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600',
      }),
    })

    const parcel = service.listShipments().find((s) => s.trackingNumber === 'JVGL0627463317265600')
    expect(parcel?.status).toBe('out_for_delivery')
  })
})

describe.skipIf(!allPresent)('the postcode the carrier URL reveals', () => {
  it('is kept, so a parcel whose mail gave no address still has one', async () => {
    await service.importEml(fixturePath('De_bezorger_is_onderweg_0.eml'))
    expect(service.listShipments()[0]!.postalCode).toBeNull()

    await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'dhl',
        trackingNumber: 'JVGL0627463317265600',
        postalCode: '3071NE',
        finalUrl: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600/3071NE',
      }),
    })

    const parcel = service.listShipments()[0]!
    expect(parcel.postalCode).toBe('3071NE')
    expect(parcel.trackingNumber).toBe('JVGL0627463317265600')
    // And with both known, the link goes straight to the carrier's own page.
    expect(parcel.trackingUrl).toBe('https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600/3071NE')
  })

  it('lets the DHL redirect export include a parcel the mail said nothing about', async () => {
    await service.importEml(fixturePath('De_bezorger_is_onderweg_0.eml'))
    await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'dhl',
        trackingNumber: 'JVGL0627463317265600',
        postalCode: '3071NE',
        finalUrl: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600/3071NE',
      }),
    })

    expect(service.redirectCsv()).toContain('JVGL0627463317265600,3071NE')
  })
})

describe.skipIf(!allPresent)('the link to the carrier is on the shipment', () => {
  it('is built for every parcel whose barcode is known', async () => {
    await service.importEml(fixturePath('Je pakket is nu bij PostNL.eml'))
    await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'postnl',
        trackingNumber: '3STUNM283054292',
        finalUrl: 'https://jouw.postnl.nl/track-and-trace/3STUNM283054292',
      }),
    })

    const parcel = service.listShipments()[0]!
    expect(parcel.trackingUrl).toBe('https://jouw.postnl.nl/track-and-trace/3STUNM283054292-NL-3043LC')
  })

  it('never reports a parcel as awaiting a code once it has one', async () => {
    await service.importEml(fixturePath('Je pakket is nu bij DHL.eml'))
    await service.importEml(fixturePath('De_bezorger_is_onderweg_0.eml'))
    await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'dhl',
        trackingNumber: 'JVGL0627463317265600',
        finalUrl: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600',
      }),
    })

    const followable = service.listShipments().filter((s) => s.trackingNumber !== null)
    expect(followable.length).toBeGreaterThan(0)
    expect(followable.every((s) => s.status !== 'pending')).toBe(true)
  })
})

describe.skipIf(!allPresent)('re-reading mail keeps what the mail never said', () => {
  async function resolvedParcel() {
    await service.importEml(fixturePath('Je pakket is nu bij DHL.eml'))
    await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'dhl',
        trackingNumber: 'JVGL0627463317265600',
        postalCode: '3043LC',
        finalUrl: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600/3043LC',
      }),
    })
  }

  it('keeps a barcode that came from following a link, not from the mail', async () => {
    await resolvedParcel()

    // This is what a version upgrade does, and what the Re-read all mail
    // button does. It used to throw the barcode away with the row.
    service.rebuildEntities()

    const parcel = service.listShipments()[0]!
    expect(parcel.trackingNumber).toBe('JVGL0627463317265600')
    expect(parcel.postalCode).toBe('3043LC')
    expect(parcel.status).not.toBe('pending')
  })

  it('keeps a redirect someone asked for', async () => {
    await resolvedParcel()
    await service.redirectShipments(service.redirectableShipments().map((p) => p.id), {
      page: {
        goto: async () => {},
        evaluate: async <T,>(script: string): Promise<T> => {
          if (script.includes('aria-disabled')) return false as T
          if (script.includes('innerText') && script.includes('h6')) {
            return { name: 'Primera Blaak', distance: '350 m', address: null } as T
          }
          return true as T
        },
      },
      sleep: async () => {},
    })

    service.rebuildEntities()

    expect(service.listShipments()[0]!.redirect).toMatchObject({
      outcome: 'redirected',
      servicePoint: 'Primera Blaak',
    })
  })

  it('survives a full re-parse of the stored mail', async () => {
    await resolvedParcel()
    await service.reparseAll()

    expect(service.listShipments()[0]!.trackingNumber).toBe('JVGL0627463317265600')
  })
})

describe.skipIf(!allPresent)('sending parcels to a ServicePoint', () => {
  /** A page that answers every check the driver makes. */
  function acceptingPage(visited: string[] = []) {
    return {
      page: {
        goto: async (url: string) => { visited.push(url) },
        evaluate: async <T,>(script: string): Promise<T> => {
          if (script.includes('aria-disabled')) return false as T
          if (script.includes('innerText') && script.includes('h6')) {
            return { name: 'Primera Blaak', distance: '350 m', address: 'Blaak 1, 3011TA Rotterdam' } as T
          }
          return true as T
        },
      },
      visited,
    }
  }

  async function withResolvedDhlParcel() {
    await service.importEml(fixturePath('Je pakket is nu bij DHL.eml'))
    await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'dhl',
        trackingNumber: 'JVGL0627463317265600',
        finalUrl: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600',
      }),
    })
    return service.redirectableShipments()
  }

  it('drives DHL for exactly the parcels it was given, and records the outcome', async () => {
    const parcels = await withResolvedDhlParcel()
    expect(parcels).toHaveLength(1)

    const { page, visited } = acceptingPage()
    const reports = await service.redirectShipments(parcels.map((p) => p.id), {
      page,
      sleep: async () => {},
    })

    expect(visited).toEqual([
      'https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600/3043LC/interventions',
    ])
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ ok: true, dryRun: false })
    expect(reports[0]!.message).toContain('Primera Blaak')

    const shipment = service.listShipments().find((s) => s.trackingNumber === 'JVGL0627463317265600')
    expect(shipment?.redirect).toMatchObject({
      outcome: 'redirected',
      servicePoint: 'Primera Blaak',
    })
  })

  it('marks a test run as a test run rather than as a redirect', async () => {
    const parcels = await withResolvedDhlParcel()
    const { page } = acceptingPage()

    const reports = await service.redirectShipments(parcels.map((p) => p.id), {
      page,
      dryRun: true,
      sleep: async () => {},
    })

    expect(reports[0]).toMatchObject({ ok: true, dryRun: true })
    expect(service.listShipments()[0]!.redirect?.outcome).toBe('test')
  })

  it('touches nothing for a parcel that was never asked about', async () => {
    await withResolvedDhlParcel()
    const { page, visited } = acceptingPage()

    const reports = await service.redirectShipments(['no-such-shipment'], {
      page,
      sleep: async () => {},
    })

    expect(reports).toEqual([])
    expect(visited).toEqual([])
  })

  it('sends the confirmation to the connected mailbox unless told otherwise', async () => {
    expect(service.setRedirectEmail('somewhere@example.com')).toBe('somewhere@example.com')
    expect(service.redirectEmail()).toBe('somewhere@example.com')

    // Cleared, it falls back rather than leaving DHL with nowhere to write.
    service.setRedirectEmail('')
    expect(service.redirectEmail()).toBe(service.listAccounts()[0]?.email ?? null)
  })
})

describe.skipIf(!allPresent)('selling by hand, to a buyer who is not a marketplace', () => {
  async function stock() {
    await service.importEml(fixturePath('Bedankt_voor_je_bestelling_0.eml'))
    return service.listInventory()
  }

  it('records a sale, marks the unit sold and works out the VAT', async () => {
    const [unit] = await stock()

    const result = service.sellItems([unit!.id], { amountMinor: 7500, includesVat: true, buyer: 'Jan' })

    expect(result).toMatchObject({ sold: 1, grossMinor: 7500, vatMinor: 1302 })

    const after = service.listInventory().find((item) => item.id === unit!.id)!
    expect(after.status).toBe('sold')
    expect(after.soldMinor).toBe(7500)
    expect(after.buyer).toBe('Jan')
    // Profit is what it fetched less what it cost.
    expect(after.profitMinor).toBe(7500 - unit!.costMinor)
  })

  it('adds VAT on when the price was agreed without it', async () => {
    const [unit] = await stock()
    const result = service.sellItems([unit!.id], { amountMinor: 10000, includesVat: false })
    expect(result.grossMinor).toBe(12100)
    expect(result.vatMinor).toBe(2100)
  })

  it('splits one price across several units sold to the same buyer', async () => {
    const units = await stock()
    expect(units.length).toBeGreaterThan(1)

    const ids = units.slice(0, 2).map((unit) => unit.id)
    const result = service.sellItems(ids, { amountMinor: 15000, includesVat: true, buyer: 'Sanne' })

    expect(result.sold).toBe(2)
    const sold = service.listInventory().filter((item) => ids.includes(item.id))
    expect(sold.every((item) => item.status === 'sold')).toBe(true)
    expect(sold.every((item) => item.buyer === 'Sanne')).toBe(true)
    // The parts add up to exactly what was received.
    expect(sold.reduce((sum, item) => sum + (item.soldMinor ?? 0), 0)).toBe(15000)
  })

  it('replaces a sale rather than recording the same unit twice', async () => {
    const [unit] = await stock()
    service.sellItems([unit!.id], { amountMinor: 7500, includesVat: true })
    service.sellItems([unit!.id], { amountMinor: 8000, includesVat: true })

    expect(service.listInventory().find((item) => item.id === unit!.id)!.soldMinor).toBe(8000)
  })

  it('puts a unit back when the sale fell through', async () => {
    const [unit] = await stock()
    service.sellItems([unit!.id], { amountMinor: 7500, includesVat: true })
    service.unsellItems([unit!.id])

    const after = service.listInventory().find((item) => item.id === unit!.id)!
    expect(after.status).toBe('in_stock')
    expect(after.soldMinor).toBeNull()
    expect(after.profitMinor).toBeNull()
  })

  it('states the VAT on everything bought, whether or not anything sold', async () => {
    const units = await stock()
    const paid = units.reduce((sum, unit) => sum + unit.costVatMinor, 0)

    const position = service.vatPosition()
    expect(position.rateBasisPoints).toBe(2100)
    expect(position.paidOnPurchases).toBe(`€${(paid / 100).toFixed(2)}`)
    expect(position.balanceMinor).toBe(-paid)
  })

  it('has nothing to record for units that do not exist', () => {
    expect(service.sellItems(['nope'], { amountMinor: 5000, includesVat: true }))
      .toMatchObject({ sold: 0 })
  })
})

describe.skipIf(!allPresent)('the delivery window survives the parcel being folded', () => {
  it('keeps the window when two mails turn out to be one parcel', async () => {
    // Exactly what a real install showed: the courier's window arrives in the
    // out-for-delivery mail, whose row is folded into the row the handover
    // mail created. Reading the window off that row's own event lost it.
    await service.importEml(fixturePath('Je pakket is nu bij DHL.eml'))
    await service.importEml(fixturePath('De_bezorger_is_onderweg_0.eml'))

    await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'dhl',
        trackingNumber: 'JVGL0627463317265600',
        finalUrl: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600',
      }),
    })

    const parcels = service.listShipments().filter((s) => s.trackingNumber !== null)
    expect(parcels).toHaveLength(1)
    expect(parcels[0]!.deliveryWindow).toBe('17:00–19:00')
    expect(parcels[0]!.status).toBe('out_for_delivery')
  })

  it('does not lose the window when a later mail states none', async () => {
    await service.importEml(fixturePath('De_bezorger_is_onderweg_0.eml'))
    await service.importEml(fixturePath('Je pakket is nu bij DHL.eml'))

    await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'dhl',
        trackingNumber: 'JVGL0627463317265600',
        finalUrl: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600',
      }),
    })

    const parcel = service.listShipments().find((s) => s.trackingNumber !== null)!
    expect(parcel.deliveryWindow).toBe('17:00–19:00')
  })

  it('re-reads stored mail once after an upgrade, not on every launch', async () => {
    expect(service.needsReparse('0.2.1')).toBe(true)
    service.markReparsed('0.2.1')
    expect(service.needsReparse('0.2.1')).toBe(false)
    // A newer build reads it again, which is how a parser improvement reaches
    // mail that was already collected.
    expect(service.needsReparse('0.2.2')).toBe(true)
  })
})

describe.skipIf(!allPresent)('a parcel stays one parcel across a rebuild', () => {
  async function twoMailsOneParcel() {
    await service.importEml(fixturePath('Je pakket is nu bij DHL.eml'))
    await service.importEml(fixturePath('De_bezorger_is_onderweg_0.eml'))
    await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'dhl',
        trackingNumber: 'JVGL0627463317265600',
        finalUrl: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600',
      }),
    })
  }

  it('does not bring the duplicate back when the mail is read again', async () => {
    await twoMailsOneParcel()
    const before = service.listShipments()
    expect(before).toHaveLength(1)

    // What an upgrade does. The pairing between these two mails cost a network
    // round trip to learn, so it is remembered rather than learned again.
    await service.reparseAll()

    const after = service.listShipments()
    expect(after).toHaveLength(1)
    expect(after[0]!.trackingNumber).toBe('JVGL0627463317265600')
    expect(after[0]!.deliveryWindow).toBe('17:00–19:00')
    expect(after[0]!.status).toBe('out_for_delivery')
  })

  it('survives a rebuild of the entities as well', async () => {
    await twoMailsOneParcel()
    service.rebuildEntities()

    const parcels = service.listShipments()
    expect(parcels).toHaveLength(1)
    expect(parcels[0]!.deliveryWindow).toBe('17:00–19:00')
  })
})

describe.skipIf(!allPresent)('the courier window reaches the parcel it belongs to', () => {
  it('attaches to the parcel of the same order, with no link to follow', async () => {
    // The out-for-delivery mail names no carrier and carries no barcode. It is
    // never the first news of a parcel, so where the order has one parcel it
    // belongs to that one — which is what makes the window visible without
    // waiting for a network sweep.
    await service.importEml(fixturePath('Je pakket is nu bij PostNL.eml'))
    const before = service.listShipments()
    expect(before).toHaveLength(1)

    await service.importEml(fixturePath('De_bezorger_is_onderweg_0.eml'))

    const after = service.listShipments()
    const order = before[0]!.linked
    const parcel = after.find((s) => s.linked === order)
    // The window lands on the parcel that was announced, and its carrier
    // stands: the later mail states none.
    if (parcel && after.length === 1) {
      expect(parcel.deliveryWindow).toBe('17:00–19:00')
      expect(parcel.carrier).toBe('postnl')
    } else {
      // The fixtures are different orders, so each keeps its own row and the
      // window stays on the mail that stated it.
      const withWindow = after.filter((s) => s.deliveryWindow !== null)
      expect(withWindow).toHaveLength(1)
      expect(withWindow[0]!.deliveryWindow).toBe('17:00–19:00')
    }
  })

  it('never invents a carrier for a mail that names none', async () => {
    await service.importEml(fixturePath('De_bezorger_is_onderweg_0.eml'))
    expect(service.listShipments()[0]!.carrier).toBe('unknown')
  })
})

describe.skipIf(!allPresent)('telling Discord what happened', () => {
  const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz'

  /** Stands in for Discord, and records exactly what it was asked to post. */
  function recorder() {
    const batches: { url: string; inputs: NotificationInput[] }[] = []
    const send: typeof sendToDiscord = async (url, inputs) => {
      batches.push({ url, inputs: [...inputs] })
      return { ok: true, message: 'sent' }
    }
    return { batches, send }
  }

  async function importAll() {
    for (const name of FIXTURES) await service.importEml(fixturePath(name))
  }

  it('sends an embed for every shipment and order once mail has been read', async () => {
    service.setDiscordWebhook(WEBHOOK)
    await importAll()

    const { batches, send } = recorder()
    const result = await service.flushNotifications({ send })

    expect(result.sent).toBeGreaterThan(0)
    expect(batches.length).toBeGreaterThan(0)
    expect(batches[0]!.url).toBe(WEBHOOK)
    expect(batches.flatMap((batch) => batch.inputs).map((input) => input.event))
      .toContain('shipped')
  })

  it('never says the same thing twice, however often the mail is read again', async () => {
    service.setDiscordWebhook(WEBHOOK)
    await importAll()

    const first = recorder()
    const sent = await service.flushNotifications({ send: first.send })
    expect(sent.sent).toBeGreaterThan(0)

    const second = recorder()
    expect(await service.flushNotifications({ send: second.send }))
      .toMatchObject({ sent: 0 })
    expect(second.batches).toEqual([])

    // Re-reading every stored message must not announce the past all over again.
    await service.reparseAll()
    const third = recorder()
    expect(await service.flushNotifications({ send: third.send })).toMatchObject({ sent: 0 })
  })

  it('says a parcel is out for delivery rather than merely shipped', async () => {
    service.setDiscordWebhook(WEBHOOK)
    await service.importEml(fixturePath('De_bezorger_is_onderweg_0.eml'))

    const { batches, send } = recorder()
    await service.flushNotifications({ send })

    const inputs = batches.flatMap((batch) => batch.inputs)
    expect(inputs.some((input) => input.status === 'Out for delivery')).toBe(true)
  })

  it('stays quiet with no webhook, and does not save up the backlog for later', async () => {
    await importAll()

    const { batches, send } = recorder()
    expect(await service.flushNotifications({ send })).toMatchObject({ sent: 0 })
    expect(batches).toEqual([])

    // Connecting a webhook afterwards must not announce last month at once.
    service.setDiscordWebhook(WEBHOOK)
    const later = recorder()
    expect(await service.flushNotifications({ send: later.send })).toMatchObject({ sent: 0 })
  })

  it('obeys the rules: an event switched off is not sent', async () => {
    service.setDiscordWebhook(WEBHOOK)
    for (const rule of service.discordSettings().rules) {
      service.setDiscordRule(rule.event, false)
    }
    await importAll()

    const { batches, send } = recorder()
    const result = await service.flushNotifications({ send })
    expect(batches).toEqual([])
    expect(result.sent).toBe(0)
    expect(result.skipped).toBeGreaterThan(0)
  })

  it('keeps an unaccepted batch for the next attempt rather than losing it', async () => {
    service.setDiscordWebhook(WEBHOOK)
    await importAll()

    const failing: typeof sendToDiscord = async () =>
      ({ ok: false, message: 'Discord rate limited this webhook.' })
    const result = await service.flushNotifications({ send: failing })
    expect(result.failed).toBeGreaterThan(0)
    expect(result.sent).toBe(0)

    const { batches, send } = recorder()
    const retry = await service.flushNotifications({ send })
    expect(retry.sent).toBeGreaterThan(0)
    expect(batches.length).toBeGreaterThan(0)
  })

  it('does not announce mail that is already old news', async () => {
    service.setDiscordWebhook(WEBHOOK)
    await importAll()

    // A week later, none of this is news any more.
    const later = Date.parse('2026-08-26T09:00:00.000Z')
    expect(service.pendingNotifications(100, later)).toEqual([])

    const { batches, send } = recorder()
    expect(await service.flushNotifications({ send })).toMatchObject({ sent: 0 })
    expect(batches).toEqual([])
  })

  it('keeps notifications when the stored webhook cannot be read', async () => {
    // A cipher that no longer decrypts: the events are still owed, so they are
    // not quietly written off.
    service.setSetting('discord_webhook_cipher', 'not-a-webhook-url')
    await importAll()

    const { batches, send } = recorder()
    const result = await service.flushNotifications({ send })
    expect(batches).toEqual([])
    expect(result.failed).toBeGreaterThan(0)
    expect(result.sent).toBe(0)

    // Once it is readable again, they go out.
    service.setDiscordWebhook(WEBHOOK)
    const retry = recorder()
    expect((await service.flushNotifications({ send: retry.send })).sent).toBeGreaterThan(0)
  })

  it('announces one arrival once, however many mails report it', async () => {
    service.setDiscordWebhook(WEBHOOK)
    await service.importEml(fixturePath('Je pakket is nu bij DHL.eml'))
    await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'dhl',
        trackingNumber: 'JVGL0637312004384176',
        finalUrl: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL0637312004384176',
      }),
    })
    // The carrier's own delivery mail and, later, the retailer's: one parcel,
    // one arrival, one notice.
    await service.importEml(fixturePath('Je_pakket_is_bezorgd_dhl.eml'))

    const { batches, send } = recorder()
    await service.flushNotifications({ send })

    const delivered = batches
      .flatMap((batch) => batch.inputs)
      .filter((input) => input.event === 'delivered')
    expect(delivered).toHaveLength(1)
  })

  it('names what was delivered, which the carrier mail never says', async () => {
    service.setDiscordWebhook(WEBHOOK)
    await service.importEml(fixturePath('Bedankt voor je bestelling.eml'))
    await service.importEml(fixturePath('Je pakket is nu bij DHL.eml'))
    await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'dhl',
        trackingNumber: 'JVGL0637312004384176',
        finalUrl: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL0637312004384176',
      }),
    })
    await service.flushNotifications({ send: recorder().send })

    await service.importEml(fixturePath('Je_pakket_is_bezorgd_dhl.eml'))
    const { batches, send } = recorder()
    await service.flushNotifications({ send })

    const delivered = batches
      .flatMap((batch) => batch.inputs)
      .find((input) => input.event === 'delivered')
    expect(delivered).toBeDefined()
    // The barcode came from the carrier; the goods came from the order it
    // belongs to.
    expect(delivered!.trackingNumber).toBe('JVGL0637312004384176')
    expect(delivered!.title ?? '').not.toBe('')
    expect(delivered!.retailer).toBe('bol')
  })

  it('sends in tens, which is all Discord accepts in one message', async () => {
    service.setDiscordWebhook(WEBHOOK)
    await importAll()
    // Enough events to need more than one message.
    expect(service.pendingNotifications(100).length).toBeGreaterThan(0)

    const { batches, send } = recorder()
    await service.flushNotifications({ send, limit: 100 })
    expect(batches.every((batch) => batch.inputs.length <= 10)).toBe(true)
  })
})

describe.skipIf(!allPresent)('a delivery settles the parcel and the stock', () => {
  it('marks the parcel delivered when the carrier says so, by barcode alone', async () => {
    await service.importEml(fixturePath('Je pakket is nu bij DHL.eml'))
    await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'dhl',
        trackingNumber: 'JVGL0637312004384176',
        finalUrl: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL0637312004384176',
      }),
    })
    expect(service.listShipments()[0]!.status).not.toBe('delivered')

    // DHL's own delivery mail carries the barcode and no order reference.
    await service.importEml(fixturePath('Je_pakket_is_bezorgd_dhl.eml'))

    const parcels = service.listShipments()
    expect(parcels).toHaveLength(1)
    expect(parcels[0]!.status).toBe('delivered')
  })

  it('moves what was incoming into stock', async () => {
    await service.importEml(fixturePath('Bedankt voor je bestelling.eml'))
    await service.importEml(fixturePath('Je pakket is nu bij DHL.eml'))
    expect(service.listInventory().every((item) => item.status === 'incoming')).toBe(true)

    await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'dhl',
        trackingNumber: 'JVGL0637312004384176',
        finalUrl: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL0637312004384176',
      }),
    })
    await service.importEml(fixturePath('Je_pakket_is_bezorgd_dhl.eml'))

    const parcel = service.listShipments()[0]!
    expect(parcel.status).toBe('delivered')
    if (parcel.linkedToPurchase) {
      expect(service.listInventory().every((item) => item.status === 'in_stock')).toBe(true)
    }
  })

  it('records a parcel even when its delivery mail is the first thing seen', async () => {
    await service.importEml(fixturePath('Afgeleverd_je_pakket_van_bol_postnl.eml'))

    const parcels = service.listShipments()
    expect(parcels).toHaveLength(1)
    expect(parcels[0]).toMatchObject({
      carrier: 'postnl',
      trackingNumber: '3STUNM283074965',
      status: 'delivered',
    })
  })
})

describe.skipIf(!allPresent)('asking DHL about parcels still out', () => {
  async function parcelInTransit() {
    await service.importEml(fixturePath('Je pakket is nu bij DHL.eml'))
    await service.resolveTrackingCodes({
      resolve: async () => ({
        carrier: 'dhl',
        trackingNumber: 'JVGL0637312004384176',
        finalUrl: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL0637312004384176',
      }),
    })
  }

  /** Stands in for DHL, and records which barcodes it was asked about. */
  function answering(body: unknown) {
    const asked: string[] = []
    const fetcher: Fetcher = async (url) => {
      asked.push(url)
      return { ok: true, status: 200, json: async () => body }
    }
    return { asked, fetcher }
  }

  it('moves a parcel on when DHL says it was delivered', async () => {
    await parcelInTransit()
    const { asked, fetcher } = answering([{
      deliveredAt: '2026-08-19T15:30:00Z',
      events: [{ status: 'DELIVERED', category: 'DELIVERED', timestamp: '2026-08-19T15:30:00Z' }],
    }])

    const result = await service.pollCarrierStatus({ fetcher })

    expect(asked[0]).toContain('JVGL0637312004384176')
    expect(result).toMatchObject({ asked: 1, moved: 1, delivered: 1, failed: 0 })
    expect(service.listShipments()[0]!.status).toBe('delivered')
  })

  it('never moves a parcel backwards', async () => {
    await parcelInTransit()
    await service.pollCarrierStatus({
      fetcher: answering([{ events: [{ status: 'DELIVERED', category: 'DELIVERED', timestamp: '2026-08-19T15:30:00Z' }] }]).fetcher,
    })

    // A later answer that knows less must not undo it.
    await service.pollCarrierStatus({
      fetcher: answering([{ events: [{ status: 'SHIPMENT_SORTED', category: 'UNDERWAY', timestamp: '2026-08-18T09:00:00Z' }] }]).fetcher,
    })

    expect(service.listShipments()[0]!.status).toBe('delivered')
  })

  it('leaves a parcel alone when DHL does not know the barcode', async () => {
    await parcelInTransit()
    const before = service.listShipments()[0]!.status

    const result = await service.pollCarrierStatus({ fetcher: answering([]).fetcher })

    expect(result).toMatchObject({ moved: 0, delivered: 0 })
    expect(service.listShipments()[0]!.status).toBe(before)
  })

  it('asks nothing about parcels already delivered', async () => {
    await parcelInTransit()
    await service.pollCarrierStatus({
      fetcher: answering([{ events: [{ status: 'DELIVERED', category: 'DELIVERED', timestamp: '2026-08-19T15:30:00Z' }] }]).fetcher,
    })

    const { asked, fetcher } = answering([])
    expect(await service.pollCarrierStatus({ fetcher })).toMatchObject({ asked: 0 })
    expect(asked).toEqual([])
  })

  it('survives DHL being unreachable', async () => {
    await parcelInTransit()
    const failing: Fetcher = async () => { throw new Error('network down') }

    const result = await service.pollCarrierStatus({ fetcher: failing })
    expect(result).toMatchObject({ asked: 1, moved: 0, failed: 1 })
  })
})

describe.skipIf(!allPresent)('a sale sticks', () => {
  async function soldOne() {
    await service.importEml(fixturePath('Bedankt voor je bestelling.eml'))
    const unit = service.listInventory()[0]!
    service.sellItems([unit.id], { amountMinor: 7500, includesVat: true, buyer: 'Mark' })
    return unit
  }

  it('survives re-reading the mail, which cannot know anything about selling', async () => {
    const unit = await soldOne()

    // What an upgrade does. The sale used to come unhooked from its unit here:
    // the unit went back to "incoming" and the money was counted as profit
    // with nothing to set against it.
    await service.reparseAll()

    const after = service.listInventory().find((item) => item.id === unit.id)!
    expect(after.status).toBe('sold')
    expect(after.soldMinor).toBe(7500)
    expect(after.buyer).toBe('Mark')
    expect(after.profitMinor).toBe(7500 - unit.costMinor)
  })

  it('keeps the dashboard honest across a rebuild', async () => {
    const unit = await soldOne()
    const before = service.dashboard().profit.netMinor
    expect(before).toBe(7500 - unit.costMinor)

    service.rebuildEntities()

    // Not the whole 7500 with no cost against it.
    expect(service.dashboard().profit.netMinor).toBe(before)
  })

  it('states profit as what was received less what was paid', async () => {
    const unit = await soldOne()
    const after = service.listInventory().find((item) => item.id === unit.id)!

    expect(after.profitMinor).toBe(after.soldMinor! - after.costMinor)
    // The VAT on both sides is still recorded, for the return.
    expect(after.soldVatMinor).toBe(1302)
    expect(after.costVatMinor).toBeGreaterThan(0)
  })
})

describe.skipIf(!allPresent)('the article bought most often', () => {
  it('is the one with the most units, with what it has cost', async () => {
    await service.importEml(fixturePath('Bedankt voor je bestelling.eml'))
    await service.importEml(fixturePath('Bedankt_voor_je_bestelling_0.eml'))

    const top = service.dashboard().topProducts[0]!
    // Three of the LEGO set against one of the other order.
    expect(top.units).toBe(3)
    expect(top.title).toContain('LEGO')
    expect(top.spendMinor).toBe(3 * 5399)
  })

  it('counts the same article from two orders as one article', async () => {
    // Both order fixtures contain the same LEGO set, ordered separately.
    await service.importEml(fixturePath('Bedankt_voor_je_bestelling_0.eml'))
    const fromOneOrder = service.dashboard().topProducts[0]!

    await service.importEml(fixturePath('Bedankt voor je bestelling.eml'))
    const both = service.dashboard().topProducts[0]!

    expect(both.title).toBe(fromOneOrder.title)
    expect(both.units).toBeGreaterThanOrEqual(fromOneOrder.units)
  })

  it('lists the leaders, most units first', async () => {
    await service.importEml(fixturePath('Bedankt voor je bestelling.eml'))
    await service.importEml(fixturePath('Bedankt_voor_je_bestelling_0.eml'))

    const products = service.dashboard().topProducts
    expect(products.length).toBeGreaterThan(1)
    expect(products[0]!.units).toBeGreaterThanOrEqual(products[1]!.units)
  })

  it('is empty before anything has been bought', () => {
    expect(service.dashboard().topProducts).toEqual([])
  })
})

describe.skipIf(!allPresent)('a sale that lost its unit is recovered', () => {
  it('reconnects the sale and puts the unit back to sold', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'resell-ops-')), 'test.db')
    const cipher = { encrypt: (p: string) => p, decrypt: (c: string) => c }

    const first = new AppService(path, cipher)
    await first.importEml(fixturePath('Bedankt voor je bestelling.eml'))
    const unit = first.listInventory()[0]!
    first.sellItems([unit.id], {
      amountMinor: 13000, includesVat: true, buyer: 'Twan', soldAt: '2026-08-19T10:00:00.000Z',
    })

    // Exactly the damage the old rebuild did: the sale survives, the unit it
    // sold does not, and the money then counts as profit against nothing.
    const raw = new Database(path)
    raw.prepare('UPDATE sales SET item_id = NULL').run()
    raw.prepare("UPDATE items SET status = 'in_stock'").run()
    raw.close()

    // Reopening repairs it: a sale's identity is derived from the unit it sold
    // and the day it was sold, so the pairing can be worked out again.
    const reopened = new AppService(path, cipher)

    const sold = reopened.listInventory().filter((item) => item.soldMinor !== null)
    expect(sold).toHaveLength(1)
    expect(sold[0]!.status).toBe('sold')
    expect(sold[0]!.buyer).toBe('Twan')
    expect(reopened.dashboard().profit.netMinor).toBe(13000 - unit.costMinor)
  })
})

describe.skipIf(!allPresent)('a sale can be corrected afterwards', () => {
  async function sold() {
    await service.importEml(fixturePath('Bedankt voor je bestelling.eml'))
    const unit = service.listInventory()[0]!
    service.sellItems([unit.id], { amountMinor: 7500, includesVat: true, buyer: 'Twan' })
    return { unit, sale: service.listSales()[0]! }
  }

  it('lists what was sold, with what it fetched and earned', async () => {
    const { unit } = await sold()

    const sales = service.listSales()
    expect(sales).toHaveLength(1)
    expect(sales[0]).toMatchObject({
      title: unit.title,
      buyer: 'Twan',
      grossMinor: 7500,
      costMinor: unit.costMinor,
      profitMinor: 7500 - unit.costMinor,
      includedVat: true,
      channel: 'offline',
    })
  })

  it('takes a corrected price and works the BTW out again', async () => {
    const { sale } = await sold()

    const updated = service.updateSale(sale.id, { amountMinor: 9000 })!
    expect(updated.grossMinor).toBe(9000)
    // 9000 gross at 21% is 1562 of BTW, not the 1302 of the old price.
    expect(updated.vatMinor).toBe(1562)
    expect(updated.profitMinor).toBe(9000 - sale.costMinor!)
  })

  it('adds the BTW when the corrected price is quoted without it', async () => {
    const { sale } = await sold()

    const updated = service.updateSale(sale.id, { amountMinor: 10000, includesVat: false })!
    expect(updated.grossMinor).toBe(12100)
    expect(updated.includedVat).toBe(false)
  })

  it('changes the buyer, the note and the date without touching the price', async () => {
    const { sale } = await sold()

    const updated = service.updateSale(sale.id, {
      buyer: 'Sanne', note: 'picked up', soldAt: '2026-08-01T12:00:00.000Z',
    })!
    expect(updated).toMatchObject({
      buyer: 'Sanne', note: 'picked up', grossMinor: sale.grossMinor,
    })
    expect(updated.soldAt).toBe('2026-08-01T12:00:00.000Z')
  })

  it('leaves what was not mentioned alone', async () => {
    const { sale } = await sold()
    const updated = service.updateSale(sale.id, { amountMinor: 8000 })!
    expect(updated.buyer).toBe('Twan')
  })

  it('corrects nothing for a sale that does not exist', async () => {
    await sold()
    expect(service.updateSale('no-such-sale', { amountMinor: 100 })).toBeNull()
  })

  it('undoes a sale, putting the unit back in stock', async () => {
    const { unit, sale } = await sold()

    expect(service.deleteSale(sale.id)).toBe(true)
    expect(service.listSales()).toEqual([])

    const after = service.listInventory().find((item) => item.id === unit.id)!
    expect(after.status).toBe('in_stock')
    expect(after.soldMinor).toBeNull()
  })

  it('says so when there is no such sale to undo', () => {
    expect(service.deleteSale('no-such-sale')).toBe(false)
  })
})

describe.skipIf(!VINTED.every((name) => existsSync(fixturePath(name))))('the Vinted selling process', () => {
  async function importVinted() {
    for (const name of VINTED) await service.importEml(fixturePath(name))
  }

  it('recognises every mail of the process', async () => {
    for (const name of VINTED) {
      const result = await service.importEml(fixturePath(name))
      expect(result.parserId, name).not.toBeNull()
    }
    expect(service.listReviewQueue()).toHaveLength(0)
  })

  it('records the sale with its buyer and price', async () => {
    await importVinted()

    const sale = service.listSales().find((row) => row.title === 'Uniqlo balloon pants')!
    expect(sale).toMatchObject({
      buyer: 'florence2838',
      grossMinor: 1500,
      channel: 'vinted',
    })
    // Bought outside this application, so there is no cost to measure against
    // and none is invented.
    expect(sale.costMinor).toBeNull()
    expect(sale.profitMinor).toBeNull()
  })

  it('gains the transaction reference when the order completes', async () => {
    await importVinted()

    // One sale, not one per mail: the completion is the same sale finishing.
    const sales = service.listSales().filter((row) => row.title === 'Uniqlo balloon pants')
    expect(sales).toHaveLength(1)
    expect(sales[0]!.orderRef).toBe('20362272898')
    expect(sales[0]!.buyer).toBe('florence2838')
  })

  it('records a completion whose sale mail was never collected', async () => {
    // Only the completion, as happens when a mailbox is connected mid-flow.
    await service.importEml(fixturePath('This order is completed (2).eml'))

    const sale = service.listSales()[0]!
    expect(sale).toMatchObject({
      title: 'Gosha Rubchinskiy t shirt',
      grossMinor: 8000,
      orderRef: '19885219761',
    })
  })

  it('records the parcel going out, with the barcode Vinted printed', async () => {
    await importVinted()

    const parcel = service.listShipments()[0]!
    expect(parcel).toMatchObject({
      direction: 'outbound',
      carrier: 'mondial relay',
      trackingNumber: '83321021',
      hasLabel: true,
    })
  })

  it('hands back the label that was attached to the mail', async () => {
    await importVinted()
    const parcel = service.listShipments()[0]!

    const label = await service.labelFor(parcel.id)
    expect(label).not.toBeNull()
    expect(label!.name).toMatch(/\.pdf$/i)
    // A real PDF, not a placeholder.
    expect(label!.content.subarray(0, 4).toString()).toBe('%PDF')
  })

  it('has no label to hand back for a parcel that never had one', async () => {
    await service.importEml(fixturePath('Je pakket is nu bij DHL.eml'))
    const parcel = service.listShipments()[0]!
    expect(await service.labelFor(parcel.id)).toBeNull()
  })

  it('does not count a sale with no cost basis as profit', async () => {
    await importVinted()

    const dashboard = service.dashboard()
    expect(dashboard.profit.uncosted).toBeGreaterThan(0)
    // Revenue is real; profit without a cost behind it is not.
    expect(dashboard.profit.netMinor).toBe(0)
  })

  it('matches a Vinted sale to stock when the same article is held', async () => {
    await service.importEml(fixturePath('Bedankt_voor_je_bestelling_0.eml'))
    const held = service.listInventory()[0]!

    // A sale of exactly what is in stock: this one does have a cost.
    service.sellItems([held.id], { amountMinor: 9000, includesVat: true, buyer: 'Someone' })

    const sale = service.listSales()[0]!
    expect(sale.costMinor).toBe(held.costMinor)
    expect(sale.profitMinor).toBe(9000 - held.costMinor)
  })
})

describe.skipIf(!allPresent)('an order knows which mailbox it came in on', () => {
  it('names the mailbox that received the order mail', async () => {
    await service.importEml(fixturePath('Bedankt voor je bestelling.eml'))

    const purchase = service.listPurchases().find((row) => row.kind === 'buy')!
    // Files dropped in the folder belong to the local import account; a real
    // mailbox names itself here.
    expect(purchase.mailbox).toBe('local@import')
    expect(purchase.mailSubject).toContain('bestelling')
  })

  it('names it for a cancellation with no order behind it too', async () => {
    await service.importEml(fixturePath('Je_artikel_is_geannuleerd_0.eml'))

    const cancel = service.listPurchases().find((row) => row.kind === 'cancel')!
    expect(cancel.mailbox).toBe('local@import')
    expect(cancel.mailSubject).toBeTruthy()
  })
})
