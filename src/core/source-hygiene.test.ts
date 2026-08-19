import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

/**
 * No control characters in the source.
 *
 * A backspace inside a regular expression looks exactly like a word boundary
 * when read — `/\bdhl\b/` and `/<BS>dhl<BS>/` are indistinguishable on screen —
 * and the second matches nothing. That shipped once: a parser that read every
 * field as null while its code looked perfectly correct, and it took a long
 * time to see. Nothing else catches it, so this does.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Tab, newline and carriage return are how source is written; the rest are not. */
const ALLOWED = new Set([9, 10, 13])

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx|css)$/.test(path) ? [path] : []
  })
}

describe('the source tree', () => {
  it('contains no control characters that would be invisible on screen', () => {
    const offenders: string[] = []

    for (const path of sources(root)) {
      const data = readFileSync(path)
      for (const [index, byte] of data.entries()) {
        if (byte < 32 && !ALLOWED.has(byte)) {
          const line = data.subarray(0, index).toString().split('\n').length
          offenders.push(
            `${relative(root, path)}:${line} contains byte 0x${byte.toString(16).padStart(2, '0')}`,
          )
          break
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('has no stray carriage return in the middle of a line', () => {
    const offenders: string[] = []

    for (const path of sources(root)) {
      const text = readFileSync(path, 'utf8')
      text.split('\n').forEach((line, index) => {
        // A trailing one is a CRLF ending; one anywhere else broke a string
        // literal in two and only failed at compile time by luck.
        if (line.slice(0, -1).includes('\r')) {
          offenders.push(`${relative(root, path)}:${index + 1}`)
        }
      })
    }

    expect(offenders).toEqual([])
  })
})
