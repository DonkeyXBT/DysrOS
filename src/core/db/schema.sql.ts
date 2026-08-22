export const SCHEMA_V1 = `
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  provider      TEXT NOT NULL,
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL,
  use_tls       INTEGER NOT NULL DEFAULT 1,
  username      TEXT NOT NULL,
  secret_cipher TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_sync_at  TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE folder_cursors (
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder       TEXT NOT NULL,
  uid_validity INTEGER NOT NULL,
  last_uid     INTEGER NOT NULL,
  PRIMARY KEY (account_id, folder)
);

CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  uid          INTEGER NOT NULL,
  folder       TEXT NOT NULL,
  message_id   TEXT,
  content_hash TEXT NOT NULL UNIQUE,
  from_address TEXT NOT NULL,
  from_name    TEXT,
  subject      TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  raw_path     TEXT NOT NULL,
  body_preview TEXT NOT NULL DEFAULT '',
  parse_status TEXT NOT NULL DEFAULT 'pending',
  parser_id    TEXT,
  parsed_at    TEXT
);
CREATE INDEX idx_messages_parse_status ON messages(parse_status);
CREATE INDEX idx_messages_received_at ON messages(received_at);

CREATE TABLE events (
  id                TEXT PRIMARY KEY,
  message_id        TEXT REFERENCES messages(id) ON DELETE CASCADE,
  parser_id         TEXT NOT NULL,
  type              TEXT NOT NULL,
  retailer          TEXT NOT NULL,
  external_order_id TEXT,
  occurred_at       TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  reconciled_at     TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_events_match ON events(retailer, external_order_id);
CREATE INDEX idx_events_unreconciled ON events(reconciled_at);

CREATE TABLE purchases (
  id                TEXT PRIMARY KEY,
  retailer          TEXT NOT NULL,
  external_order_id TEXT,
  ordered_at        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  currency          TEXT NOT NULL,
  subtotal_minor    INTEGER NOT NULL DEFAULT 0,
  shipping_minor    INTEGER NOT NULL DEFAULT 0,
  vat_minor         INTEGER NOT NULL DEFAULT 0,
  vat_rate_bp       INTEGER NOT NULL DEFAULT 0,
  total_minor       INTEGER NOT NULL DEFAULT 0,
  fx_rate_to_base   REAL NOT NULL DEFAULT 1.0,
  created_at        TEXT NOT NULL,
  UNIQUE (retailer, external_order_id)
);

CREATE TABLE purchase_lines (
  id          TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  sku         TEXT,
  size        TEXT,
  quantity    INTEGER NOT NULL DEFAULT 1,
  unit_minor  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE items (
  id                   TEXT PRIMARY KEY,
  purchase_line_id     TEXT REFERENCES purchase_lines(id) ON DELETE SET NULL,
  purchase_id          TEXT REFERENCES purchases(id) ON DELETE SET NULL,
  title                TEXT NOT NULL,
  brand                TEXT,
  sku                  TEXT,
  size                 TEXT,
  condition            TEXT NOT NULL DEFAULT 'unknown',
  status               TEXT NOT NULL DEFAULT 'incoming',
  location             TEXT,
  image_url            TEXT,
  cost_minor           INTEGER NOT NULL DEFAULT 0,
  cost_currency        TEXT NOT NULL,
  listed_minor         INTEGER,
  purchased_at         TEXT,
  user_corrected_json  TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_items_status ON items(status);

CREATE TABLE sales (
  id                TEXT PRIMARY KEY,
  item_id           TEXT REFERENCES items(id) ON DELETE SET NULL,
  marketplace       TEXT NOT NULL,
  external_order_id TEXT,
  sold_at           TEXT NOT NULL,
  currency          TEXT NOT NULL,
  gross_minor       INTEGER NOT NULL DEFAULT 0,
  fees_minor        INTEGER NOT NULL DEFAULT 0,
  shipping_minor    INTEGER NOT NULL DEFAULT 0,
  vat_minor         INTEGER NOT NULL DEFAULT 0,
  vat_rate_bp       INTEGER NOT NULL DEFAULT 0,
  payout_minor      INTEGER NOT NULL DEFAULT 0,
  fx_rate_to_base   REAL NOT NULL DEFAULT 1.0,
  created_at        TEXT NOT NULL,
  UNIQUE (marketplace, external_order_id)
);

CREATE TABLE shipments (
  id              TEXT PRIMARY KEY,
  direction       TEXT NOT NULL,
  carrier         TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  item_id         TEXT REFERENCES items(id) ON DELETE SET NULL,
  purchase_id     TEXT REFERENCES purchases(id) ON DELETE SET NULL,
  sale_id         TEXT REFERENCES sales(id) ON DELETE SET NULL,
  last_movement_at    TEXT,
  expected_delivery_at TEXT,
  last_polled_at  TEXT,
  events_json     TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL,
  UNIQUE (carrier, tracking_number)
);
CREATE INDEX idx_shipments_status ON shipments(status);

CREATE TABLE refunds (
  id           TEXT PRIMARY KEY,
  purchase_id  TEXT REFERENCES purchases(id) ON DELETE CASCADE,
  currency     TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  received_at  TEXT,
  expected_at  TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE notification_rules (
  event_type TEXT PRIMARY KEY,
  channel    TEXT NOT NULL DEFAULT 'discord',
  enabled    INTEGER NOT NULL DEFAULT 1,
  template   TEXT
);
`

