import { describe, it, expect, beforeEach } from 'vitest'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { AppService } from './service.js'

/**
 * Every supplied mail is read by a parser.
 *
 * Each of these files was sent because its mail carries something the
 * application has to know: an order, a cancellation, a barcode, a sale. A
 * parser that stops matching one of them is the failure that is hardest to
 * notice — nothing breaks, the mail simply lands in the review queue and the
 * inventory quietly stops being right. This is the check that says so out
 * loud, and it covers the folder rather than a list, so a file added later is
 * covered the moment it arrives.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures')

function fixtures(folder: string, extension: string): string[] {
  return readdirSync(join(root, folder))
    .filter((name) => name.toLowerCase().endsWith(extension))
    .map((name) => join(folder, name))
}

const ALL = [...fixtures('eml', '.eml'), ...fixtures('html', '.html')]

let service: AppService

beforeEach(() => {
  service = new AppService(':memory:', {
    encrypt: (p) => 'enc:' + Buffer.from(p, 'utf8').toString('base64'),
    decrypt: (c) => Buffer.from(c.slice(4), 'base64').toString('utf8'),
  })
})

describe('the supplied mail', () => {
  it.each(ALL)('%s is recognised and yields at least one event', async (relative) => {
    const result = await service.importEml(join(root, relative))

    expect(result.parserId, `${relative} was not recognised by any parser`).not.toBeNull()
    expect(result.events, `${relative} was recognised but produced nothing`).toBeGreaterThan(0)
  })

  it('leaves nothing in the review queue', async () => {
    for (const relative of ALL) await service.importEml(join(root, relative))

    expect(service.listReviewQueue().map((entry) => entry.subject)).toEqual([])
  })

  it('reads every one of them without a parser throwing', async () => {
    for (const relative of ALL) await service.importEml(join(root, relative))

    expect(service.parserFailures()).toEqual([])
  })
})
