import { describe, it, expect } from 'vitest'
import { loadEml, textOf } from './parsed-message.js'

const MULTIPART_EML = [
  'From: "bol.com" <noreply@bol.com>',
  'To: reseller@example.com',
  'Subject: Bedankt voor je bestelling',
  'Message-ID: <abc123@bol.com>',
  'Date: Tue, 18 Aug 2026 09:55:00 +0200',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="BOUND"',
  '',
  '--BOUND',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Bestelnummer 1234567890',
  '',
  '--BOUND',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><p>Bestelnummer&nbsp;1234567890</p>',
  '<p>Totaal: &euro; 219,99</p></body></html>',
  '',
  '--BOUND--',
  '',
].join('\r\n')

const ENCODED_SUBJECT_EML = [
  'From: bol.com <noreply@bol.com>',
  'Subject: =?utf-8?Q?Je_artikel_is_geannuleerd?=',
  'Date: Tue, 18 Aug 2026 10:30:00 +0200',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Prijs: =E2=82=AC 219,99',
  '',
].join('\r\n')

describe('loadEml', () => {
  it('extracts the headers a parser matches on', async () => {
    const message = await loadEml(MULTIPART_EML)
    expect(message.fromAddress).toBe('noreply@bol.com')
    expect(message.fromName).toBe('bol.com')
    expect(message.subject).toBe('Bedankt voor je bestelling')
    expect(message.messageId).toBe('<abc123@bol.com>')
    expect(message.receivedAt).toBe('2026-08-18T07:55:00.000Z')
  })

  it('keeps both the plain text and the HTML part', async () => {
    const message = await loadEml(MULTIPART_EML)
    expect(message.text).toContain('Bestelnummer 1234567890')
    expect(message.html).toContain('<p>Totaal')
  })

  it('decodes an encoded-word subject', async () => {
    const message = await loadEml(ENCODED_SUBJECT_EML)
    expect(message.subject).toBe('Je artikel is geannuleerd')
  })

  it('decodes quoted-printable body content', async () => {
    const message = await loadEml(ENCODED_SUBJECT_EML)
    expect(message.text).toContain('€ 219,99')
  })

  it('accepts a Buffer as well as a string', async () => {
    const message = await loadEml(Buffer.from(MULTIPART_EML, 'utf8'))
    expect(message.subject).toBe('Bedankt voor je bestelling')
  })
})

describe('textOf', () => {
  it('prefers the plain text part', async () => {
    const message = await loadEml(MULTIPART_EML)
    expect(textOf(message)).toContain('Bestelnummer 1234567890')
  })

  it('falls back to HTML stripped of tags, with entities decoded', async () => {
    const message = await loadEml(MULTIPART_EML)
    const htmlOnly = { ...message, text: '' }
    const text = textOf(htmlOnly)
    expect(text).toContain('Bestelnummer 1234567890')
    expect(text).toContain('Totaal: € 219,99')
    expect(text).not.toContain('<p>')
  })

  it('collapses a non-breaking space so amounts match a plain regex', async () => {
    const message = await loadEml(MULTIPART_EML)
    const text = textOf({ ...message, text: '' })
    expect(/Bestelnummer 1234567890/.test(text)).toBe(true)
  })
})
