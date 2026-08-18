import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AppService } from './service.js'

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
    const purchases = service.listPurchases()
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