/**
 * Shipments may have no tracking number.
 *
 * Discovered from real mail: bol.com sends a shipping confirmation naming the
 * carrier and the delivery date but no carrier barcode at all — only an opaque
 * redirect link. Requiring a tracking number would force a placeholder into the
 * column, which is worse than recording the truth that none is known yet.
 *
 * SQLite cannot drop a NOT NULL constraint in place, so the table is rebuilt.
 */
export const SCHEMA_V2 = `
CREATE TABLE shipments_new (
  id              TEXT PRIMARY KEY,
  direction       TEXT NOT NULL,
  carrier         TEXT NOT NULL,
  tracking_number TEXT,
  tracking_url    TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  item_id         TEXT REFERENCES items(id) ON DELETE SET NULL,
  purchase_id     TEXT REFERENCES purchases(id) ON DELETE SET NULL,
  sale_id         TEXT REFERENCES sales(id) ON DELETE SET NULL,
  last_movement_at     TEXT,
  expected_delivery_at TEXT,
  last_polled_at  TEXT,
  events_json     TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL
);

INSERT INTO shipments_new
  (id, direction, carrier, tracking_number, status, item_id, purchase_id, sale_id,
   last_movement_at, expected_delivery_at, last_polled_at, events_json, created_at)
SELECT id, direction, carrier, tracking_number, status, item_id, purchase_id, sale_id,
       last_movement_at, expected_delivery_at, last_polled_at, events_json, created_at
FROM shipments;

DROP TABLE shipments;
ALTER TABLE shipments_new RENAME TO shipments;

CREATE INDEX idx_shipments_status ON shipments(status);
CREATE UNIQUE INDEX idx_shipments_tracking
  ON shipments(carrier, tracking_number) WHERE tracking_number IS NOT NULL;
`

/**
 * Records whether a purchase's stated total matched its own parts.
 *
 * The check is made at parse time (quantity x unit + shipping == total) but was
 * only ever kept in the event payload, so a screen reading the reconciled
 * tables could not show it. It is a fact about the purchase, so it belongs on
 * the purchase.
 */
export const SCHEMA_V3 = `
ALTER TABLE purchases ADD COLUMN totals_consistent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN title TEXT;
`

/**
 * Records deliberately removed by hand.
 *
 * Deletion cannot live on the event, because re-reading mail rebuilds events
 * from scratch and would bring the record straight back — which makes deleting
 * feel broken rather than final. Keyed by the thing itself, so it survives any
 * number of rebuilds.
 */
export const SCHEMA_V4 = `
CREATE TABLE suppressions (
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);
`

