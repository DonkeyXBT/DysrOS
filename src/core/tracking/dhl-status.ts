/**
 * Where a DHL parcel actually is, asked of DHL.
 *
 * Mail is the first source and usually the fastest, but it can be missed — a
 * filter, a mailbox not synced for an hour, a template nobody has written a
 * parser for yet. This asks the carrier directly, using the same public
 * track-trace API the my.dhlecommerce.nl page itself calls: no account, no
 * postcode, just the barcode and the header their web app sends.
 *
 * Read-only. Nothing here changes a parcel; it only reports what DHL says.
 */

const API_URL = 'https://api-gw.dhlparcel.nl/track-trace'

/** What their own web app sends. Without it the API answers with nothing. */
const SOURCE_HEADER = 'TT_onboarding_browser_desktop'

export interface CarrierEvent {
  status?: string
  category?: string
  timestamp?: string
}

export interface CarrierShipment {
  deliveredAt?: string
  events?: CarrierEvent[]
}

export type CarrierState =
  | 'announced'
  | 'in transit'
  | 'out for delivery'
  | 'ready for pickup'
  | 'delivered'
  | 'unknown'

export interface CarrierStatus {
  state: CarrierState
  detail: string | null
  lastEventAt: string | null
  deliveredAt: string | null
}

/** Statuses that mean the parcel is at a ServicePoint waiting to be collected. */
const READY_FOR_PICKUP = new Set([
  'DELIVERED_AT_PARCELSHOP',
  'NOTIFICATION_FOR_PARCELSHOP_COLLECTION_HAS_BEEN_SENT',
])

/** The coarse state each event category implies. */
const CATEGORY_STATES: Record<string, CarrierState> = {
  DATA_RECEIVED: 'announced',
  UNDERWAY: 'in transit',
  // A redirect of our own is an intervention: it does not move the parcel.
  INTERVENTION: 'in transit',
  IN_DELIVERY: 'out for delivery',
  DELIVERED: 'delivered',
}

export type Fetcher = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

/** The parcel as DHL holds it, or null when DHL does not know the barcode. */
export async function fetchShipment(
  trackingNumber: string,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher,
  timeoutMs = 15_000,
): Promise<CarrierShipment | null> {
  const url = `${API_URL}?key=${encodeURIComponent(trackingNumber)}&role=receiver`
  const response = await fetcher(url, {
    headers: { source: SOURCE_HEADER, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (response.status === 404) return null
  if (!response.ok) throw new Error(`DHL answered ${response.status}`)

  const data = await response.json()
  return Array.isArray(data) && data.length > 0 ? (data[0] as CarrierShipment) : null
}

/** Reduces a parcel's event history to the one thing worth showing. */
export function summarizeShipment(shipment: CarrierShipment | null): CarrierStatus {
  if (!shipment) {
    return { state: 'unknown', detail: 'DHL does not know this barcode', lastEventAt: null, deliveredAt: null }
  }

  const events = [...(shipment.events ?? [])].sort((a, b) =>
    String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')))
  const latest = events[events.length - 1]
  if (!latest) {
    return { state: 'unknown', detail: 'no events yet', lastEventAt: null, deliveredAt: null }
  }

  const base = {
    detail: humanize(latest.status),
    lastEventAt: latest.timestamp ?? null,
    deliveredAt: shipment.deliveredAt ?? null,
  }

  if (shipment.deliveredAt || latest.category === 'DELIVERED') return { state: 'delivered', ...base }
  if (latest.status && READY_FOR_PICKUP.has(latest.status)) return { state: 'ready for pickup', ...base }
  return { state: CATEGORY_STATES[latest.category ?? ''] ?? 'in transit', ...base }
}

/** The carrier's own words, in the vocabulary the shipments list uses. */
export function toShipmentStatus(state: CarrierState): string | null {
  switch (state) {
    case 'delivered': return 'delivered'
    case 'ready for pickup': return 'ready_for_pickup'
    case 'out for delivery': return 'out_for_delivery'
    case 'in transit': return 'in_transit'
    case 'announced': return 'pending'
    // An unknown barcode says nothing about the parcel, so it changes nothing.
    default: return null
  }
}

function humanize(status: string | undefined): string | null {
  if (!status) return null
  return status.toLowerCase().replace(/_/g, ' ')
}
