# Frontend Specification

This document describes the user interface for the reselling operations tracker. It is written to be handed to a design tool: it specifies what each screen must show, what data is available, and what states must be handled. It deliberately does not prescribe visual style beyond the constraints in "Design Constraints".

The backend is already defined. Every field listed here exists in the data model — nothing below is aspirational.

## Context

The user runs a reselling operation across sneakers and streetwear, general marketplace flipping, and tickets and collectibles. They buy from retailers, hold physical stock, and sell on marketplaces. The application connects to their email accounts and automatically converts order, cancellation, refund, sale and shipping emails into records.

This is a **desktop application used daily by one person who knows their own business well**. It is a working tool, not a consumer product. Favour information density over whitespace, and speed of scanning over decoration. The user will keep it open in the background and glance at it many times a day.

## Design Constraints

- **Desktop window**, resizable. Design for 1440×900 as the target, and ensure the layout survives down to 1100px wide.
- **Light and dark themes** are both required.
- **Persistent left sidebar** for navigation; content area to the right.
- **Dense data tables** are the primary interface element. Assume 200+ rows.
- **Money is always shown with its currency.** Amounts may be in EUR, USD or GBP. Never render a bare number for money.
- **No modal dialogs for primary workflows.** Use side drawers or inline editing so the user does not lose context.
- Every destructive action requires confirmation.

## Global Chrome

**Sidebar** — Dashboard, Inventory, Purchases, Sales, Shipments, Review, Reports, Settings. The Review entry shows a count badge when unrecognized emails are waiting; this is the one badge in the application and it should draw the eye.

**Sync indicator** — a persistent element showing email sync state. Four states: `idle` (with relative time of last sync, e.g. "synced 4m ago"), `syncing` (with progress: "3 of 5 accounts"), `error` (with the failing account name), and `never` (first run, not yet configured). Clicking it triggers a manual sync.

## Screen: Dashboard

The three things the user most wants on opening the application are **profit and margin**, **what is in flight**, and **stock on hand**. The dashboard shows all three without scrolling at 1440×900.

**Profit and margin.** A period selector (This week / This month / This quarter / This year / Custom). For the selected period: revenue, cost of goods sold, fees, net profit, and margin as a percentage. Include a comparison against the previous equivalent period, shown as a delta with direction. A small trend chart of net profit over time supports this section.

**In flight.** Two counts with drill-through: items purchased but not yet received (inbound), and items sold but not yet delivered to the buyer (outbound). Surface anything anomalous prominently — a shipment with no tracking movement for over 7 days, or an expected delivery date now in the past.

**Stock on hand.** Total units held, total capital tied up in that stock, and an aging breakdown by how long items have been held: 0–30 days, 31–60, 61–90, 90+ days. Items in the 90+ bucket represent stalled capital and should be visually distinct.

## Screen: Inventory

The core screen. A table of individual items — every physical unit is one row.

Columns: image thumbnail, title, brand, size, condition, status, purchase date, purchase price, listed price, days held, location, source retailer.

**Status values** and their meaning:

| Status | Meaning |
|---|---|
| `incoming` | Bought, not yet physically received |
| `in_stock` | Physically held, not listed |
| `listed` | Listed for sale, not yet sold |
| `sold` | Sold, not yet shipped to buyer |
| `shipped_to_buyer` | In transit to buyer |
| `delivered` | Delivered to buyer; the item is complete |
| `cancelled` | Order cancelled before receipt |
| `returned` | Returned after sale |

These eight statuses need a visual system that makes the pipeline legible at a glance. They are roughly sequential, and the two reversing states (`cancelled`, `returned`) should read as exceptions rather than as further steps forward.

Required behaviours: filter by status, brand, retailer and date range; free text search across title and SKU; sort on any column; multi-select rows for bulk status changes; and manual item creation for stock that arrived without an email trail.

**Item detail drawer**, opened by clicking a row. Shows everything known about one unit: full purchase detail with cost breakdown, the sale if it has sold, its complete profit calculation, linked inbound and outbound shipments with tracking history, and a timeline of every email-derived event that touched this item. The timeline is important — it is how the user verifies that automatic parsing got things right, so each entry must show what was extracted and link back to the source email.

## Screen: Purchases

Orders placed with retailers, one row per order, each expanding to its line items. Columns: retailer, order reference, date, item count, subtotal, shipping, VAT, total, status, and whether a refund is outstanding.

Statuses: `pending`, `confirmed`, `shipped`, `delivered`, `cancelled`, `refunded`, `partially_refunded`.

Orders with an outstanding refund — cancelled but money not yet received back — are the ones that lose the user money when forgotten, so they need to be findable immediately.

## Screen: Sales

One row per sale. Columns: marketplace, item, sale date, gross price, fees, shipping cost, VAT, net payout, profit, and margin percentage.

Show profit both in absolute money and as a margin percentage, and make loss-making sales unmistakable. Support grouping by marketplace so the user can see which channel actually pays.

## Screen: Shipments

Track and trace across both directions. One row per shipment: direction (inbound from retailer / outbound to buyer), carrier, tracking number, linked item or order, current status, last movement date, and expected delivery.

Carriers include DHL, PostNL, DPD, GLS and UPS; the carrier should be identifiable at a glance.

**Tracking states**: `pending` (label created, not yet collected), `in_transit`, `out_for_delivery`, `delivered`, `exception` (failed delivery, customs hold, damage), and `unknown` (carrier returned nothing).

`exception` and stalled shipments — no movement for over 7 days — are the whole reason this screen exists. Design for those cases first, not for the happy path.

Selecting a shipment shows its full carrier event history as a timeline.

## Screen: Review

