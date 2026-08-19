import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

// The application's own version, baked in. Asking Electron for it at runtime
// answers with Electron's version in development, which made the marker that
// decides "has this build read the mail yet" wrong in exactly the place it is
// most useful.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

const shared = {
  define: { __APP_VERSION__: JSON.stringify(version) },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron', 'better-sqlite3'],
  sourcemap: true,
  logLevel: 'info',
}

await build({ ...shared, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.cjs' })
await build({ ...shared, entryPoints: ['src/preload/index.ts'], outfile: 'dist/main/preload.cjs' })
