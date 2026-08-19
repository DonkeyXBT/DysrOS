/**
 * Resolves the opaque tracking link bol.com puts in shipping mail into a real
 * carrier barcode.
 *
 * bol.com never states the barcode in the email — only a tokenised redirect on
 * `link.bol.com` that lands on the carrier's own tracking page, where the code
 * appears in the URL. Following it costs one request per shipment, so this runs
 * as a scheduled step rather than during parsing: ingestion stays offline and
 * deterministic, and a network failure can never corrupt a parsed event.
 */

export interface TrackingIdentity {
  carrier: string
  trackingNumber: string
  /** DHL puts the delivery postcode in the tracking URL next to the barcode.
   *  Taking it is how a parcel gets a postcode from mail that stated none. */
  postalCode?: string | null
}

export interface ResolvedTracking extends TrackingIdentity {
  finalUrl: string
}

/** Minimal shape of `fetch`, narrowed to what this needs, so tests inject a fake. */
export type Fetcher = (
  url: string,
  init: { redirect: 'manual'; signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ status: number; url: string; headers: Headers }>

export interface ResolveOptions {
  fetcher?: Fetcher
  maxHops?: number
  timeoutMs?: number
}

/** Hosts whose redirect chains we are willing to start following. */
const ALLOWED_START_HOSTS = ['link.bol.com', 'tracking.bol.com']

const CARRIER_BY_HOST: { pattern: RegExp; carrier: string }[] = [
  { pattern: /(^|\.)postnl\.nl$/i, carrier: 'postnl' },
  { pattern: /(^|\.)dhl(ecommerce)?\.(nl|com|de)$/i, carrier: 'dhl' },
  { pattern: /(^|\.)dpd\.(nl|com)$/i, carrier: 'dpd' },
  { pattern: /(^|\.)gls-group\.(eu|com)$/i, carrier: 'gls' },
  { pattern: /(^|\.)ups\.com$/i, carrier: 'ups' },
]

/**
 * Carrier tracking URLs in the shapes bol.com's redirect actually lands on.
 * Ported from a working implementation that has run against real bol shipping
 * mail, so these are observed forms rather than guesses.
 */
const URL_PATTERNS: { pattern: RegExp; carrier: string }[] = [
  { pattern: /https?:\/\/(?:www\.)?jouw\.postnl\.nl\/track-and-trace\/([^?\s#"'<>]+)/i, carrier: 'postnl' },
  { pattern: /https?:\/\/(?:www\.)?jouw\.postnl\.nl\/track-en-trace\/([^?\s#"'<>]+)/i, carrier: 'postnl' },
  { pattern: /https?:\/\/(?:www\.)?postnl\.nl\/(?:[^?\s#"'<>]+\/)*?(?:track-and-trace|track-en-trace)\/([^?\s#"'<>]+)/i, carrier: 'postnl' },
  // The barcode is one path segment. What follows it is the delivery postcode,
  // not part of the barcode — appending it produced tracking codes like
  // `JVGL0637312004304176/3043LC`, which no carrier and no redirect tool
  // accepts.
  { pattern: /https?:\/\/my\.dhlecommerce\.nl\/[^?\s#"'<>]*?\/tracktrace\/([A-Z0-9]{8,35})(?:\/([0-9]{4}\s?[A-Z]{2}))?/i, carrier: 'dhl' },
  { pattern: /https?:\/\/my\.dhlparcel\.nl\/[^?\s#"'<>]*?\/tracktrace\/([A-Z0-9]{8,35})(?:\/([0-9]{4}\s?[A-Z]{2}))?/i, carrier: 'dhl' },
  { pattern: /https?:\/\/[^?\s#"'<>]*(?:dhlecommerce|dhlparcel)\.nl[^?\s#"'<>]*?track(?:trace|ing)[/=]([A-Z0-9]+)/i, carrier: 'dhl' },
  { pattern: /[?&#](?:tracking[-_]?id|pieceNumber|trackingnumber|tracking_id)=([A-Z0-9]{10,32})/i, carrier: 'dhl' },
]

/** Code shapes distinctive enough to identify a carrier on their own. */
const CODE_PATTERNS: { pattern: RegExp; carrier: string }[] = [
  { pattern: /\b(3[SZ][A-Z0-9]{9,24}(?:-[A-Z]{2}-[A-Z0-9]+)?)\b/, carrier: 'postnl' },
  { pattern: /\b(JVGL\d{10,24})\b/, carrier: 'dhl' },
  { pattern: /\b(JJD[A-Z0-9]{8,24})\b/, carrier: 'dhl' },
]

/**
 * A PostNL barcode in a track URL carries a destination suffix
 * (`3SABC…-NL-1012AB`). The barcode proper is the part before the first dash,
 * 13 to 18 characters, starting `3S`.
 */
export function normalisePostnlCode(raw: string): string | null {
  const core = raw.trim().toUpperCase().split('-')[0]?.trim()
  if (!core || !core.startsWith('3S')) return null
  if (core.length < 13 || core.length > 18) return null
  return core
}

/** Query parameters carriers use to carry the barcode. */
const CODE_PARAMS = ['barcode', 'tracking-id', 'trackingnumber', 'trackingid', 'tc', 'ttcode', 'code']

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * bol.com's redirect is served by Salesforce and inspects the request. Without a
 * complete browser fingerprint the chain ends on login.bol.com instead of the
 * carrier — no cookies or session are needed, just these headers.
 */
export const BROWSER_HEADERS: Record<string, string> = {
  'accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,' +
    'image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7',
  'priority': 'u=0, i',
  'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/147.0.0.0 Safari/537.36',
}

/** A landing page that means the redirect failed rather than succeeded. */
export function isNonCarrierBolLanding(url: string): boolean {
  return /(?:login|www)\.bol\.com/i.test(url)
}

function carrierForHost(host: string): string | null {
  return CARRIER_BY_HOST.find((entry) => entry.pattern.test(host))?.carrier ?? null
}

/**
 * Pulls a tracking code out of a carrier URL. Returns null when the URL carries
 * none — notably for the bol.com redirect itself, whose token must never be
 * mistaken for a barcode.
 */
export function extractTrackingFromUrl(url: string): TrackingIdentity | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const host = parsed.hostname
  const hostCarrier = carrierForHost(host)

  // Whole-URL patterns first: these are the exact shapes bol.com redirects to.
  const decoded = safeDecode(url)
  for (const { pattern, carrier } of URL_PATTERNS) {
    const match = pattern.exec(decoded)
    const captured = match?.[1]
    if (captured) {
      const code = carrier === 'postnl'
        ? (normalisePostnlCode(captured) ?? captured.toUpperCase())
        : captured.toUpperCase()
      const postcode = match?.[2]?.replace(/\s+/g, '').toUpperCase() ?? null
      return { carrier, trackingNumber: code, postalCode: postcode }
    }
  }

  // A distinctive code shape identifies the carrier even without a known host.
  const searchable = safeDecode(parsed.pathname + parsed.search).toUpperCase()
  for (const { pattern, carrier } of CODE_PATTERNS) {
    const found = pattern.exec(searchable)?.[1]
    if (found) {
      const code = carrier === 'postnl' ? (normalisePostnlCode(found) ?? found) : found
      return { carrier: hostCarrier ?? carrier, trackingNumber: code }
    }
  }

  // Otherwise trust an explicit parameter, but only on a recognised carrier host
  // so an arbitrary redirect cannot inject a bogus code.
  if (!hostCarrier) return null
  for (const key of CODE_PARAMS) {
    const value = parsed.searchParams.get(key)
    if (value && /^[A-Z0-9-]{8,35}$/i.test(value)) {
      return { carrier: hostCarrier, trackingNumber: value.toUpperCase() }
    }
  }

  return null
}

export async function resolveTrackingLink(
  url: string,
  options: ResolveOptions = {},
): Promise<ResolvedTracking | null> {
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as Fetcher)
  const maxHops = options.maxHops ?? 8
  const timeoutMs = options.timeoutMs ?? 15_000

  let start: URL
  try {
    start = new URL(url)
  } catch {
    return null
  }
  if (!ALLOWED_START_HOSTS.includes(start.hostname)) return null

  let current = url
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    for (let hop = 0; hop < maxHops; hop += 1) {
      // Check before requesting: a redirect target may already carry the code,
      // which saves a pointless request to the carrier.
      const early = extractTrackingFromUrl(current)
      if (early) return { ...early, finalUrl: current }

      const response = await fetcher(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: BROWSER_HEADERS,
      })
      const location = response.headers.get('location')
      if (!location) {
        const found = extractTrackingFromUrl(response.url || current)
        return found ? { ...found, finalUrl: response.url || current } : null
      }

      const next = new URL(location, current).toString()
      const found = extractTrackingFromUrl(next)
      if (found) return { ...found, finalUrl: next }
      current = next
    }
    return null
  } catch {
    // A failed lookup is not an error worth propagating: the shipment simply
    // keeps its link and is retried on the next scheduled pass.
    return null
  } finally {
    clearTimeout(timer)
  }
}
