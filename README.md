# Resell Ops

A local-first desktop tracker for a reselling operation. It connects to your
mailboxes and turns order confirmations, shipping notices, cancellations and
refund mail into inventory, purchases and shipments — so the books keep
themselves.

Everything stays on your machine. No account, no server, no telemetry.

## What it does

- **Reads your mail over IMAP.** Provider presets for Gmail, Outlook, Yahoo,
  web.de, iCloud and Namecheap Private Email. Mailboxes are opened **read-only**:
  nothing is marked as read, moved or deleted.
- **Extracts what matters** with per-retailer parsers, and cross-checks the
  arithmetic — an order is only accepted as consistent when
  `quantity × unit price + shipping` equals the stated total.
- **Builds inventory per physical unit**, so a three-unit order becomes three
  items, each with its own cost basis, and each sellable and trackable alone.
- **Tracks parcels both ways**, resolving carrier barcodes from retailer
  redirect links where the mail itself doesn't state one.
- **Never guesses.** Where a retailer omits a figure the field stays empty, and
  mail no parser recognises goes to a review queue rather than being dropped.

## Status

Early. Version 0.0.1.

| Area | State |
|---|---|
| Money and VAT arithmetic | Done, tested |
| SQLite storage and migrations | Done |
| IMAP connection and sync | Done |
| bol.com parsers | Done, verified against real mail |
| MediaMarkt / Proshop / PocketGames parsers | Ported, **not yet verified against real mail** |
| Reconciliation into purchases, items, shipments | Done |
| Dashboard, Purchases, Shipments, Review, Settings | Done |
| Inventory, Sales, Reports screens | Not wired up yet |
| AYCD Inbox integration | Client done, not yet wired into the UI |
| Carrier tracking APIs | Not started |

## Running it from source

Requires Node 24.

```bash
npm install
npm start
```

`npm start` builds the main process, preload, and renderer, then launches
Electron.

### Development

```bash
npm test         # vitest
npm run typecheck
npm run dev      # renderer only, with hot reload
```

`better-sqlite3` is a native module. It installs from prebuilt binaries; if you
change Electron versions, run `npx electron-rebuild -f -w better-sqlite3`.

## How it works

Mail is never parsed straight into inventory. The pipeline is deliberately
indirect, and each step exists for a reason:

```
IMAP / .eml  →  messages  →  parsers  →  events  →  reconciler  →  entities
```

- **Messages** are deduplicated by content hash, so the same confirmation
  arriving in two connected mailboxes is stored once.
- **Parsers** emit normalised *events* (`order_placed`, `shipped`, `cancelled`,
  …) and never touch inventory. A parser that throws is recorded and skipped, so
  one retailer changing a template cannot stop everything else from processing.
- **Event identity is deterministic** — derived from the message, the parser and
  the ordinal — so fixing a parser and re-running it corrects history instead of
  duplicating it.
- **The reconciler** applies events to entities, and *holds* what it cannot yet
  apply. A shipping notice that arrives before its order confirmation, or a
  cancellation for an order that was never captured, waits and is applied when
  the missing piece appears.

Money is always an integer count of minor units plus a currency code — never a
float — and every transaction stores the exchange rate that applied at the time.

## Adding a parser for a retailer

Parsers are built against real mail, because retailer templates are not
guessable. Save a `.eml` sample into `fixtures/eml/`, then write a module
exposing `matches()` and `parse()`, and a test that asserts against that
fixture.

`fixtures/eml/` is git-ignored: real mail contains real names, addresses and
order references, and none of it belongs in a repository.

## Releases

Tagging a version builds a Windows installer and publishes it to GitHub
Releases; the application updates itself from that same feed.

```bash
npm version patch      # or minor / major
git push --follow-tags
```

Installers are unsigned, so Windows SmartScreen will warn on first run.

## Licence

MIT
