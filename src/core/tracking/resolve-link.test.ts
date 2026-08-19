import { describe, it, expect } from 'vitest'
import {
  extractTrackingFromUrl, resolveTrackingLink, normalisePostnlCode,
  isNonCarrierBolLanding, type Fetcher,
} from './resolve-link.js'

describe('extractTrackingFromUrl', () => {
  it('reads a PostNL 3S barcode from a track-and-trace path', () => {
    expect(extractTrackingFromUrl('https://jouw.postnl.nl/track-and-trace/3SABCD123456789-NL-1012AB'))
      .toMatchObject({ carrier: 'postnl', trackingNumber: '3SABCD123456789' })
  })

  it('reads a PostNL barcode from a query parameter', () => {
    expect(extractTrackingFromUrl('https://jouw.postnl.nl/?barcode=3SXYZ987654321&country=NL'))
      .toMatchObject({ carrier: 'postnl', trackingNumber: '3SXYZ987654321' })
  })

  it('reads a DHL JVGL code', () => {
    expect(extractTrackingFromUrl('https://my.dhlecommerce.nl/home/tracktrace/JVGL01234567890123'))
      .toMatchObject({ carrier: 'dhl', trackingNumber: 'JVGL01234567890123' })
  })

  it('reads a DHL JJD code from a query parameter', () => {
    expect(extractTrackingFromUrl('https://www.dhl.com/nl-nl/home/tracking.html?tracking-id=JJD000390009999999999'))
      .toMatchObject({ carrier: 'dhl', trackingNumber: 'JJD000390009999999999' })
  })

  it('infers the carrier from the host when the code shape is unfamiliar', () => {
    expect(extractTrackingFromUrl('https://jouw.postnl.nl/track-and-trace/?barcode=CD123456789NL'))
      .toMatchObject({ carrier: 'postnl', trackingNumber: 'CD123456789NL' })
  })

  it('returns null for a URL carrying no tracking code', () => {
    expect(extractTrackingFromUrl('https://www.bol.com/nl/order/overview')).toBeNull()
    expect(extractTrackingFromUrl('https://jouw.postnl.nl/')).toBeNull()
  })

  it('does not mistake the bol redirect token for a tracking code', () => {
    expect(extractTrackingFromUrl('https://link.bol.com/t/Zj3xkCgcMpWwliuZkjBRDgdot9kH6c3g2QCoedAqpf6A'))
      .toBeNull()
  })
})

function fakeFetcher(chain: Record<string, { status: number; location?: string }>): Fetcher {
  return async (url) => {
    const hop = chain[url]
    if (!hop) throw new Error(`unexpected request to ${url}`)
    return {
      status: hop.status,
      url,
      headers: new Headers(hop.location ? { location: hop.location } : {}),
    }
  }
}

const START = 'https://link.bol.com/t/TOKEN123'

