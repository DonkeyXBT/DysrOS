import { describe, it, expect } from 'vitest'
import { money } from '../money.js'
import {
  buildEmbed, buildPayload, isWebhookUrl, maskWebhookUrl, sendToDiscord,
  sampleNotification, retryDelayMs, MAX_ATTEMPTS, type NotificationInput, type PostFn,
} from './discord.js'

function input(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    event: 'shipped',
    retailer: 'bol',
    reference: 'A0007D41RW',
    title: 'Pokémon TCG - Ascended Heroes Booster Bundle',
    quantity: 2,
    amount: money(5399, 'EUR'),
    carrier: 'dhl',
    trackingNumber: '3SBTC0294817263',
    occurredAt: '2026-08-19T10:00:00.000Z',
    ...overrides,
  }
}

function fakePost(respond: { ok?: boolean; status?: number; body?: string } = {}) {
  const calls: { url: string; body: unknown }[] = []
  const post: PostFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return {
      ok: respond.ok ?? true,
      status: respond.status ?? 204,
      text: async () => respond.body ?? '',
    }
  }
  return { post, calls }
}

describe('embed shape', () => {
  it('leads with the item, since that is what identifies it at a glance', () => {
    // The action is the headline; the goods are the body.
    expect(buildEmbed(input()).title).toBe('Shipped')
    expect(buildEmbed(input()).description)
      .toBe('**2× Pokémon TCG - Ascended Heroes Booster Bundle** · bol')
  })

  it('still says what happened when the item is unknown', () => {
    const embed = buildEmbed(input({ title: null }))
    expect(embed.title).toBe('Shipped')
    expect(embed.description).toBe('bol')
  })

  it('leads with the parcel status when there is one', () => {
    const embed = buildEmbed(input({ status: 'Out for delivery' }))
    expect(embed.title).toBe('Out for delivery')
    expect(embed.description).toContain('Pokémon')
  })

  it('colours each event type differently', () => {
    const shipped = buildEmbed(input({ event: 'shipped' })).color
    const cancelled = buildEmbed(input({ event: 'cancelled' })).color
    const exception = buildEmbed(input({ event: 'shipment_exception' })).color
    expect(new Set([shipped, cancelled, exception]).size).toBe(3)
  })

  it('formats money with its currency rather than a bare number', () => {
    const field = buildEmbed(input()).fields.find((f) => f.name === 'Amount')
    expect(field?.value).toBe('€53.99')
  })

  it('shows a tracking code as code, so it can be copied cleanly', () => {
    const field = buildEmbed(input()).fields.find((f) => f.name === 'Tracking')
    expect(field?.value).toBe('`3SBTC0294817263`')
  })

  it('offers the retailer link when there is no code, rather than leaving a gap', () => {
    const embed = buildEmbed(input({ trackingNumber: null, trackingUrl: 'https://link.bol.com/t/x' }))
    const field = embed.fields.find((f) => f.name === 'Tracking')
    // A missing field would read as "no tracking exists", which is not the case.
    expect(field?.value).toContain('https://link.bol.com/t/x')
  })

  it('omits a quantity of one rather than stating the obvious', () => {
    expect(buildEmbed(input({ quantity: 1 })).fields.some((f) => f.name === 'Quantity')).toBe(false)
    expect(buildEmbed(input({ quantity: 3 })).fields.some((f) => f.name === 'Quantity')).toBe(true)
  })

  it('omits money entirely when none is known', () => {
    expect(buildEmbed(input({ amount: null })).fields.some((f) => f.name === 'Amount')).toBe(false)
  })

  it('truncates a description Discord would choke on', () => {
    const embed = buildEmbed(input({ title: 'x'.repeat(4000) }))
    expect(embed.description!.length).toBeLessThanOrEqual(500)
    expect(embed.description!.endsWith('…')).toBe(true)
  })

  it('truncates a status long enough to be refused as a title', () => {
    const embed = buildEmbed(input({ status: 'x'.repeat(400) }))
    expect(embed.title.length).toBeLessThanOrEqual(240)
    expect(embed.title.endsWith('…')).toBe(true)
  })

  it('carries the time the thing happened, not the time it was sent', () => {
    expect(buildEmbed(input()).timestamp).toBe('2026-08-19T10:00:00.000Z')
  })
})

describe('payload', () => {
  it('never exceeds the ten embeds Discord accepts', () => {
    const many = Array.from({ length: 25 }, () => input())
    expect(buildPayload(many).embeds).toHaveLength(10)
  })

  it('posts under a consistent name', () => {
    expect(buildPayload([input()]).username).toBe('Resell Ops')
  })
})

describe('webhook URL handling', () => {
  it('accepts a real webhook URL', () => {
    expect(isWebhookUrl('https://discord.com/api/webhooks/123456789/abcDEF-ghi_JKL')).toBe(true)
    expect(isWebhookUrl('https://ptb.discord.com/api/webhooks/123456789/abcDEF')).toBe(true)
  })

  it('rejects anything that is not one', () => {
    expect(isWebhookUrl('https://example.com/hook')).toBe(false)
    expect(isWebhookUrl('http://discord.com/api/webhooks/1/x')).toBe(false)
    expect(isWebhookUrl('')).toBe(false)
  })

  it('masks the token when showing the URL', () => {
    const masked = maskWebhookUrl('https://discord.com/api/webhooks/123456789/secrettoken')
    expect(masked).not.toContain('secrettoken')
    expect(masked).toContain('123456789')
  })
})

