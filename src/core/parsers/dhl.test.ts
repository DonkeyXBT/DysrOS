import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadEml, type ParsedMessage } from '../mail/parsed-message.js'
import { dhlOutForDelivery, dhlDeliveryAppointment, findDeliveryWindow } from './dhl.js'

const FIXTURES = {
  outForDelivery: 'dhl-out-for-delivery.html',
  appointment: 'dhl-appointment.html',
} as const

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../fixtures/html/${name}`, import.meta.url))
}

const allPresent = Object.values(FIXTURES).every((name) => existsSync(fixturePath(name)))

/**
 * The fixtures were saved as HTML, which is the mail's body without its
 * envelope. Wrapping it in one is how it arrives over IMAP.
 */
function load(name: string, subject: string, date = 'Wed, 19 Aug 2026 10:04:00 +0200'): Promise<ParsedMessage> {
  const html = readFileSync(fixturePath(name), 'utf8')
  return loadEml([
    'From: DHL <noreply@dhlecommerce.nl>',
    `Subject: ${subject}`,
    `Date: ${date}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
  ].join('\r\n'))
}

describe('findDeliveryWindow', () => {
  it('reads the times DHL writes with dots', () => {
    expect(findDeliveryWindow('Tussen 12.20 - 16.20 uur')).toBe('12:20\u201316:20')
  })

  it('reads them with a dash of any kind, and pads the hour', () => {
    expect(findDeliveryWindow('tussen 9.05 – 11.35 uur')).toBe('09:05\u201311:35')
    expect(findDeliveryWindow('tussen 17:00—19:00')).toBe('17:00\u201319:00')
  })

  it('is null when no window is stated', () => {
    expect(findDeliveryWindow('Zodra de bezorger onderweg is, ontvang je bericht.')).toBeNull()
  })
})

describe.skipIf(!allPresent)('DHL says the courier is out with the parcel', () => {
  const subject = 'We staan vandaag voor de deur tussen 12.20-16.20 uur (JVGL0637312004384176)'

  it('claims the mail', async () => {
    expect(dhlOutForDelivery.matches(await load(FIXTURES.outForDelivery, subject))).toBe(true)
  })

  it('takes the barcode straight from the mail, with no link to follow', async () => {
    const [event] = dhlOutForDelivery.parse(await load(FIXTURES.outForDelivery, subject))

    expect(event!.type).toBe('shipped')
    expect(event!.payload).toMatchObject({
      carrier: 'dhl',
      trackingNumber: 'JVGL0637312004384176',
      shipmentStatus: 'out_for_delivery',
      deliveryWindow: '12:20\u201316:20',
      expectedDeliveryAt: '2026-08-19',
      shippedBy: 'bol',
    })
  })

  it('is not claimed by the appointment parser as well', async () => {
    expect(dhlDeliveryAppointment.matches(await load(FIXTURES.outForDelivery, subject))).toBe(false)
  })
})

describe.skipIf(!allPresent)('DHL announces the day it will call', () => {
  const subject = 'Woensdag komen we bij je langs (JVGL0637312004384176)'

  it('claims the mail and reads the day', async () => {
    const message = await load(FIXTURES.appointment, subject, 'Tue, 18 Aug 2026 17:20:00 +0200')
    expect(dhlDeliveryAppointment.matches(message)).toBe(true)

    const [event] = dhlDeliveryAppointment.parse(message)
    expect(event!.payload).toMatchObject({
      carrier: 'dhl',
      trackingNumber: 'JVGL0637312004384176',
      shipmentStatus: 'in_transit',
      shippedBy: 'bol',
    })
    // No window is promised yet, only a day.
    expect(event!.payload.deliveryWindow).toBeNull()
  })

  it('does not claim a bol mail that merely links to DHL', async () => {
    const bol = await loadEml([
      'From: bol <automail@bol.com>',
      'Subject: Je pakket is nu bij DHL',
      'Date: Tue, 18 Aug 2026 09:00:00 +0200',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<a href="https://my.dhlparcel.nl/home/tracktrace/JVGL0637312004384176">volg</a>',
    ].join('\r\n'))

    expect(dhlOutForDelivery.matches(bol)).toBe(false)
    expect(dhlDeliveryAppointment.matches(bol)).toBe(false)
  })
})
