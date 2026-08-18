import { createHash } from 'node:crypto'
import type { LogEntry } from './log.js'

/**
 * Turns a failure into something safe to publish.
 *
 * The repository is public, and a raw crash report is full of things that
 * should not be: the mailbox addresses being synced, retailer order references,
 * and Windows paths carrying the account name. Everything here is redacted
 * before it can leave the machine, and the report is only ever *offered* — it
 * is never posted without someone choosing to.
 */

export interface CrashReport {
  /** Stable across repeats of the same fault, so one bug is one issue. */
  signature: string
  title: string
  body: string
  occurredAt: string
}

export interface ReportContext {
  appVersion: string
  electronVersion: string
  platform: string
  arch: string
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const WINDOWS_USER_PATH = /([A-Za-z]:\\Users\\)[^\\\s"']+/g
const UNIX_HOME = /(\/(?:home|Users)\/)[^/\s"']+/g
/** bol.com-style order references and carrier barcodes. */
const ORDER_REFERENCE = /\bC[0-9A-Z]{9}\b/g
const TRACKING_CODE = /\b(?:3[SZ][A-Z0-9]{9,24}|JVGL\d{10,24}|JJD[A-Z0-9]{8,24})\b/g
const DUTCH_POSTCODE = /\b\d{4}\s?[A-Z]{2}\b/g

export function redact(text: string): string {
  return text
    .replace(EMAIL, '<email>')
    .replace(WINDOWS_USER_PATH, '$1<user>')
    .replace(UNIX_HOME, '$1<user>')
    .replace(ORDER_REFERENCE, '<order-ref>')
    .replace(TRACKING_CODE, '<tracking>')
    .replace(DUTCH_POSTCODE, '<postcode>')
}

/**
 * A fingerprint for the fault itself, not for this occurrence of it.
 *
 * Built from the source and the message with digits stripped, so the same bug
 * reported twice — with different ids, counts or timestamps in the text —
 * collapses to one signature instead of opening a second issue.
 */
export function crashSignature(entry: LogEntry): string {
  const normalised = redact(entry.message)
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return createHash('sha256').update(`${entry.source}|${normalised}`).digest('hex').slice(0, 16)
}

export function buildCrashReport(
  entry: LogEntry,
  context: ReportContext,
  recent: LogEntry[] = [],
): CrashReport {
  const message = redact(entry.message)
  const detail = entry.detail ? redact(entry.detail) : null

  // The few entries before the failure are usually what explains it.
  const leadUp = recent
    .filter((e) => e.at <= entry.at && e !== entry)
    .slice(0, 8)
    .map((e) => `${e.at}  [${e.level}] ${e.source}: ${redact(e.message)}`)

  const body = [
    '### What happened',
    '',
    '_Automatically prepared from a crash. Add anything you were doing at the time._',
    '',
    '### Error',
    '',
    '```',
    `${entry.source}: ${message}`,
    '```',
    '',
    ...(detail ? ['### Stack', '', '```', detail.slice(0, 6000), '```', ''] : []),
    ...(leadUp.length > 0 ? ['### Leading up to it', '', '```', ...leadUp, '```', ''] : []),
    '### Environment',
    '',
    `| | |`,
    `|---|---|`,
    `| App | ${context.appVersion} |`,
    `| Electron | ${context.electronVersion} |`,
    `| Platform | ${context.platform} ${context.arch} |`,
    `| Occurred | ${entry.at} |`,
    `| Signature | \`${crashSignature(entry)}\` |`,
    '',
    '_Email addresses, order references, tracking codes, postcodes and user paths',
    'were removed before this report was prepared._',
  ].join('\n')

  return {
    signature: crashSignature(entry),
    title: `[crash] ${entry.source}: ${message.slice(0, 110)}`,
    body,
    occurredAt: entry.at,
  }
}

/**
 * A prefilled "new issue" URL.
 *
 * Deliberately not an API call: posting automatically would need a GitHub token
 * shipped inside the installer, which anyone who downloads it could extract and
 * use against the repository. A prefilled form costs one click and needs no
 * credential at all.
 */
export function issueUrl(repo: string, report: CrashReport): string {
  const params = new URLSearchParams({
    title: report.title,
    body: report.body,
    labels: 'crash',
  })
  return `https://github.com/${repo}/issues/new?${params.toString()}`
}
