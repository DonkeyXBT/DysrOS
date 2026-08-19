import { formatMoney, money, type Money } from '../money.js'

/**
 * Discord webhook notifications.
 *
 * An embed is built per event type rather than posting a line of text, because
 * the useful thing at a glance is the shape: colour for what happened, the item
 * as the title, and money and tracking as fields you can read without opening
 * anything.
 *
 * Nothing is ever posted without a webhook URL being configured, and the URL is
 * treated as a secret — it grants anyone who holds it the ability to post into
 * the channel.
 */

export type NotifiableEvent =
  | 'order_placed'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded'
  | 'sale'
  | 'payout'
  | 'shipment_exception'

export interface NotificationInput {
  event: NotifiableEvent
  retailer: string
  reference: string | null
  title: string | null
  quantity?: number
  amount?: Money | null
  carrier?: string | null
  trackingNumber?: string | null
  trackingUrl?: string | null
  expectedDeliveryAt?: string | null
  occurredAt: string
}

export interface DiscordEmbed {
  title: string
  description?: string
  url?: string
  color: number
  fields: { name: string; value: string; inline: boolean }[]
  footer: { text: string }
  timestamp: string
}

export interface DiscordPayload {
  username: string
  embeds: DiscordEmbed[]
}

/** Colours chosen to match the application's own status palette. */
const COLOUR: Record<NotifiableEvent, number> = {
  order_placed: 0x5b8cff,
  shipped: 0x6ee7d4,
  delivered: 0x53d09a,
  cancelled: 0x8d94a6,
  refunded: 0xf7a08a,
  sale: 0x6ee7d4,
  payout: 0x53d09a,
  shipment_exception: 0xe8386f,
}

const HEADLINE: Record<NotifiableEvent, string> = {
  order_placed: 'Order placed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  refunded: 'Refund received',
  sale: 'Sold',
  payout: 'Payout received',
  shipment_exception: 'Shipment problem',
}

/** Discord rejects an embed title over 256 characters outright. */
const MAX_TITLE = 240

export function buildEmbed(input: NotificationInput): DiscordEmbed {
  const fields: DiscordEmbed['fields'] = []

  if (input.quantity && input.quantity > 1) {
    fields.push({ name: 'Quantity', value: `${input.quantity}`, inline: true })
  }
  if (input.amount) {
    fields.push({ name: 'Amount', value: formatMoney(input.amount), inline: true })
  }
  if (input.carrier) {
    fields.push({ name: 'Carrier', value: input.carrier.toUpperCase(), inline: true })
  }
  if (input.trackingNumber) {
    fields.push({ name: 'Tracking', value: `\`${input.trackingNumber}\``, inline: false })
  } else if (input.trackingUrl) {
    // The retailer sent only a redirect, so say so rather than leaving a gap
    // that reads as "no tracking exists".
    fields.push({ name: 'Tracking', value: `[Follow the parcel](${input.trackingUrl})`, inline: false })
  }
  if (input.expectedDeliveryAt) {
    fields.push({ name: 'Expected', value: input.expectedDeliveryAt, inline: true })
  }
  if (input.reference) {
    fields.push({ name: 'Order', value: `\`${input.reference}\``, inline: true })
  }

  const title = input.title ?? `${HEADLINE[input.event]} · ${input.retailer}`

  return {
    title: title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title,
    description: `**${HEADLINE[input.event]}** · ${input.retailer}`,
    ...(input.trackingUrl && !input.trackingNumber ? {} : {}),
    color: COLOUR[input.event],
    fields,
    footer: { text: 'Resell Ops' },
    timestamp: input.occurredAt,
  }
}

export function buildPayload(inputs: NotificationInput[]): DiscordPayload {
  // Discord accepts at most ten embeds in one message.
  return {
    username: 'Resell Ops',
    embeds: inputs.slice(0, 10).map(buildEmbed),
  }
}

export function isWebhookUrl(url: string): boolean {
  return /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url.trim())
}

/** The URL with its token hidden, for showing in the interface. */
export function maskWebhookUrl(url: string): string {
  const match = /^(https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/)(.+)$/.exec(url.trim())
  if (!match) return '—'
  return `${match[1]}${'•'.repeat(8)}`
}

export type PostFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  headers?: { get(name: string): string | null }
}>

/** Discord rate limits per webhook; a burst of notifications hits it easily. */
export const MAX_ATTEMPTS = 4
const BASE_BACKOFF_MS = 1000
/** However long Discord asks us to wait, never block for longer than this. */
const MAX_WAIT_MS = 15_000

export type SleepFn = (ms: number) => Promise<void>

/**
 * How long to wait before retrying.
 *
 * Discord says how long in `Retry-After`; obeying it is the difference between
 * clearing the limit and extending it. Without one, back off exponentially.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterHeader: string | null,
): number {
  const stated = Number(retryAfterHeader)
  if (Number.isFinite(stated) && stated > 0) {
    // The header is in seconds, and some responses use fractions of one.
    return Math.min(MAX_WAIT_MS, Math.ceil(stated * 1000))
  }
  return Math.min(MAX_WAIT_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1))
}

export interface SendResult {
  ok: boolean
  message: string
}

export async function sendToDiscord(
  webhookUrl: string,
  inputs: NotificationInput[],
  post: PostFn = globalThis.fetch as unknown as PostFn,
  sleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<SendResult> {
  if (!isWebhookUrl(webhookUrl)) {
    return { ok: false, message: 'That does not look like a Discord webhook URL.' }
  }
  if (inputs.length === 0) return { ok: true, message: 'Nothing to send.' }

  const body = JSON.stringify(buildPayload(inputs))
  let lastMessage = 'Discord could not be reached.'

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await post(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })

      if (response.ok) {
        return { ok: true, message: `Sent ${Math.min(inputs.length, 10)} notification(s).` }
      }

      // Rate limiting and server faults are worth waiting out; a wrong token or
      // a deleted webhook will never succeed, so retrying only wastes time.
      const worthRetrying = response.status === 429 || response.status >= 500
      if (!worthRetrying) {
        if (response.status === 404) {
          return { ok: false, message: 'Discord does not recognise that webhook. It may have been deleted.' }
        }
        if (response.status === 401 || response.status === 403) {
          return { ok: false, message: 'Discord rejected the webhook token.' }
        }
        return { ok: false, message: `Discord returned ${response.status}: ${await response.text()}` }
      }

      lastMessage = response.status === 429
        ? 'Discord rate limited this webhook.'
        : `Discord returned ${response.status}.`

      if (attempt < MAX_ATTEMPTS) {
        await sleep(retryDelayMs(attempt, response.headers?.get('retry-after') ?? null))
      }
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error)
      if (attempt < MAX_ATTEMPTS) await sleep(retryDelayMs(attempt, null))
    }
  }

  return { ok: false, message: `${lastMessage} Gave up after ${MAX_ATTEMPTS} attempts.` }
}

/** A representative embed for the "send test message" button. */
export function sampleNotification(occurredAt: string): NotificationInput {
  return {
    event: 'shipped',
    retailer: 'bol',
    reference: 'A0007D41RW',
    title: 'Pokémon TCG — Ascended Heroes Booster Bundle',
    quantity: 2,
    amount: money(5399, 'EUR'),
    carrier: 'dhl',
    trackingNumber: null,
    trackingUrl: 'https://link.bol.com/t/example',
    expectedDeliveryAt: occurredAt.slice(0, 10),
    occurredAt,
  }
}
