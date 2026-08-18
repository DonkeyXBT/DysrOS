import { build } from 'esbuild'

const shared = {
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
