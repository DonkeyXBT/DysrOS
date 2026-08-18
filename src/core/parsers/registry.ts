import type { ParsedMessage } from '../mail/parsed-message.js'
import type { ParsedEvent } from '../repos/events.js'

export interface Parser {
  /** Stable identifier. Event identity is derived from it, so never rename one
   *  in place without accepting that its events will be re-created. */
  id: string
  retailer: string
  matches(message: ParsedMessage): boolean
  parse(message: ParsedMessage): ParsedEvent[]
}

export interface ParseResult {
  parserId: string
  retailer: string
  events: ParsedEvent[]
}

export interface ParserFailure {
  parserId: string
  subject: string
  error: string
}

export class ParserRegistry {
  readonly failures: ParserFailure[] = []

  constructor(private readonly parsers: readonly Parser[]) {}

  /**
   * Returns the result of the first parser that claims the message, or null if
   * none does. A parser that claims a message but extracts no events still
   * counts as a match — some mail is genuinely informational.
   *
   * A parser that throws is recorded and skipped rather than allowed to stop
   * ingestion: one retailer changing its template must not block every other
   * email from being processed.
   */
  parse(message: ParsedMessage): ParseResult | null {
    for (const parser of this.parsers) {
      let claimed = false
      try {
        claimed = parser.matches(message)
        if (!claimed) continue
        return { parserId: parser.id, retailer: parser.retailer, events: parser.parse(message) }
      } catch (error) {
        this.failures.push({
          parserId: parser.id,
          subject: message.subject,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return null
  }

  describe(): { id: string; retailer: string }[] {
    return this.parsers.map((parser) => ({ id: parser.id, retailer: parser.retailer }))
  }
}
