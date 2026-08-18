import { simpleParser } from 'mailparser'

/**
 * A decoded email, reduced to the fields parsers actually match and extract on.
 * Deliberately small: parsers should key off sender and subject shape rather
 * than reaching into MIME structure.
 */
export interface ParsedMessage {
  messageId: string | null
  fromAddress: string
  fromName: string | null
  subject: string
  receivedAt: string
  text: string
  html: string
}

export async function loadEml(raw: string | Buffer): Promise<ParsedMessage> {
  const mail = await simpleParser(raw)
  const sender = mail.from?.value?.[0]

  return {
    messageId: mail.messageId ?? null,
    fromAddress: (sender?.address ?? '').toLowerCase(),
    fromName: sender?.name ? sender.name : null,
    subject: mail.subject ?? '',
    receivedAt: (mail.date ?? new Date(0)).toISOString(),
    text: mail.text ?? '',
    html: typeof mail.html === 'string' ? mail.html : '',
  }
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&euro;': '€',
  '&pound;': '£',
}

function decodeEntities(input: string): string {
  let output = input
  for (const [entity, char] of Object.entries(ENTITIES)) {
    output = output.split(entity).join(char)
  }
  return output
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
}

export interface TextOptions {
  /**
   * Derive the text from the HTML part even when a plain-text part exists.
   *
   * Auto-generated plain-text parts are hard-wrapped at about 76 characters,
   * which splits long product titles mid-phrase, and they render images as
   * `[https://…]` lines that sit exactly where content is expected. The HTML
   * carries real element boundaries, so for senders whose mail is authored as
   * HTML it is the more faithful source.
   */
  preferHtml?: boolean
}

/**
 * The text a parser should run its patterns against: the plain part when the
 * sender provided one, otherwise the HTML reduced to text.
 *
 * Whitespace is normalised — including the non-breaking spaces retailers put
 * between a currency symbol and its amount — so a parser can use an ordinary
 * `\s` in its patterns and still match.
 */
export function textOf(message: ParsedMessage, options: TextOptions = {}): string {
  const useHtml = (options.preferHtml && message.html.trim().length > 0)
    || message.text.trim().length === 0
  const source = useHtml ? htmlToText(message.html) : message.text
  return source
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
}

function htmlToText(html: string): string {
  const withoutInvisible = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  const withBreaks = withoutInvisible
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
  return decodeEntities(withBreaks.replace(/<[^>]+>/g, ''))
}
