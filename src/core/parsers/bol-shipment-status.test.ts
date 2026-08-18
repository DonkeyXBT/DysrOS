import { describe, it, expect } from 'vitest'
import { loadEml } from '../mail/parsed-message.js'
import { classifyShipment, findShipmentTitle } from './bol-shipment-status.js'

async function mail(subject: string, body = '') {
  return loadEml([
    'From: bol <automail@bol.com>',
    `Subject: ${subject}`,
    'Date: Tue, 18 Aug 2026 09:00:00 +0200',
    'Content-Type: text/html; charset=utf-8',
    '',
    `<html><body>${body}</body></html>`,
    '',
  ].join('\r\n'))
}

describe('carrier from the subject', () => {
  it('reads DHL and PostNL when the subject names them', async () => {
    expect((await classifyShipmentOf('Je pakket is nu bij DHL')).carrier).toBe('dhl')
    expect((await classifyShipmentOf('Je pakket is nu bij PostNL')).carrier).toBe('postnl')
  })
})

describe('carrier from the body when the subject does not say', () => {
  it('reads a DHL tracking domain', async () => {
    const message = await mail('De bezorger is onderweg', '<a href="https://my.dhlecommerce.nl/x">volg</a>')
    expect(classifyShipment(message, 'volg je pakket')!.carrier).toBe('dhl')
  })

  it('reads a PostNL tracking domain', async () => {
    const message = await mail('De bezorger is onderweg', '<a href="https://jouw.postnl.nl/x">volg</a>')
    expect(classifyShipment(message, 'volg je pakket')!.carrier).toBe('postnl')
  })

  it('prefers a tracking domain over a passing mention of the other carrier', async () => {
    const message = await mail(
      'De bezorger is onderweg',
      '<p>niet via PostNL</p><a href="https://my.dhlparcel.nl/x">volg</a>',
    )
    expect(classifyShipment(message, '')!.carrier).toBe('dhl')
  })
})

describe('the other variants a real mailbox carries', () => {
  it('treats a delivered notice as delivered, not as a dispatch', async () => {
    const variant = classifyShipment(await mail('Je pakket is bezorgd'), '')
    expect(variant!.status).toBe('delivered')
    expect(variant!.inTransit).toBe(false)
  })

  it('recognises a delayed parcel', async () => {
    expect(classifyShipment(await mail('Je pakket is vertraagd'), '')!.status).toBe('delayed')
    expect(classifyShipment(await mail('Je pakket is weer vertraagd'), '')!.status).toBe('delayed_again')
  })

  it('treats bol logistics as DHL unless the body says PostNL', async () => {
    expect(classifyShipment(await mail('Je artikelen komen eraan'), '')!.carrier).toBe('dhl')
    const viaPostnl = await mail('Je artikelen komen eraan', '<a href="https://jouw.postnl.nl/x">x</a>')
    expect(classifyShipment(viaPostnl, '')!.carrier).toBe('postnl')
  })

  it('marks the pre-dispatch notice as awaiting a carrier', async () => {
    const variant = classifyShipment(await mail('Je pakket komt eraan'), '')
    expect(variant!.status).toBe('awaiting_carrier')
    expect(variant!.carrier).toBeNull()
  })

  it('ignores mail that is not about a parcel at all', async () => {
    expect(classifyShipment(await mail('Bedankt voor je bestelling'), '')).toBeNull()
  })
})

describe('finding the item', () => {
  it('takes the line after the heading, skipping the item count', () => {
    const lines = ['Dit is onderweg', '1 artikel', 'Pokémon TCG - Ascended Heroes', 'Bezorgadres']
    expect(findShipmentTitle(lines, '')).toBe('Pokémon TCG - Ascended Heroes')
  })

  it('falls back to the item count when the heading wording changed', () => {
    const lines = ['Dit komt binnenkort', '2 artikelen', 'LEGO Botanicals']
    expect(findShipmentTitle(lines, '')).toBe('LEGO Botanicals')
  })

  it('falls back to the product image alt text when neither is present', () => {
    const html = '<img src="https://media.s-bol.com/abc/250x200.jpg" alt="Pokémon Elite Trainer Box">'
    expect(findShipmentTitle(['Volg je pakket'], html)).toBe('Pokémon Elite Trainer Box')
  })

  it('does not mistake a logo for the item', () => {
    const html = '<img src="https://media.s-bol.com/x.jpg" alt="bol logo">'
    expect(findShipmentTitle(['Volg je pakket'], html)).toBeNull()
  })

  it('skips layout lines that follow the heading', () => {
    const lines = ['Dit is onderweg', '1 artikel', 'Bezorgadres']
    expect(findShipmentTitle(lines, '')).toBeNull()
  })
})

async function classifyShipmentOf(subject: string) {
  const message = await mail(subject)
  return classifyShipment(message, '')!
}
