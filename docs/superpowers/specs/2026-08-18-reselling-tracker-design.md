# Reselling Operations Tracker — Design

Date: 2026-08-18
Status: Approved

## Purpose

A local-first desktop application that tracks a reselling operation end to end.
The user connects email accounts; the application reads mail relating to
purchases, cancellations, refunds, sales, payouts and shipping, converts that
mail into structured records, and maintains an inventory of individual items
with accurate cost basis, VAT and profit.

The operation spans three verticals — sneakers and streetwear, general
marketplace flipping, and tickets and collectibles — so parsing must be
extensible per retailer rather than hardcoded to one vertical.

## Principles

1. **Local first.** No email content leaves the machine. There is no LLM in the
   ingestion path. The only outbound network calls are carrier tracking lookups
   and Discord notifications, both user-configured.
2. **Emails produce events; events reconcile into entities.** A parser never
   writes inventory directly.
3. **Replay is a first-class operation.** Raw mail is retained so a corrected
   parser can heal historical data.
4. **Money is never a float.** Integer minor units plus an ISO currency code.

## Architecture

The application is an Electron shell around a headless core.

- **Core** (`src/core`) — SQLite storage, IMAP ingestion, parser registry,
  reconciler, carrier tracking, notification dispatch. Pure TypeScript with no
  Electron imports, so the entire pipeline runs and is tested headlessly.
- **Main process** (`src/main`) — owns the core, schedules polling, exposes a
  typed IPC surface.
- **Preload** (`src/preload`) — context-isolated bridge exposing only the typed
  IPC surface to the renderer.
- **Renderer** (`src/renderer`) — React UI. Never touches mail, disk or the
  database directly.

Credentials are encrypted with Electron `safeStorage` (DPAPI-backed on
Windows). Raw `.eml` files are retained under the application data directory.

## Data Model

Amounts are stored as `*_minor` integers with a sibling `currency` column. Each
monetary transaction stores `fx_rate_to_base` captured at transaction time, so
original-currency figures are preserved while reporting rolls up into the
configured base currency.

| Table | Purpose |
|---|---|
| `accounts` | IMAP connection, provider preset, encrypted secret, per-folder cursor |
| `folder_cursors` | `UIDVALIDITY` and last-seen UID per account folder |
| `messages` | One row per fetched email: raw path, content hash, parse status, claiming parser |
| `events` | Normalized facts extracted from messages, with source message for audit |
| `purchases` | Buy side: retailer, external order id, totals, VAT, fx rate |
| `purchase_lines` | Line items on a purchase; each line yields one or more items |
| `items` | One row per physical unit: title, brand, size, condition, status, location, cost basis |
| `sales` | Sell side: marketplace, gross, fees, shipping, payout, VAT; linked to one item |
| `shipments` | Carrier, tracking number, direction, status, last polled |
| `refunds` | Amount and receipt date, linked to a purchase |
| `settings` | Base currency, VAT rate and country, Discord webhook, tracking credentials |
| `notification_rules` | Event type to channel mapping, enabled flag, template |

### Item lifecycle

`incoming` → `in_stock` → `listed` → `sold` → `shipped_to_buyer` → `delivered`

with `cancelled` and `returned` as reversing states. Cancellation reverses an
item rather than deleting it, preserving the audit trail.

## Email Ingestion

One poller per account. IMAP IDLE where the server advertises it, otherwise a
timed poll. The cursor is `UIDVALIDITY` plus last-seen UID per folder, so a
restart never re-reads a mailbox and a renumbering never silently skips mail.

Provider presets ship for Gmail, Outlook, Yahoo, web.de, iCloud and Namecheap
Private Email. Gmail and Yahoo require an app-specific password rather than the
account password.

Every fetched message is written to disk as `.eml`, hashed, and deduplicated, so
an order confirmation delivered to two connected accounts produces one message
row.

## Parsers

A parser is a module exposing:

```ts
interface Parser {
  id: string
  retailer: string
  matches(message: ParsedMessage): boolean
  parse(message: ParsedMessage): ParsedEvent[]
}
```

The registry tries matchers in registration order; first claim wins. Matching
keys off sender domain and subject shape rather than fragile HTML structure.

Each parser is built against a real `.eml` sample supplied by the user, and that
sample becomes the parser's test fixture. No parser ships without a test proving
it extracts the correct fields from real mail.

Messages that no parser claims are marked `unrecognized` and surface in a review
queue where the user can record the facts manually or supply the `.eml` so a
parser can be written.

## Events and Reconciliation

Event types: `order_placed`, `order_confirmed`, `shipped`, `delivered`,
`cancelled`, `refunded`, `sale`, `payout`, `listing`.

Event identity is derived deterministically from
`hash(message_id + parser_id + ordinal)`, so re-running a corrected parser over
retained mail upserts corrected events rather than duplicating inventory.

The reconciler matches events onto entities by `(retailer, external_order_id)`
and applies transitions. Mail arrives out of order and duplicated: a shipping
notice preceding its order confirmation is parked as an orphan event and
re-reconciled automatically when the matching order arrives.

## VAT

Purchases and sales each carry a VAT rate in basis points, a VAT amount in minor
units, and an inclusive/exclusive flag. VAT returns are computed on demand
rather than stored: input VAT from purchases less output VAT from sales, grouped
by quarter, exportable as CSV. The margin scheme for second-hand goods is out of
scope for this version.

## Carrier Tracking

Shipments in an active status are polled through a `CarrierProvider` interface:

```ts
interface CarrierProvider {
  track(carrier: string, trackingNumber: string): Promise<TrackingStatus>
}
```

One aggregator implementation sits behind the interface, covering DHL, PostNL,
DPD, GLS, UPS and others through a single credential. Adding a first-party
carrier later is a new implementation of the same interface.

Polling backs off as a shipment ages and stops on delivery, because aggregators
bill per lookup. The exact provider, its free-tier limits and account
requirements are verified during implementation rather than assumed.

## Notifications

The reconciler emits domain changes to a dispatcher. A Discord sink posts
embeds to a user-supplied webhook URL. Which events fire is driven by the
`notification_rules` table rather than hardcoded, so changing notification
behaviour is a settings change.

## Testing

- Parsers are tested against real `.eml` fixtures.
- The reconciler is tested with synthetic event sequences, including
  out-of-order arrival, duplicate delivery and replay after a parser fix.
- Money and VAT arithmetic is unit tested against known cases.
- IMAP and carrier providers are exercised through fakes; no test performs
  live network access.

## Out of Scope

Margin-scheme VAT, OAuth email connection, multi-user accounts, cloud sync,
mobile clients, and automated listing to marketplaces.