The queue of emails that arrived but that no parser recognized. This screen prevents silent data loss, and the user works through it like an inbox.

Each entry shows sender, subject, date received, and a preview of the email body. For each one the user can: record its facts manually through a form (what kind of event, which retailer, which order, what amounts), mark it as irrelevant so similar mail is ignored in future, or export the `.eml` file to send for a parser to be written.

An empty queue is the normal and desired state, so the empty state should feel like success rather than absence.

## Screen: Reports

**Profit and loss** over a selected period, broken down by marketplace, by brand, and by retailer, with CSV export.

**VAT return** for a selected quarter: input VAT paid on purchases, output VAT charged on sales, and the net position. This is used to file a real return, so it must be precise, clearly show which transactions are included, and export to CSV.

**Currency exposure**: holdings and transactions grouped by original currency, since the user buys in USD and GBP but reports in EUR.

## Screen: Settings

**Email accounts.** A list of connected accounts, each showing address, provider, connection status and last sync time. Adding an account: choose a provider from Gmail, Outlook, Yahoo, web.de, iCloud, Namecheap Private Email or Custom; enter address and password; host and port are prefilled from the provider and editable under Custom. Gmail and Yahoo require an app-specific password rather than the account password — the form must say so clearly at the point of entry, because this is where users get stuck. Include a "Test connection" action that reports success or the specific failure.

**Currency and VAT.** Base reporting currency, VAT registration country, default VAT rate.

**Tracking.** Carrier tracking API credentials, with a connection test and current usage against quota.

**Discord notifications.** Webhook URL with a "Send test message" action, and a per-event-type table of toggles controlling which events post. Event types: order placed, order shipped, order delivered, order cancelled, refund received, item sold, payout received, shipment exception. This section will be extended later, so the toggle list must tolerate growth.

**Parsers.** A read-only list of installed parsers showing retailer, what mail they match, and how many messages each has successfully parsed. This is diagnostic — it answers "why was this email not picked up".

## Data Shapes

These are the shapes the UI receives. Money is always an integer in minor units paired with a currency code; format for display, never do arithmetic on the formatted value.

```ts
type Money = { minor: number; currency: 'EUR' | 'USD' | 'GBP' }

type ItemStatus =
  | 'incoming' | 'in_stock' | 'listed' | 'sold'
  | 'shipped_to_buyer' | 'delivered' | 'cancelled' | 'returned'

type Item = {
  id: string
  title: string
  brand: string | null
  sku: string | null
  size: string | null
  condition: 'new' | 'used' | 'unknown'
  status: ItemStatus
  imageUrl: string | null
  location: string | null
  purchasePrice: Money
  listedPrice: Money | null
  purchasedAt: string | null   // ISO 8601
  daysHeld: number | null
  retailer: string | null
  purchaseId: string | null
  saleId: string | null
}

type Purchase = {
  id: string
  retailer: string
  externalOrderId: string | null
  orderedAt: string
  status: 'pending' | 'confirmed' | 'shipped' | 'delivered'
        | 'cancelled' | 'refunded' | 'partially_refunded'
  subtotal: Money
  shipping: Money
  vat: Money
  total: Money
  fxRateToBase: number
  itemCount: number
  refundOutstanding: Money | null
}

type Sale = {
  id: string
  itemId: string
  marketplace: string
  soldAt: string
  gross: Money
  fees: Money
  shipping: Money
  vat: Money
  payout: Money
  profit: Money          // may be negative
  marginPercent: number  // may be negative
}

type Shipment = {
  id: string
  direction: 'inbound' | 'outbound'
  carrier: string
  trackingNumber: string
  status: 'pending' | 'in_transit' | 'out_for_delivery'
        | 'delivered' | 'exception' | 'unknown'
  lastMovementAt: string | null
  expectedDeliveryAt: string | null
  daysSinceMovement: number | null
  itemId: string | null
  purchaseId: string | null
  events: { at: string; status: string; description: string; location: string | null }[]
}

type ReviewMessage = {
  id: string
  fromAddress: string
  fromName: string | null
  subject: string
  receivedAt: string
  bodyPreview: string
}

type DashboardSummary = {
  period: { from: string; to: string; label: string }
  revenue: Money
  costOfGoods: Money
  fees: Money
  netProfit: Money
  marginPercent: number
  previousNetProfit: Money
  inbound: { count: number; stalled: number }
  outbound: { count: number; stalled: number }
  stock: {
    units: number
    capitalTiedUp: Money
    aging: { bucket: '0-30' | '31-60' | '61-90' | '90+'; units: number; value: Money }[]
  }
}
```

## States To Design

Every data screen needs four states, and the non-happy ones matter more than usual here because this application's data arrives automatically and can therefore be absent or wrong without the user having done anything.

- **Loading** — data is being fetched from the local database. This is fast; avoid heavy skeletons that flash.
- **Empty** — distinguish "nothing matches your filters" from "you have no data yet". First-run empty states should point at connecting an email account, since nothing works until that happens.
- **Error** — the database or a sync failed. Say what failed and what the user can do.
- **Stale** — email sync has not succeeded recently, so displayed data may be incomplete. This state is specific to this application and needs a real treatment: the numbers on screen are not wrong, but they may be out of date, and the user needs to know that without being alarmed.

## Interaction Notes

- Keyboard navigation through tables, with the item detail drawer opening on Enter and closing on Escape.
- Every automatically-derived value must be traceable to the email it came from. The user needs to be able to answer "why does it think this?" for any number on screen.
- Any automatically-derived value can be manually overridden. When it is, mark it as user-corrected so a later re-parse does not silently overwrite the correction.
- Long operations — initial mailbox sync, bulk re-parse — report progress and can be cancelled.
