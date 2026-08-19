import type { ReviewView } from '../api.js'

/**
 * The review queue, stacked by the kind of mail rather than the count of it.
 *
 * A retailer sends the same template over and over — ten parcels means ten
 * identical "the courier is on the way" mails — and until a parser is written
 * for it, every one of them lands here. Listing them individually turns a
 * queue of one problem into a wall of ten, and the tenth copy tells you
 * nothing the first did not.
 *
 * So each kind appears once, with how many arrived and when. Nothing is
 * hidden: the count is the whole stack, and exporting still exports a real
 * message from it.
 */

export interface ReviewGroup {
  /** The most recent message of this kind, which is the one acted on. */
  latest: ReviewView
  /** Every message of this kind, newest first. */
  messages: ReviewView[]
  count: number
  firstSeenAt: string
  lastSeenAt: string
}

/**
 * What makes two mails the same kind.
 *
 * The sender plus the shape of the subject: numbers vary from parcel to parcel
 * — times, barcodes, order references — while the wording around them is the
 * template. Matching on the shape stacks "at the door between 12.20-16.20" with
 * "at the door between 17.00-19.00", and still keeps genuinely different mail
 * apart.
 */
export function kindOf(message: ReviewView): string {
  const subject = message.subject
    .toLowerCase()
    .replace(/^\s*(re|fwd?|antw)\s*:\s*/i, '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
  return `${message.address.toLowerCase()}|${subject}`
}

export function groupReviewQueue(messages: ReviewView[]): ReviewGroup[] {
  const groups = new Map<string, ReviewView[]>()

  for (const message of messages) {
    const key = kindOf(message)
    groups.set(key, [...(groups.get(key) ?? []), message])
  }

  return [...groups.values()]
    .map((all) => {
      const sorted = [...all].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      return {
        // Prefer one that can actually be exported: a stored copy is the point
        // of the queue, and only some of a stack may still have one.
        latest: sorted.find((message) => message.exportable) ?? sorted[0]!,
        messages: sorted,
        count: sorted.length,
        firstSeenAt: sorted[sorted.length - 1]!.receivedAt,
        lastSeenAt: sorted[0]!.receivedAt,
      }
    })
    // The biggest stack first: that is the parser worth writing next.
    .sort((a, b) => b.count - a.count || b.lastSeenAt.localeCompare(a.lastSeenAt))
}