/**
 * The delivery postcode a parcel was resolved with, and a repair.
 *
 * DHL states the postcode next to the barcode in its tracking URL, and the
 * pattern that read that URL took both as the barcode — real databases hold
 * codes like `JVGL0637312004304176/3043LC`, which no carrier and no redirect
 * tool accepts. The barcode is cut back to the barcode, the postcode is kept
 * in its own column, and rows that turn out to duplicate a parcel already
 * recorded are folded away first so the unique index still holds.
 */
export const SCHEMA_V5 = `
ALTER TABLE shipments ADD COLUMN postal_code TEXT;

DELETE FROM shipments WHERE id IN (
  SELECT s.id FROM shipments s
  WHERE s.tracking_number IS NOT NULL
    AND instr(s.tracking_number, '/') > 0
    AND EXISTS (
      SELECT 1 FROM shipments t
      WHERE t.id != s.id
        AND t.carrier = s.carrier
        AND t.tracking_number = substr(s.tracking_number, 1, instr(s.tracking_number, '/') - 1)
    )
);

UPDATE shipments
SET postal_code = CASE
      WHEN upper(substr(tracking_number, instr(tracking_number, '/') + 1))
           GLOB '[0-9][0-9][0-9][0-9][A-Z][A-Z]'
      THEN upper(substr(tracking_number, instr(tracking_number, '/') + 1))
      ELSE postal_code
    END,
    tracking_number = substr(tracking_number, 1, instr(tracking_number, '/') - 1)
WHERE tracking_number IS NOT NULL AND instr(tracking_number, '/') > 0;
`

/**
 * Parcels sent to a ServicePoint, and what came of it.
 *
 * Redirecting is a real-world act with a real-world result, so it is recorded
 * rather than inferred: which parcel, when, whether DHL accepted it and which
 * point it went to. A parcel can be attempted more than once — the option
 * often opens up only close to delivery — so this keeps the latest attempt per
 * parcel, which is the one that describes where the parcel is going.
 */
export const SCHEMA_V6 = `
CREATE TABLE redirects (
  shipment_id     TEXT PRIMARY KEY REFERENCES shipments(id) ON DELETE CASCADE,
  tracking_number TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  message         TEXT,
  service_point   TEXT,
  dry_run         INTEGER NOT NULL DEFAULT 0,
  attempted_at    TEXT NOT NULL
);
`

/**
 * Sales made by hand, to a buyer who is not a marketplace.
 *
 * The sales table was built around marketplace orders, which carry an external
 * id and a payout. A private sale has neither: it has a buyer's name, a price,
 * and whether that price already had VAT in it. Those are added here, and the
 * unique key is relaxed so many private sales can exist without external ids
 * colliding.
 */
export const SCHEMA_V7 = `
CREATE TABLE sales_new (
  id                TEXT PRIMARY KEY,
  item_id           TEXT REFERENCES items(id) ON DELETE SET NULL,
  marketplace       TEXT NOT NULL,
  external_order_id TEXT,
  buyer             TEXT,
  note              TEXT,
  price_included_vat INTEGER NOT NULL DEFAULT 1,
  sold_at           TEXT NOT NULL,
  currency          TEXT NOT NULL,
  gross_minor       INTEGER NOT NULL DEFAULT 0,
  fees_minor        INTEGER NOT NULL DEFAULT 0,
  shipping_minor    INTEGER NOT NULL DEFAULT 0,
  vat_minor         INTEGER NOT NULL DEFAULT 0,
  vat_rate_bp       INTEGER NOT NULL DEFAULT 0,
  payout_minor      INTEGER NOT NULL DEFAULT 0,
  fx_rate_to_base   REAL NOT NULL DEFAULT 1.0,
  created_at        TEXT NOT NULL
);

INSERT INTO sales_new
  (id, item_id, marketplace, external_order_id, sold_at, currency, gross_minor,
   fees_minor, shipping_minor, vat_minor, vat_rate_bp, payout_minor, fx_rate_to_base, created_at)
SELECT id, item_id, marketplace, external_order_id, sold_at, currency, gross_minor,
       fees_minor, shipping_minor, vat_minor, vat_rate_bp, payout_minor, fx_rate_to_base, created_at
FROM sales;

DROP TABLE sales;
ALTER TABLE sales_new RENAME TO sales;

CREATE UNIQUE INDEX idx_sales_external
  ON sales(marketplace, external_order_id) WHERE external_order_id IS NOT NULL;
CREATE INDEX idx_sales_item ON sales(item_id);
`

