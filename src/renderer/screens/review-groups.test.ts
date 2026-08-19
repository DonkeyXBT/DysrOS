import { describe, expect, it } from 'vitest'
import { groupReviewQueue, kindOf } from './review-groups.js'
import type { ReviewView } from '../api.js'

function mail(overrides: Partial<ReviewView> = {}): ReviewView {
  return {
    id: Math.random().toString(36).slice(2),
    from: 'DHL',
    address: 'noreply@dhlecommerce.nl',
    subject: 'We staan vandaag voor de deur tussen 12.20-16.20 uur',
    receivedAt: '2026-08-19T09:00:00.000Z',
    preview: 'Onze bezorger staat vandaag op de stoep met je pakket',
    exportable: true,
    ...overrides,
  }
}

describe('kindOf', () => {
  it('treats the same template with different times as one kind', () => {
    expect(kindOf(mail({ subject: 'We staan vandaag voor de deur tussen 12.20-16.20 uur' })))
      .toBe(kindOf(mail({ subject: 'We staan vandaag voor de deur tussen 17.00-19.00 uur' })))
  })

  it('ignores a barcode or order reference in the subject', () => {
    expect(kindOf(mail({ subject: 'Je pakket (JVGL0637312004384176)' })))
      .toBe(kindOf(mail({ subject: 'Je pakket (JVGL0627463317265600)' })))
  })

  it('keeps genuinely different mail apart', () => {
    expect(kindOf(mail({ subject: 'Je pakket is nu bij PostNL' })))
      .not.toBe(kindOf(mail({ subject: 'Je artikel is geannuleerd' })))
  })

  it('keeps the same wording from different senders apart', () => {
    expect(kindOf(mail({ address: 'a@example.com' })))
      .not.toBe(kindOf(mail({ address: 'b@example.com' })))
  })

  it('ignores a reply or forward prefix', () => {
    expect(kindOf(mail({ subject: 'Re: Je pakket is onderweg' })))
      .toBe(kindOf(mail({ subject: 'Je pakket is onderweg' })))
  })
})

describe('grouping the review queue', () => {
  it('shows one entry for ten copies of the same mail', () => {
    const queue = Array.from({ length: 10 }, (_, index) =>
      mail({ receivedAt: `2026-08-1${index % 10}T09:00:00.000Z` }))

    const groups = groupReviewQueue(queue)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.count).toBe(10)
  })

  it('reports when the first and last of a stack arrived', () => {
    const groups = groupReviewQueue([
      mail({ receivedAt: '2026-08-17T09:00:00.000Z' }),
      mail({ receivedAt: '2026-08-19T09:00:00.000Z' }),
      mail({ receivedAt: '2026-08-18T09:00:00.000Z' }),
    ])

    expect(groups[0]!.firstSeenAt).toBe('2026-08-17T09:00:00.000Z')
    expect(groups[0]!.lastSeenAt).toBe('2026-08-19T09:00:00.000Z')
  })

  it('acts on the most recent of a stack', () => {
    const groups = groupReviewQueue([
      mail({ id: 'old', receivedAt: '2026-08-17T09:00:00.000Z' }),
      mail({ id: 'new', receivedAt: '2026-08-19T09:00:00.000Z' }),
    ])

    expect(groups[0]!.latest.id).toBe('new')
  })

  it('prefers a copy that can actually be exported', () => {
    const groups = groupReviewQueue([
      mail({ id: 'newest-without-copy', receivedAt: '2026-08-19T09:00:00.000Z', exportable: false }),
      mail({ id: 'has-copy', receivedAt: '2026-08-18T09:00:00.000Z', exportable: true }),
    ])

    expect(groups[0]!.latest.id).toBe('has-copy')
  })

  it('puts the biggest stack first, since that is the parser worth writing', () => {
    const groups = groupReviewQueue([
      mail({ subject: 'Eenmalig bericht' }),
      ...Array.from({ length: 4 }, () => mail({ subject: 'Je pakket is onderweg' })),
      ...Array.from({ length: 2 }, () => mail({ subject: 'Je bestelling is bevestigd' })),
    ])

    expect(groups.map((group) => group.count)).toEqual([4, 2, 1])
  })

  it('keeps every message of a stack, so nothing is lost by stacking it', () => {
    const groups = groupReviewQueue([mail(), mail(), mail()])
    expect(groups[0]!.messages).toHaveLength(3)
  })

  it('has nothing to group for an empty queue', () => {
    expect(groupReviewQueue([])).toEqual([])
  })
})
