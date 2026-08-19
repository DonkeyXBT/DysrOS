import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A local copy of the article photographs carried in retailer mail.
 *
 * The mail names a picture rather than embedding it, so the picture has to be
 * fetched once. It is then kept on disk: the tool is meant to work with the
 * network unplugged, and re-fetching on every render would tell the retailer
 * each time the user looks at their own inventory.
 *
 * Only pictures the parsers extracted are ever fetched, and only over https
 * from hosts known to serve article photographs — a URL out of a mail is
 * attacker-supplied text, and this is the one place the app acts on one.
 */

const ALLOWED_HOSTS = ['media.s-bol.com']

/** Two megabytes is far above a thumbnail and far below a problem. */
export const MAX_BYTES = 2 * 1024 * 1024

const TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export function isAllowed(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && ALLOWED_HOSTS.includes(parsed.hostname)
  } catch {
    return false
  }
}

/** The file a given picture is cached as, named by its URL rather than by
 *  anything the mail chose, so two mails naming the same picture share one. */
export function cacheName(url: string, extension: string): string {
  return `${createHash('sha256').update(url).digest('hex').slice(0, 32)}.${extension}`
}

export class ImageCache {
  /** URLs already tried and failed, so a broken link is not re-fetched on
   *  every repaint of the table it appears in. */
  private readonly failed = new Set<string>()
  private readonly inFlight = new Map<string, Promise<string | null>>()

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  /**
   * The picture as a data URL, fetching it once if it is not yet on disk.
   * Null when the URL is not one we fetch, or the fetch did not produce an
   * image — a missing picture is a blank tile, never an error the user sees.
   */
  async get(url: string): Promise<string | null> {
    if (!isAllowed(url) || this.failed.has(url)) return null

    const onDisk = this.find(url)
    if (onDisk) return onDisk

    const existing = this.inFlight.get(url)
    if (existing) return existing

    const attempt = this.fetch(url).finally(() => this.inFlight.delete(url))
    this.inFlight.set(url, attempt)
    return attempt
  }

  private find(url: string): string | null {
    for (const [type, extension] of Object.entries(TYPES)) {
      const path = join(this.dir, cacheName(url, extension))
      if (existsSync(path)) {
        return `data:${type};base64,${readFileSync(path).toString('base64')}`
      }
    }
    return null
  }

  private async fetch(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      })
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      const extension = TYPES[type]
      if (!response.ok || !extension) {
        this.failed.add(url)
        return null
      }

      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
        this.failed.add(url)
        return null
      }

      writeFileSync(join(this.dir, cacheName(url, extension)), bytes)
      return `data:${type};base64,${bytes.toString('base64')}`
    } catch {
      this.failed.add(url)
      return null
    }
  }
}
