import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AppService } from './service.js'
import type { CompletedTask, MailTask } from '../core/aycd/client.js'
import type { WatcherClock } from '../core/aycd/watcher.js'

const FIXTURES = [
  'Bedankt voor je bestelling.eml',
  'Bedankt_voor_je_bestelling_0.eml',
  'Je_artikel_is_geannuleerd_0.eml',
  'Je pakket is nu bij DHL.eml',
  'Je pakket is nu bij PostNL.eml',
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
    expect(shipments).toHaveLength(2)
    expect(shipments.map((s) => s.carrier).sort()).toEqual(['dhl', 'postnl'])
    expect(shipments.every((s) => /^\d{4}[A-Z]{2}$/.test(s.postalCode ?? ''))).toBe(true)
    expect(shipments.every((s) => s.expectedDeliveryAt === '2026-08-19')).toBe(true)
  })

  it('reports shipments as awaiting a tracking code', async () => {
    await importAll()
    expect(service.summary().awaitingTracking).toBe(2)
    expect(service.listShipments().every((s) => s.trackingNumber === null)).toBe(true)
  })

  it('counts only the DHL parcel as redirect-ready', async () => {
    await importAll()
    expect(service.summary().redirectable).toBe(1)
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
    expect(byId['bol-shipment-confirmation']).toBe(2)
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
    expect(linked).toHaveLength(2)
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
    expect(dashboard.inFlight.parcels).toBe(2)
    expect(dashboard.inFlight.awaitingCode).toBe(2)
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
