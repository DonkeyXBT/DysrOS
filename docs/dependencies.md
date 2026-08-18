# Dependency notes

Findings from `npm install` warnings and `npm audit`, with the reasoning behind
what was and was not acted on. Re-check when upgrading Electron or
electron-builder.

Last reviewed: 2026-08-19, at v0.0.2.

## Deprecation warnings on install

Every deprecated package below is **transitive**, and all but one are
**build-time only** — they run while packaging and never ship inside the
application.

Four of the five were eliminated with npm `overrides` in `package.json`. A
clean `npm install` now prints one warning instead of five.

| Package | Reached through | Status |
|---|---|---|
| `rimraf@2.6.3` | electron-builder-squirrel-windows → electron-winstaller → temp | **Gone** — overridden to `^6.1.3`. See the caveat below. |
| `glob@7.2.3` | app-builder-lib → @electron/asar@3.4.1 (and rimraf@2) | **Gone** — falls out of the `@electron/asar` override. |
| `inflight@1.0.6` | glob@7 | **Gone** — glob@9+ dropped it. |
| `boolean@3.2.0` | app-builder-lib → @electron/get@3 → global-agent@3 | **Gone** — overridden to `global-agent@^4.1.3`, which dropped `boolean` and `roarr`. |
| `lodash.isequal@4.5.0` | electron-updater | **Remains.** *Runtime*, not build-time, but tiny and self-contained. Replacing it means patching a dependency; not worth it. |

### The overrides

```json
"overrides": {
  "@electron/asar": "^4.3.0",
  "global-agent": "^4.1.3",
  "rimraf": "^6.1.3"
}
```

Upgrading electron-builder does not help. `26.15.7` — the newest v26, though
npm resolves `^26.15.3` to `26.15.3` because that is what the `latest` tag
points at — still pins `@electron/asar 3.4.1`, `@electron/universal 2.0.3` and
`@electron/get ^3`, so the same warnings appear. `27.0.0-alpha` does fix the
asar and global-agent chains (it moved to `@electron/asar 4.1.1` and
`@electron/get ^5`), which is where the first two overrides are heading anyway;
it is alpha, so we are not putting releases on it.

`@electron/asar@4` is a major bump used by the code that writes `app.asar`, so
it was verified end to end, not assumed: `npm run dist` produced the NSIS
installer, the resulting `app.asar` listed 1390 entries and extracted cleanly,
and `release/win-unpacked/Resell Ops.exe` launched and held a window open.

`global-agent@4` is the safe one. It is an *optional* dependency of
`@electron/get`, only loaded when `ELECTRON_GET_USE_PROXY` is set, and
`initializeProxy()` wraps the `require` in a try/catch — worst case is a debug
line and no proxy support. v4 is still CommonJS and still exports `bootstrap`.

### The rimraf caveat, and the test that guards it

`rimraf@2.6.3` is not fixable by upgrading anything. Its only consumer is
`temp@0.9.4` — the newest release — which still depends on `rimraf@~2.6.2`, and
`temp` arrives through `electron-builder-squirrel-windows`, a **required** peer
dependency of app-builder-lib, so it cannot be dropped from the tree either.

The override therefore hands `temp` a rimraf it was not written against. rimraf
v4 removed the callback API and the module is no longer callable:

```
$ node -e "const r = require('rimraf'); r('x', {}, () => {})"
TypeError: r is not a function     # temp.js:222, inside temp.cleanup()
```

`rimraf.sync` does still exist, and that is the path `temp` actually uses here.
Verified against the real electron-winstaller code: `createTempDir()` works, and
the `temp.track()` exit handler removed the tracked directory through
`rimraf.sync`. Only the async `temp.cleanup()` breaks, and nothing in this tree
calls it.

Nothing reaches that code at all today: app-builder-lib only `require`s
electron-builder-squirrel-windows when a **Squirrel.Windows** target is built,
and we build NSIS. That is a property of the build config rather than a
guarantee, so `src/packaging-config.test.ts` fails if a `squirrel` target is
ever added while the `rimraf` override is present. Drop the override at that
point — one deprecation warning is cheaper than a packaging bug.

### Verification

Run after touching any of this — a clean install proves nothing on its own:

```
rm -rf node_modules package-lock.json && npm install
npx tsc --noEmit
npm test
npm run smoke
npm run dist
```

## Audit: deepmerge-ts stack exhaustion

`npm audit` reports three high-severity entries, all the same root cause:

```
mailparser → html-to-text → deepmerge-ts
```

The advisory is a stack exhaustion when merging deeply recursive object graphs.

**Not reachable in this application.** `html-to-text` uses `deepmerge-ts` in
exactly two places, and neither touches email content:

- merging `defaultOptions` with `userOptions` (a static object literal here)
- de-duplicating selector configuration

Email HTML is parsed by `htmlparser2`/`selderee`, not merged. Since the merged
values are configuration rather than message content, nothing an attacker
controls reaches the vulnerable code.

The fix would be `deepmerge-ts@8`, but `html-to-text@10` depends on `^7`.
Forcing an override across a major version risks breaking HTML-to-text
conversion — which *is* on the path that handles untrusted mail — in exchange
for no real reduction in exposure.

**Decision:** leave it. Re-check when `html-to-text` widens its range.

## Things worth watching

- `better-sqlite3` is native and must match the Electron ABI. electron-builder
  rebuilds it during packaging; locally use
  `npx electron-rebuild -f -w better-sqlite3` after changing Electron versions.
- When electron-builder 27 leaves alpha, re-check the overrides: it already
  ships `@electron/asar 4` and `@electron/get 5`, so the first two become
  redundant. `rimraf` will not, unless `temp` finally moves off rimraf v2.
- The GitHub Actions runner warns that `actions/checkout@v4` and
  `actions/setup-node@v4` target Node 20, which is deprecated. They are forced
  onto Node 24 and work; upgrade to `@v5` when it is stable.