describe('sending', () => {
  it('posts the embeds as JSON', async () => {
    const { post, calls } = fakePost()
    const result = await sendToDiscord(
      'https://discord.com/api/webhooks/1/tok', [input()], post,
    )
    expect(result.ok).toBe(true)
    expect((calls[0]!.body as { embeds: unknown[] }).embeds).toHaveLength(1)
  })

  it('refuses a URL that is not a webhook, without making a request', async () => {
    const { post, calls } = fakePost()
    const result = await sendToDiscord('https://example.com/hook', [input()], post)
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('explains a deleted webhook rather than showing a bare 404', async () => {
    const { post } = fakePost({ ok: false, status: 404 })
    const result = await sendToDiscord('https://discord.com/api/webhooks/1/tok', [input()], post)
    expect(result.message).toMatch(/deleted/i)
  })

  it('explains rate limiting', async () => {
    const { post } = fakePost({ ok: false, status: 429 })
    // No real waiting: the retry delays are asserted separately.
    const result = await sendToDiscord(
      'https://discord.com/api/webhooks/1/tok', [input()], post, async () => {},
    )
    expect(result.message).toMatch(/rate limit/i)
  })

  it('returns a failure instead of throwing when the network is down', async () => {
    const post: PostFn = async () => {
      throw new Error('getaddrinfo ENOTFOUND discord.com')
    }
    const result = await sendToDiscord(
      'https://discord.com/api/webhooks/1/tok', [input()], post, async () => {},
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('ENOTFOUND')
  })

  it('does nothing when there is nothing to report', async () => {
    const { post, calls } = fakePost()
    const result = await sendToDiscord('https://discord.com/api/webhooks/1/tok', [], post)
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe('test message', () => {
  it('produces a representative embed', () => {
    const embed = buildEmbed(sampleNotification('2026-08-19T10:00:00.000Z'))
    expect(embed.fields.some((f) => f.name === 'Carrier')).toBe(true)
    expect(embed.title).toBe('Shipped')
    expect(embed.description).toContain('Pokémon')
  })
})

describe('surviving rate limits', () => {
  function countingPost(statuses: number[], retryAfter?: string) {
    const calls: number[] = []
    const post: PostFn = async () => {
      const status = statuses[calls.length] ?? 204
      calls.push(status)
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => '',
        headers: { get: (name: string) => (name === 'retry-after' ? retryAfter ?? null : null) },
      }
    }
    return { post, calls }
  }

  const noSleep = async () => {}

  it('retries a rate limit and succeeds on a later attempt', async () => {
    const { post, calls } = countingPost([429, 429, 204])
    const result = await sendToDiscord('https://discord.com/api/webhooks/1/tok', [input()], post, noSleep)

    expect(result.ok).toBe(true)
    expect(calls).toEqual([429, 429, 204])
  })

  it('gives up after a bounded number of attempts rather than hammering', async () => {
    const { post, calls } = countingPost([429, 429, 429, 429, 429, 429])
    const result = await sendToDiscord('https://discord.com/api/webhooks/1/tok', [input()], post, noSleep)

    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(MAX_ATTEMPTS)
    expect(result.message).toMatch(/gave up after/i)
  })

  it('waits as long as Discord asks, not a guess of its own', async () => {
    // Obeying Retry-After is the difference between clearing the limit and
    // extending it.
    expect(retryDelayMs(1, '2')).toBe(2000)
    expect(retryDelayMs(1, '0.75')).toBe(750)
  })

  it('backs off exponentially when no delay is stated', () => {
    expect(retryDelayMs(1, null)).toBe(1000)
    expect(retryDelayMs(2, null)).toBe(2000)
    expect(retryDelayMs(3, null)).toBe(4000)
  })

  it('never waits absurdly long, whatever the header says', () => {
    expect(retryDelayMs(1, '600')).toBeLessThanOrEqual(15_000)
    expect(retryDelayMs(9, null)).toBeLessThanOrEqual(15_000)
  })

  it('retries a server fault too', async () => {
    const { post, calls } = countingPost([503, 204])
    const result = await sendToDiscord('https://discord.com/api/webhooks/1/tok', [input()], post, noSleep)
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('does not retry a rejected token, which will never succeed', async () => {
    const { post, calls } = countingPost([401, 204])
    const result = await sendToDiscord('https://discord.com/api/webhooks/1/tok', [input()], post, noSleep)

    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('does not retry a deleted webhook', async () => {
    const { post, calls } = countingPost([404, 204])
    await sendToDiscord('https://discord.com/api/webhooks/1/tok', [input()], post, noSleep)
    expect(calls).toHaveLength(1)
  })
})