/**
 * The delivery window, kept on the parcel rather than on one of its mails.
 *
 * "Between 17:00 and 19:00" arrives in the out-for-delivery mail, which is not
 * the mail that created the parcel's row: when the two are recognised as one
 * parcel the later row is folded away, and with it went the only copy of the
 * window. Facts about a parcel belong on the parcel.
 */
export const SCHEMA_V8 = `
ALTER TABLE shipments ADD COLUMN delivery_window TEXT;
`

/**
 * Which mails were found to describe a parcel already recorded.
 *
 * Two mails are known to be one parcel only once both resolve to the same
 * barcode — a fact learned over the network, at some cost, and then thrown
 * away on the next rebuild, which brought every duplicate row back until the
 * network was asked all over again. Remembering the pairing keeps a parcel a
 * parcel: the mail is applied to the row it belongs to instead of making a new
 * one.
 */
export const SCHEMA_V9 = `
CREATE TABLE parcel_merges (
  event_id        TEXT PRIMARY KEY,
  into_id         TEXT NOT NULL,
  tracking_number TEXT,
  created_at      TEXT NOT NULL
);
`

/**
 * Which events have already been announced.
 *
 * Notifications must go out once: mail is re-read after every upgrade, and
 * without a record of what was already said, each re-read would announce
 * months of deliveries again.
 */
export const SCHEMA_V10 = `
CREATE TABLE notifications_sent (
  event_id TEXT PRIMARY KEY,
  event    TEXT NOT NULL,
  sent_at  TEXT NOT NULL
);

-- Everything collected before notifications worked counts as already said.
-- Otherwise the first run after this upgrade would announce every delivery of
-- the past month in one burst.
INSERT INTO notifications_sent (event_id, event, sent_at)
SELECT id, type, datetime('now') FROM events;
`

/**
 * What a notification was about, as opposed to which mail carried it.
 *
 * A parcel's arrival is announced by the carrier and by the retailer, and both
 * mails are real, separate events. Only one of them is news. Recording the
 * subject alongside the event lets the second one be recognised as the same
 * announcement and kept quiet.
 */
export const SCHEMA_V11 = `
ALTER TABLE notifications_sent ADD COLUMN subject_key TEXT;
CREATE INDEX idx_notifications_subject ON notifications_sent(subject_key);
`

/**
 * What a marketplace sale was, and where its label lives.
 *
 * A sale on a marketplace names the item itself — the goods may never have
 * been bought through any mail this application has seen, so there is no stock
 * row to take a title from. The shipping label, meanwhile, arrives as a PDF
 * attached to a mail, and the mail is where it stays until someone asks to
 * print it; the parcel only needs to remember which mail that was.
 */
export const SCHEMA_V12 = `
ALTER TABLE sales ADD COLUMN title TEXT;
ALTER TABLE shipments ADD COLUMN label_message_id TEXT;
`

/**
 * Who a mail was addressed to, as opposed to which mailbox collected it.
 *
 * One mailbox gathers mail sent to many addresses — aliases, forwards, a
 * catch-all — and which address was used is the useful fact: it is how one
 * account's orders are told from another's. The mailbox was standing in for it
 * and answering the wrong question.
 */
export const SCHEMA_V13 = `
ALTER TABLE messages ADD COLUMN to_address TEXT;
`

/**
 * Statuses set by hand.
 *
 * The mail is the authority on where something is, right up until it is wrong:
 * a parcel handed over at the door with no delivery mail behind it, a unit
 * listed somewhere this application never sees. Correcting it has to survive
 * the next sync, and reconciliation rewrites status from events every run — so
 * the correction cannot live on the row it corrects. Kept beside the thing, by
 * id, and re-applied after every run.
 */
export const SCHEMA_V14 = `
CREATE TABLE status_overrides (
  kind      TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  status    TEXT NOT NULL,
  set_at    TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id)
);
`
