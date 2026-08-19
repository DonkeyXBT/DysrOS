import { describe, expect, it } from 'vitest'
import { toNotification, type NotifiableRow } from './from-events.js'

function row(overrides: Partial<NotifiableRow> = {}): NotifiableRow {
  return {
    id: 'event-1',
    type: 'shipped',
    retailer: 'bol',
    externalOrderId: 'C000D3LPPH',
    occurredAt: '2026-08-19T09:18:11.000Z',
    payload: {
      title: 'Pokémon TCG - Ascended Heroes Booster Bundle',
      quantity: 2,
      carrier: null,
      trackingNumber: null,
      trackingUrl: 'https://link.bol.com/t/abc',
      expectedDeliveryAt: '2026-08-19',
      deliveryWindow: '17:00–19:00',
      shipmentStatus: 'out_for_delivery',
    },
    ...overrides,
  }
}

describe('turning events into notifications', () => {
  it('makes one for a shipment', () => {
    const notification = toNotification(row())!
    expect(notification).toMatchObject({
      event: 'shipped',
      retailer: 'bol',
      reference: 'C000D3LPPH',
      quantity: 2,
      deliveryWindow: '17:00–19:00',
    })
  })

  it('says a parcel is out for delivery rather than merely shipped', () => {
    expect(toNotification(row())!.status).toBe('Out for delivery')
    expect(toNotification(row({ payload: { shipmentStatus: 'in_transit' } }))!.status).toBeNull()
  })

  it('prefers what the parcel knows over what the mail said', () => {
    const notification = toNotification(row({
      parcel: {
        carrier: 'postnl',
        trackingNumber: '3STUNM283054292',
        trackingUrl: 'https://jouw.postnl.nl/track-and-trace/3STUNM283054292-NL-3043LC',
        status: 'out_for_delivery',
        expectedDeliveryAt: '2026-08-19',
        deliveryWindow: '17:00–19:00',
      },
    }))!

    expect(notification.carrier).toBe('postnl')
    expect(notification.trackingNumber).toBe('3STUNM283054292')
    expect(notification.trackingUrl).toContain('jouw.postnl.nl')
  })

  it('carries the amount as money, not as a bare number', () => {
    const notification = toNotification(row({
      type: 'order_placed',
      payload: { title: 'LEGO', totalMinor: 16197, currency: 'EUR' },
    }))!

    expect(notification.amount).toEqual({ minor: 16197, currency: 'EUR' })
  })

  it('has no amount when the mail stated none', () => {
    expect(toNotification(row())!.amount).toBeNull()
  })

  it('ignores events nobody asked to hear about', () => {
    expect(toNotification(row({ type: 'order_confirmed' }))).toBeNull()
    expect(toNotification(row({ type: 'listing' }))).toBeNull()
  })

  it('covers every kind a rule exists for', () => {
    for (const type of ['order_placed', 'shipped', 'delivered', 'cancelled', 'refunded', 'sale', 'payout']) {
      expect(toNotification(row({ type })), type).not.toBeNull()
    }
  })
})
