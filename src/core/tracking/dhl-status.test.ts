import { describe, expect, it } from 'vitest'
import {
  fetchShipment, summarizeShipment, toShipmentStatus, type Fetcher,
} from './dhl-status.js'

function answering(body: unknown, status = 200): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = []
  const fetcher: Fetcher = async (url, init) => {
    calls.push(`${url}|${init.headers.source}`)
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  return { fetcher, calls }
}

describe('asking DHL where a parcel is', () => {
  it('asks by barcode, as the receiver, with the header their page sends', async () => {
    const { fetcher, calls } = answering([{ events: [] }])
    await fetchShipment('JVGL0637312004384176', fetcher)

    expect(calls[0]).toBe(
      'https://api-gw.dhlparcel.nl/track-trace?key=JVGL0637312004384176&role=receiver|TT_onboarding_browser_desktop',
    )
  })

  it('is null for a barcode DHL does not know', async () => {
    const { fetcher } = answering(null, 404)
    expect(await fetchShipment('JVGL0000000000000000', fetcher)).toBeNull()
  })

  it('is null for an empty answer rather than an invented parcel', async () => {
    const { fetcher } = answering([])
    expect(await fetchShipment('JVGL0637312004384176', fetcher)).toBeNull()
  })

  it('reports a fault rather than pretending the parcel vanished', async () => {
    const { fetcher } = answering(null, 500)
    await expect(fetchShipment('JVGL0637312004384176', fetcher)).rejects.toThrow('500')
  })
})

describe('reading the event history', () => {
  it('calls it delivered when DHL says it was delivered', () => {
    expect(summarizeShipment({
      deliveredAt: '2026-08-19T15:30:00Z',
      events: [{ status: 'DELIVERED', category: 'DELIVERED', timestamp: '2026-08-19T15:30:00Z' }],
    }).state).toBe('delivered')
  })

  it('takes the latest event, not the first', () => {
    const status = summarizeShipment({
      events: [
        { status: 'DATA_RECEIVED', category: 'DATA_RECEIVED', timestamp: '2026-08-17T08:00:00Z' },
        { status: 'OUT_FOR_DELIVERY', category: 'IN_DELIVERY', timestamp: '2026-08-19T07:00:00Z' },
      ],
    })
    expect(status.state).toBe('out for delivery')
    expect(status.lastEventAt).toBe('2026-08-19T07:00:00Z')
  })

  it('knows a parcel waiting at a ServicePoint', () => {
    expect(summarizeShipment({
      events: [{ status: 'DELIVERED_AT_PARCELSHOP', category: 'UNDERWAY', timestamp: '2026-08-19T12:00:00Z' }],
    }).state).toBe('ready for pickup')
  })

  it('treats our own redirect as movement, not as delivery', () => {
    expect(summarizeShipment({
      events: [{ status: 'INTERVENTION_REQUESTED', category: 'INTERVENTION', timestamp: '2026-08-19T10:00:00Z' }],
    }).state).toBe('in transit')
  })

  it('says unknown for a parcel DHL has no events for', () => {
    expect(summarizeShipment({ events: [] }).state).toBe('unknown')
    expect(summarizeShipment(null).state).toBe('unknown')
  })

  it('reads the status in words rather than in shouting', () => {
    expect(summarizeShipment({
      events: [{ status: 'SHIPMENT_SORTED', category: 'UNDERWAY', timestamp: '2026-08-18T09:00:00Z' }],
    }).detail).toBe('shipment sorted')
  })
})

describe('translating to the words the app uses', () => {
  it('maps every state it knows', () => {
    expect(toShipmentStatus('delivered')).toBe('delivered')
    expect(toShipmentStatus('ready for pickup')).toBe('ready_for_pickup')
    expect(toShipmentStatus('out for delivery')).toBe('out_for_delivery')
    expect(toShipmentStatus('in transit')).toBe('in_transit')
    expect(toShipmentStatus('announced')).toBe('pending')
  })

  it('changes nothing when DHL knows nothing', () => {
    expect(toShipmentStatus('unknown')).toBeNull()
  })
})
