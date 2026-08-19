import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * Every class a screen asks for must exist in the stylesheet.
 *
 * A rule can disappear silently — an edit that rewrites the tail of the file,
 * a merge that drops a block — and nothing fails: the application still runs,
 * the element simply loses its appearance, and the first anyone knows of it is
 * a screenshot with an unstyled white box in the corner. That happened, so it
 * is checked here.
 */

const renderer = fileURLToPath(new URL('.', import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx$/.test(path) ? [path] : []
  })
}

/** Class names written as plain strings, which are the ones a stylesheet owns. */
function classesUsed(): Map<string, string[]> {
  const used = new Map<string, string[]>()
  for (const file of sources(renderer)) {
    const code = readFileSync(file, 'utf8')
    for (const match of code.matchAll(/className="([^"{}]+)"/g)) {
      for (const name of match[1]!.split(/\s+/).filter(Boolean)) {
        used.set(name, [...(used.get(name) ?? []), file])
      }
    }
  }
  return used
}

const stylesheet = readFileSync(join(renderer, 'theme.css'), 'utf8')

/** Styled by an ancestor's rule rather than by one of their own. */
const STYLED_BY_CONTEXT = new Set(['screen', 'section'])

describe('the stylesheet', () => {
  it('defines every class the screens use', () => {
    const missing = [...classesUsed()]
      .filter(([name]) => !STYLED_BY_CONTEXT.has(name))
      .filter(([name]) => !new RegExp(`\\.${name}\\b`).test(stylesheet))
      .map(([name, files]) => `${name} (used in ${files.length} file(s))`)

    expect(missing).toEqual([])
  })

  it('still styles the chrome that surrounds every screen', () => {
    // These are the pieces that carry no text of their own, so losing their
    // rule leaves a blank box rather than an obvious break.
    for (const name of [
      'titlebar', 'titlebar-search', 'sidebar', 'nav-item', 'account-chip',
      'activity-button', 'activity-panel', 'rail-toggle', 'thumb', 'track-link',
      'settings-grid', 'modal', 'toast', 'ctx-menu', 'table', 'trow', 'thead',
    ]) {
      expect(stylesheet, `.${name} is not styled`).toMatch(new RegExp(`\\.${name}\\b`))
    }
  })
})
