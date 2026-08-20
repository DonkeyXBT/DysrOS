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
  /**
   * The address the mail was actually sent to.
   *
   * Not the mailbox it landed in: aliases and forwards mean one mailbox
   * collects mail addressed to many, and which alias was used is often the
   * useful fact — it is how one account's orders are told from another's.
   */
  toAddress: string | null
  /** Files carried by the mail — a shipping label, most usefully. Described
   *  rather than held: the bytes stay in the stored copy until asked for. */
  attachments: { filename: string | null; contentType: string; size: number }[]
}

/**
 * A body saved straight out of a mail client: HTML, and no envelope at all.
 *
 * Leading comments and whitespace are skipped because that is how these files
 * really start — DHL's begins with a comment banner before the doctype. An
 * actual `.eml` begins with headers, never with markup, so there is nothing
 * for this to mistake.
 */
const BARE_HTML = /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html[\s>])/i

export async function loadEml(raw: string | Buffer): Promise<ParsedMessage> {
  const mail = await simpleParser(raw)
  const sender = mail.from?.value?.[0]

  const source = typeof raw === 'string' ? raw : raw.toString('utf8')
  // Without headers there is no MIME structure to find a body in, so the file
  // is read as plain text — which leaves every parser that matches on the
  // mail's markup with nothing to match. The file *is* the body.
  const html = typeof mail.html === 'string'
    ? mail.html
    : BARE_HTML.test(source.slice(0, 4096)) ? source : ''

  return {
    messageId: mail.messageId ?? null,
    fromAddress: (sender?.address ?? '').toLowerCase(),
    fromName: sender?.name ? sender.name : null,
    subject: mail.subject ?? '',
    receivedAt: (mail.date ?? new Date(0)).toISOString(),
    text: mail.text ?? '',
    html,
    toAddress: recipientOf(mail),
    attachments: (mail.attachments ?? []).map((file) => ({
      filename: file.filename ?? null,
      contentType: file.contentType ?? 'application/octet-stream',
      size: file.size ?? 0,
    })),
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

/**
 * Who the mail was addressed to.
 *
 * A forwarded mail keeps its original recipient in `Delivered-To` or
 * `X-Original-To` while `To` may name the alias; either is closer to the truth
 * than the mailbox that collected it. The first that names an address wins.
 */
function recipientOf(mail: {
  to?: unknown
  headers?: Map<string, unknown>
}): string | null {
  const headers = mail.headers
  for (const name of ['delivered-to', 'x-original-to', 'x-forwarded-to']) {
    const value = headers?.get(name)
    const address = typeof value === 'string'
      ? value
      : Array.isArray(value) ? String(value[0] ?? '') : null
    const found = address ? /[\w.+-]+@[\w.-]+\.\w+/.exec(address)?.[0] : null
    if (found) return found.toLowerCase()
  }

  const to = mail.to as { value?: { address?: string }[] } | undefined
  const first = to?.value?.find((entry) => entry.address)?.address
  return first ? first.toLowerCase() : null
}
