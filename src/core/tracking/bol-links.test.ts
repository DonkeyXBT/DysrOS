import { describe, it, expect } from 'vitest'
import {
  collectTrackingCandidates, isExcludedLink, repairHref, MAX_CANDIDATES,
} from './bol-links.js'

describe('excluded links', () => {
  it('rejects the account and login pages a shipping mail is full of', () => {
    for (const href of [
      'https://www.bol.com/nl/rnwy/account/overzicht',
      'https://mijn.bol.com/bestellingen',
      'https://login.bol.com/wsp/login?x=1',
      'https://www.bol.com/nl/klantenservice/index.html',
      'https://www.bol.com/nl/account/login',
    ]) {
      expect(isExcludedLink(href), href).toBe(true)
    }
  })

  it('keeps a real tracking redirect', () => {
    expect(isExcludedLink('https://link.bol.com/t/TOKEN?notificationId=abc')).toBe(false)
  })

  it('rejects an empty href or a mailto', () => {
    expect(isExcludedLink('')).toBe(true)
    expect(isExcludedLink('mailto:someone@bol.com')).toBe(true)
  })
})

describe('repairing a quoted-printable href', () => {
  it('rejoins a URL split by a soft line break', () => {
    expect(repairHref('https://link.bol.com/t/AAA=\r\nBBB')).toBe('https://link.bol.com/t/AAABBB')
  })

  it('restores the equals sign eaten out of notificationId', () => {
    // '=' is the quoted-printable escape character, so it is the one most often lost.
    expect(repairHref('https://link.bol.com/t/X?notificationId01a0150b-8de8-7c4b'))
      .toBe('https://link.bol.com/t/X?notificationId=01a0150b-8de8-7c4b')
  })

  it('leaves an intact notificationId alone', () => {
    const url = 'https://link.bol.com/t/X?notificationId=01a0150b'
    expect(repairHref(url)).toBe(url)
  })

  it('decodes escaped ampersands and equals signs', () => {
    expect(repairHref('https://link.bol.com/t/X?a=3D1&amp;b=2')).toBe('https://link.bol.com/t/X?a=1&b=2')
  })
})

describe('collecting candidates', () => {
  const html = `
    <a href="https://www.bol.com/nl/rnwy/account/overzicht">Mijn bol</a>
    <a href="https://www.bol.com/nl/klantenservice/index.html">Klantenservice</a>
    <a href="https://link.bol.com/t/REALTOKEN?notificationId=abc">Volg je pakket</a>
    <a href="https://www.bol.com/nl/p/product/123">Het artikel</a>
  `

  it('puts the tracking redirect first and drops the account links', () => {
    const candidates = collectTrackingCandidates(html)
    expect(candidates[0]).toContain('link.bol.com/t/REALTOKEN')
    expect(candidates.some((c) => c.includes('account/overzicht'))).toBe(false)
    expect(candidates.some((c) => c.includes('klantenservice'))).toBe(false)
  })

  it('finds a link that survived only as bare text', () => {
    const mangled = 'Volg je pakket: https://link.bol.com/t/BARE?notificationId=1 en verder'
    expect(collectTrackingCandidates(mangled)[0]).toContain('link.bol.com/t/BARE')
  })

  it('de-duplicates the same link appearing as anchor and text', () => {
    const both = `<a href="https://link.bol.com/t/SAME">x</a> https://link.bol.com/t/SAME`
    expect(collectTrackingCandidates(both)).toHaveLength(1)
  })

  it('never returns more than it is worth making requests for', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      `<a href="https://link.bol.com/t/T${i}">volg</a>`).join('')
    expect(collectTrackingCandidates(many)).toHaveLength(MAX_CANDIDATES)
  })

  it('ignores links to other domains entirely', () => {
    const html = '<a href="https://example.com/track/123">track</a>'
    expect(collectTrackingCandidates(html)).toEqual([])
  })

  it('repairs candidates as it collects them', () => {
    const html = '<a href="https://link.bol.com/t/X?notificationId01a0150b">volg</a>'
    expect(collectTrackingCandidates(html)[0]).toContain('notificationId=01a0150b')
  })
})
