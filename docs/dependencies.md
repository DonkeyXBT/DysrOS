# Dependency notes

Findings from `npm install` warnings and `npm audit`, with the reasoning behind
what was and was not acted on. Re-check when upgrading Electron or
electron-builder.

Last reviewed: 2026-08-19, at v0.0.1.

## Deprecation warnings on install

All of these are **transitive and build-time only**. None ship inside the
packaged application, so none affect what runs on a user's machine.

| Package | Comes from | Assessment |
|---|---|---|
| `rimraf@2.6.3` | electron-builder → app-builder-lib | Dev-only. Upstream's to fix. |
| `inflight@1.0.6` | electron-builder → glob | Dev-only. Leaks memory, but only during packaging. |
| `glob@7.2.3` | electron-builder | Dev-only. |
| `boolean@3.2.0` | electron-builder (optional) | Dev-only. |
| `lodash.isequal@4.5.0` | electron-updater | **Runtime**, but tiny and self-contained. Replacing it means patching a dependency; not worth it. |

None are actionable from here — they are resolved by upstream releasing new
versions, not by anything in this repository. Pinning overrides for them would
add risk without removing the warnings' cause.

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
- The GitHub Actions runner warns that `actions/checkout@v4` and
  `actions/setup-node@v4` target Node 20, which is deprecated. They are forced
  onto Node 24 and work; upgrade to `@v5` when it is stable.
