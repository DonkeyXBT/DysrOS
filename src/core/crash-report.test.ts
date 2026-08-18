import { describe, it, expect } from 'vitest'
import { redact, crashSignature, buildCrashReport, issueUrl } from './crash-report.js'
import type { LogEntry } from './log.js'

const context = {
  appVersion: '0.0.3',
  electronVersion: '43.4.0',
  platform: 'win32',
  arch: 'x64',
}

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    at: '2026-08-19T10:00:00.000Z',
    level: 'error',
    source: 'sync',
    message: 'connection reset',
    detail: null,
    ...overrides,
  }
}

describe('redaction', () => {
  it('removes email addresses', () => {
    expect(redact('auth failed for reseller@gmail.com')).toBe('auth failed for <email>')
  })

  it('removes the account name from a Windows path', () => {
    expect(redact('at C:\\Users\\Administrator\\AppData\\app.db'))
      .toBe('at C:\\Users\\<user>\\AppData\\app.db')
  })

  it('removes the account name from a unix home path', () => {
    expect(redact('/home/davey/app/db')).toBe('/home/<user>/app/db')
  })

  it('removes retailer order references', () => {
    expect(redact('failed on order C0008N401L')).toBe('failed on order <order-ref>')
  })

  it('removes carrier tracking codes', () => {
    expect(redact('3SBTC0294817263 lookup failed')).toBe('<tracking> lookup failed')
    expect(redact('JVGL0627463317265600 lookup failed')).toBe('<tracking> lookup failed')
  })

  it('removes a delivery postcode', () => {
    expect(redact('redirect to 1012 AB')).toBe('redirect to <postcode>')
  })

  it('leaves an ordinary technical message intact', () => {
    const message = 'SqliteError: database is locked'
    expect(redact(message)).toBe(message)
  })
})

describe('crash signatures', () => {
  it('is identical for the same fault reported twice', () => {
    expect(crashSignature(entry())).toBe(crashSignature(entry({ at: '2026-09-01T00:00:00Z' })))
  })

  it('ignores varying numbers, so one bug is one signature', () => {
    const first = entry({ message: 'timed out after 30000ms on uid 4821' })
    const second = entry({ message: 'timed out after 45000ms on uid 9930' })
    expect(crashSignature(first)).toBe(crashSignature(second))
  })

  it('ignores personal detail that differs between users', () => {
    const mine = entry({ message: 'auth failed for a@example.com' })
    const yours = entry({ message: 'auth failed for b@example.org' })
    expect(crashSignature(mine)).toBe(crashSignature(yours))
  })

  it('separates genuinely different faults', () => {
    expect(crashSignature(entry({ message: 'connection reset' })))
      .not.toBe(crashSignature(entry({ message: 'database is locked' })))
  })

  it('separates the same message from different sources', () => {
    expect(crashSignature(entry({ source: 'sync' })))
      .not.toBe(crashSignature(entry({ source: 'renderer' })))
  })
})

describe('report contents', () => {
  it('never carries an address through to the report', () => {
    const report = buildCrashReport(
      entry({
        message: 'AUTHENTICATIONFAILED for reseller@gmail.com',
        detail: 'at ImapFlow (C:\\Users\\Administrator\\app\\index.js:12)',
      }),
      context,
    )
    expect(report.body).not.toContain('reseller@gmail.com')
    expect(report.body).not.toContain('Administrator')
    expect(report.title).not.toContain('reseller@gmail.com')
  })

  it('includes the environment needed to reproduce it', () => {
    const report = buildCrashReport(entry(), context)
    expect(report.body).toContain('0.0.3')
    expect(report.body).toContain('43.4.0')
    expect(report.body).toContain('win32 x64')
  })

  it('includes the entries leading up to the failure', () => {
    const earlier = entry({ at: '2026-08-19T09:59:00.000Z', message: 'opening INBOX' })
    const report = buildCrashReport(entry(), context, [earlier, entry()])
    expect(report.body).toContain('opening INBOX')
  })

  it('redacts the lead-up entries too', () => {
    const earlier = entry({ at: '2026-08-19T09:59:00.000Z', message: 'syncing me@example.com' })
    const report = buildCrashReport(entry(), context, [earlier, entry()])
    expect(report.body).not.toContain('me@example.com')
  })

  it('keeps the title short enough for GitHub to show whole', () => {
    const report = buildCrashReport(entry({ message: 'x'.repeat(400) }), context)
    expect(report.title.length).toBeLessThanOrEqual(130)
  })

  it('truncates a runaway stack rather than producing an unusable issue', () => {
    const report = buildCrashReport(entry({ detail: 'y'.repeat(20_000) }), context)
    expect(report.body.length).toBeLessThan(9000)
  })
})

/** URLSearchParams encodes a space as '+', which decodeURIComponent leaves
 *  alone. GitHub reads it back as a space; this mirrors that. */
function readQuery(url: string): string {
  return decodeURIComponent(url.replace(/\+/g, ' '))
}

describe('issue url', () => {
  it('targets the repository and prefills the form', () => {
    const url = issueUrl('DonkeyXBT/DysrOS', buildCrashReport(entry(), context))
    expect(url.startsWith('https://github.com/DonkeyXBT/DysrOS/issues/new?')).toBe(true)
    expect(url).toContain('labels=crash')
    expect(readQuery(url)).toContain('connection reset')
  })

  it('escapes content so it cannot break out of the query string', () => {
    const url = issueUrl('DonkeyXBT/DysrOS', buildCrashReport(entry({ message: 'a&b=c #1' }), context))
    expect(url.split('?')[1]!.split('&').length).toBeGreaterThan(2)
    expect(readQuery(url)).toContain('a&b=c #1')
  })
})
