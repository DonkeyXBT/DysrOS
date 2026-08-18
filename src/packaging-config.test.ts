import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as {
  overrides?: Record<string, string>
  build?: { win?: { target?: Array<{ target?: string } | string> } }
}

/**
 * The `rimraf` override in package.json removes a deprecated transitive
 * dependency, but it also hands `temp` an incompatible rimraf: v4 dropped the
 * callback API, so `require('rimraf')` is an object rather than a function and
 * `temp.cleanup()` throws.
 *
 * The only thing in the tree that uses `temp` is electron-winstaller, which is
 * only loaded for the Squirrel.Windows target. We build NSIS, so nothing
 * reaches it — but that is a property of the build config, not a guarantee.
 * If someone adds a Squirrel target, this test says so before packaging does.
 *
 * See docs/dependencies.md.
 */
describe('packaging config', () => {
  it('does not build Squirrel.Windows while the rimraf override is in place', () => {
    if (!pkg.overrides?.rimraf) return

    const targets = (pkg.build?.win?.target ?? []).map((t) =>
      typeof t === 'string' ? t : t.target,
    )

    expect(targets).not.toContain('squirrel')
  })
})