describe('resolveTrackingLink', () => {
  it('follows the redirect chain and returns the carrier code', async () => {
    const fetcher = fakeFetcher({
      [START]: { status: 302, location: 'https://tracking.bol.com/hop' },
      'https://tracking.bol.com/hop': {
        status: 302,
        location: 'https://jouw.postnl.nl/track-and-trace/3SABCD123456789-NL-1012AB',
      },
      'https://jouw.postnl.nl/track-and-trace/3SABCD123456789-NL-1012AB': { status: 200 },
    })

    await expect(resolveTrackingLink(START, { fetcher })).resolves.toMatchObject({
      carrier: 'postnl',
      trackingNumber: '3SABCD123456789',
      finalUrl: 'https://jouw.postnl.nl/track-and-trace/3SABCD123456789-NL-1012AB',
    })
  })

  it('stops as soon as a hop reveals a tracking code', async () => {
    let calls = 0
    const fetcher: Fetcher = async (url) => {
      calls += 1
      if (url === START) {
        return {
          status: 302,
          url,
          headers: new Headers({ location: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL01234567890123' }),
        }
      }
      throw new Error('should not have followed further')
    }

    const result = await resolveTrackingLink(START, { fetcher })
    expect(result?.trackingNumber).toBe('JVGL01234567890123')
    expect(calls).toBe(1)
  })

  it('resolves a relative redirect against the current hop', async () => {
    const fetcher = fakeFetcher({
      [START]: { status: 302, location: '/track-and-trace/3SABCD123456789' },
      'https://link.bol.com/track-and-trace/3SABCD123456789': { status: 200 },
    })
    const result = await resolveTrackingLink(START, { fetcher })
    expect(result?.trackingNumber).toBe('3SABCD123456789')
  })

  it('gives up after the redirect limit rather than looping forever', async () => {
    const fetcher: Fetcher = async (url) => ({
      status: 302,
      url,
      headers: new Headers({ location: 'https://example.com/again' }),
    })
    await expect(resolveTrackingLink(START, { fetcher, maxHops: 3 })).resolves.toBeNull()
  })

  it('returns null when the chain ends without a tracking code', async () => {
    const fetcher = fakeFetcher({
      [START]: { status: 302, location: 'https://www.bol.com/nl/order/overview' },
      'https://www.bol.com/nl/order/overview': { status: 200 },
    })
    await expect(resolveTrackingLink(START, { fetcher })).resolves.toBeNull()
  })

  it('returns null instead of throwing when the request fails', async () => {
    const fetcher: Fetcher = async () => {
      throw new Error('network down')
    }
    await expect(resolveTrackingLink(START, { fetcher })).resolves.toBeNull()
  })

  it('refuses a URL that is not a bol.com tracking link', async () => {
    const fetcher: Fetcher = async () => {
      throw new Error('should never be called')
    }
    await expect(resolveTrackingLink('https://evil.example.com/t/x', { fetcher })).resolves.toBeNull()
  })
})

describe('carrier URL shapes bol.com actually redirects to', () => {
  it('reads a PostNL barcode and strips the destination suffix', () => {
    expect(extractTrackingFromUrl('https://jouw.postnl.nl/track-and-trace/3SBTC0294817263-NL-1012AB'))
      .toMatchObject({ carrier: 'postnl', trackingNumber: '3SBTC0294817263' })
  })

  it('reads the English PostNL path variant', () => {
    expect(extractTrackingFromUrl('https://jouw.postnl.nl/track-en-trace/3SBTC0294817263-NL-1012AB'))
      .toMatchObject({ carrier: 'postnl', trackingNumber: '3SBTC0294817263' })
  })

  it('reads a DHL eCommerce tracktrace path', () => {
    expect(extractTrackingFromUrl('https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600'))
      .toMatchObject({ carrier: 'dhl', trackingNumber: 'JVGL0627463317265600' })
  })

  it('reads a DHL parcel tracktrace path', () => {
    expect(extractTrackingFromUrl('https://my.dhlparcel.nl/home/tracktrace/JVGL0627463317265600'))
      .toMatchObject({ carrier: 'dhl', trackingNumber: 'JVGL0627463317265600' })
  })

  it('rejects a PostNL code of implausible length rather than truncating it', () => {
    expect(normalisePostnlCode('3SABC')).toBeNull()
    expect(normalisePostnlCode('JVGL0627463317265600')).toBeNull()
  })

  it('recognises the bol.com login page as a failed redirect, not a destination', () => {
    expect(isNonCarrierBolLanding('https://login.bol.com/login?flow=x')).toBe(true)
    expect(isNonCarrierBolLanding('https://jouw.postnl.nl/track-and-trace/3SBTC0294817263')).toBe(false)
  })

  it('sends a full browser fingerprint, without which bol.com diverts to login', async () => {
    let seen: Record<string, string> | undefined
    const fetcher: Fetcher = async (url, init) => {
      seen = init.headers
      return {
        status: 302,
        url,
        headers: new Headers({ location: 'https://jouw.postnl.nl/track-and-trace/3SBTC0294817263-NL-1012AB' }),
      }
    }
    await resolveTrackingLink('https://link.bol.com/t/TOKEN', { fetcher })
    expect(seen?.['user-agent']).toMatch(/Chrome/)
    expect(seen?.['sec-fetch-mode']).toBe('navigate')
  })
})

describe('the postcode DHL puts beside the barcode', () => {
  it('is kept apart from the barcode rather than appended to it', () => {
    // A real sync stored `JVGL0637312004304176/3043LC` as the tracking code,
    // which is neither a barcode nor anything the redirect tool can use.
    expect(extractTrackingFromUrl('https://my.dhlecommerce.nl/home/tracktrace/JVGL0637312004304176/3043LC'))
      .toEqual({
        carrier: 'dhl',
        trackingNumber: 'JVGL0637312004304176',
        postalCode: '3043LC',
      })
  })

  it('is taken from the parcel host too', () => {
    expect(extractTrackingFromUrl('https://my.dhlparcel.nl/home/tracktrace/JVGL0627463317265600/1012AB'))
      .toMatchObject({ trackingNumber: 'JVGL0627463317265600', postalCode: '1012AB' })
  })

  it('survives the interventions path the redirect tool uses', () => {
    expect(extractTrackingFromUrl('https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600/3071NE/interventions'))
      .toMatchObject({ trackingNumber: 'JVGL0627463317265600', postalCode: '3071NE' })
  })

  it('is null when the URL states only a barcode', () => {
    expect(extractTrackingFromUrl('https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600'))
      .toMatchObject({ trackingNumber: 'JVGL0627463317265600', postalCode: null })
  })
})
