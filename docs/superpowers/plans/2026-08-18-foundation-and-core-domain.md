# Foundation & Core Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the headless foundation of the reselling tracker — project scaffold, exact money and VAT arithmetic, the SQLite schema with a migration runner, and the repositories for accounts, messages and events.

**Architecture:** A pure TypeScript core under `src/core` with no Electron imports, so the entire pipeline runs and is tested from the command line. Storage is SQLite via `better-sqlite3` (verified to install from prebuilds on this machine, SQLite 3.53.4). Money is never a float: every amount is an integer count of minor units paired with an ISO currency code.

**Tech Stack:** TypeScript 5, Node 24, vitest, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-08-18-reselling-tracker-design.md`

## Global Constraints

- **No floats for money.** Every monetary value is an integer in minor units plus an ISO 4217 currency code. Arithmetic on formatted strings is forbidden.
- **Currencies supported:** `EUR`, `USD`, `GBP`. Base reporting currency is configurable, default `EUR`.
- **VAT rates are basis points.** 21% is `2100`. Never store a percentage as a float.
- **The core imports nothing from Electron.** `src/core/**` must run under plain `node`.
- **No network access in tests.** IMAP and carrier providers are exercised through fakes.
- **Timestamps are ISO 8601 strings in UTC** at rest and in interfaces.
- **Rounding rule:** half away from zero, applied once at the end of a calculation.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | Dependencies, scripts |
| `tsconfig.json` | TypeScript configuration |
| `vitest.config.ts` | Test runner configuration |
| `src/core/money.ts` | Money type and exact arithmetic |
| `src/core/vat.ts` | VAT breakdown from gross or net |
| `src/core/db/connection.ts` | Opens the database, applies pragmas |
| `src/core/db/migrations.ts` | Ordered migration list and runner |
| `src/core/db/schema.sql.ts` | Schema version 1 DDL |
| `src/core/repos/accounts.ts` | Email account CRUD and folder cursors |
| `src/core/repos/messages.ts` | Message upsert by content hash, parse status |
| `src/core/repos/events.ts` | Deterministic event identity and upsert |
| `src/core/types.ts` | Shared domain types |

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Test: `src/core/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a working `npm test` command running vitest against `src/**/*.test.ts`

- [ ] **Step 1: Initialise the package and install dependencies**

```bash
npm init -y
npm install better-sqlite3
npm install -D typescript vitest @types/node @types/better-sqlite3
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
```

- [ ] **Step 4: Set the package to ESM and add the test script**

In `package.json`, set `"type": "module"` and replace the `scripts` block with:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 6: Write the smoke test**

Create `src/core/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('toolchain', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 7: Run the test suite**

Run: `npm test`
Expected: PASS, 1 test.

- [ ] **Step 8: Commit**

```bash
git init
git add -A
git commit -m "chore: scaffold TypeScript project with vitest"
```

---

### Task 2: Money Arithmetic

**Files:**
- Create: `src/core/money.ts`
- Test: `src/core/money.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type Currency = 'EUR' | 'USD' | 'GBP'`
  - `interface Money { minor: number; currency: Currency }`
  - `money(minor: number, currency: Currency): Money`
  - `addMoney(a: Money, b: Money): Money`
  - `subtractMoney(a: Money, b: Money): Money`
  - `multiplyMoney(m: Money, factor: number): Money`
  - `sumMoney(values: Money[], currency: Currency): Money`
  - `convertMoney(m: Money, rate: number, to: Currency): Money`
  - `formatMoney(m: Money): string`
  - `roundHalfAwayFromZero(value: number): number`

- [ ] **Step 1: Write the failing test**

Create `src/core/money.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  money, addMoney, subtractMoney, multiplyMoney, sumMoney,
  convertMoney, formatMoney, roundHalfAwayFromZero,
} from './money.js'

describe('money construction', () => {
  it('rejects a non-integer minor amount', () => {
    expect(() => money(10.5, 'EUR')).toThrow(/integer/i)
  })

  it('accepts a negative amount, since refunds exist', () => {
    expect(money(-2200, 'EUR')).toEqual({ minor: -2200, currency: 'EUR' })
  })
})

describe('rounding', () => {
  it('rounds half away from zero, not to even', () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3)
    expect(roundHalfAwayFromZero(3.5)).toBe(4)
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3)
    expect(roundHalfAwayFromZero(2.4)).toBe(2)
  })
})

describe('addition and subtraction', () => {
  it('adds amounts in the same currency', () => {
    expect(addMoney(money(22000, 'EUR'), money(1550, 'EUR')))
      .toEqual({ minor: 23550, currency: 'EUR' })
  })

  it('refuses to add different currencies', () => {
    expect(() => addMoney(money(100, 'EUR'), money(100, 'USD')))
      .toThrow(/currency mismatch/i)
  })

  it('subtracts, allowing a negative result', () => {
    expect(subtractMoney(money(1000, 'EUR'), money(2500, 'EUR')))
      .toEqual({ minor: -1500, currency: 'EUR' })
  })
})

describe('multiplication', () => {
  it('rounds the result to whole minor units', () => {
    expect(multiplyMoney(money(1999, 'EUR'), 0.15))
      .toEqual({ minor: 300, currency: 'EUR' })
  })
})

describe('summing', () => {
  it('returns zero in the given currency for an empty list', () => {
    expect(sumMoney([], 'GBP')).toEqual({ minor: 0, currency: 'GBP' })
  })

  it('sums a list', () => {
    const values = [money(1000, 'EUR'), money(250, 'EUR'), money(-100, 'EUR')]
    expect(sumMoney(values, 'EUR')).toEqual({ minor: 1150, currency: 'EUR' })
  })

  it('refuses a list containing a foreign currency', () => {
    expect(() => sumMoney([money(1000, 'EUR'), money(1, 'USD')], 'EUR'))
      .toThrow(/currency mismatch/i)
  })
})

describe('conversion', () => {
  it('converts using the supplied rate and rounds once', () => {
    expect(convertMoney(money(22000, 'USD'), 0.9231, 'EUR'))
      .toEqual({ minor: 20308, currency: 'EUR' })
  })

  it('rejects a non-positive rate', () => {
    expect(() => convertMoney(money(100, 'USD'), 0, 'EUR')).toThrow(/rate/i)
  })
})

describe('formatting', () => {
  it('formats with the currency symbol and two decimals', () => {
    expect(formatMoney(money(20308, 'EUR'))).toBe('€203.08')
    expect(formatMoney(money(-1500, 'USD'))).toBe('-$15.00')
    expect(formatMoney(money(5, 'GBP'))).toBe('£0.05')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/money.test.ts`
Expected: FAIL — cannot resolve `./money.js`.

- [ ] **Step 3: Write the implementation**

Create `src/core/money.ts`:

```ts
export type Currency = 'EUR' | 'USD' | 'GBP'

export interface Money {
  minor: number
  currency: Currency
}

const SYMBOLS: Record<Currency, string> = { EUR: '€', USD: '$', GBP: '£' }

export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

export function money(minor: number, currency: Currency): Money {
  if (!Number.isInteger(minor)) {
    throw new Error(`Money requires an integer minor amount, received ${minor}`)
  }
  return { minor, currency }
}

function assertSameCurrency(a: Currency, b: Currency): void {
  if (a !== b) throw new Error(`Currency mismatch: ${a} and ${b}`)
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a.currency, b.currency)
  return { minor: a.minor + b.minor, currency: a.currency }
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a.currency, b.currency)
  return { minor: a.minor - b.minor, currency: a.currency }
}

export function multiplyMoney(m: Money, factor: number): Money {
  return { minor: roundHalfAwayFromZero(m.minor * factor), currency: m.currency }
}

export function sumMoney(values: Money[], currency: Currency): Money {
  let total = 0
  for (const value of values) {
    assertSameCurrency(value.currency, currency)
    total += value.minor
  }
  return { minor: total, currency }
}

export function convertMoney(m: Money, rate: number, to: Currency): Money {
  if (!(rate > 0)) throw new Error(`Conversion rate must be positive, received ${rate}`)
  return { minor: roundHalfAwayFromZero(m.minor * rate), currency: to }
}

export function formatMoney(m: Money): string {
  const sign = m.minor < 0 ? '-' : ''
  const absolute = Math.abs(m.minor)
  const units = Math.floor(absolute / 100)
  const cents = String(absolute % 100).padStart(2, '0')
  return `${sign}${SYMBOLS[m.currency]}${units}.${cents}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/core/money.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/money.ts src/core/money.test.ts
git commit -m "feat: exact money arithmetic in integer minor units"
```

---

### Task 3: VAT Breakdown

**Files:**
- Create: `src/core/vat.ts`
- Test: `src/core/vat.test.ts`

**Interfaces:**
- Consumes: `Money`, `money`, `subtractMoney`, `addMoney`, `roundHalfAwayFromZero` from `src/core/money.ts`
- Produces:
  - `interface VatBreakdown { net: Money; vat: Money; gross: Money; rateBasisPoints: number }`
  - `vatFromGross(gross: Money, rateBasisPoints: number): VatBreakdown`
  - `vatFromNet(net: Money, rateBasisPoints: number): VatBreakdown`

- [ ] **Step 1: Write the failing test**

Create `src/core/vat.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { money } from './money.js'
import { vatFromGross, vatFromNet } from './vat.js'

describe('vatFromNet', () => {
  it('adds 21% VAT to a net amount', () => {
    const result = vatFromNet(money(10000, 'EUR'), 2100)
    expect(result.net).toEqual({ minor: 10000, currency: 'EUR' })
    expect(result.vat).toEqual({ minor: 2100, currency: 'EUR' })
    expect(result.gross).toEqual({ minor: 12100, currency: 'EUR' })
  })

  it('rounds the VAT amount to whole minor units', () => {
    const result = vatFromNet(money(999, 'EUR'), 2100)
    expect(result.vat).toEqual({ minor: 210, currency: 'EUR' })
    expect(result.gross).toEqual({ minor: 1209, currency: 'EUR' })
  })
})

describe('vatFromGross', () => {
  it('extracts 21% VAT from a gross amount', () => {
    const result = vatFromGross(money(12100, 'EUR'), 2100)
    expect(result.gross).toEqual({ minor: 12100, currency: 'EUR' })
    expect(result.vat).toEqual({ minor: 2100, currency: 'EUR' })
    expect(result.net).toEqual({ minor: 10000, currency: 'EUR' })
  })

  it('keeps net and VAT summing exactly to gross when rounding bites', () => {
    const result = vatFromGross(money(10000, 'EUR'), 2100)
    expect(result.vat).toEqual({ minor: 1736, currency: 'EUR' })
    expect(result.net).toEqual({ minor: 8264, currency: 'EUR' })
    expect(result.net.minor + result.vat.minor).toBe(result.gross.minor)
  })
})

describe('rate validation', () => {
  it('accepts a zero rate for VAT-exempt goods', () => {
    const result = vatFromNet(money(5000, 'EUR'), 0)
    expect(result.vat).toEqual({ minor: 0, currency: 'EUR' })
    expect(result.gross).toEqual({ minor: 5000, currency: 'EUR' })
  })

  it('rejects a negative rate', () => {
    expect(() => vatFromNet(money(5000, 'EUR'), -100)).toThrow(/rate/i)
  })

  it('rejects a non-integer rate, since rates are basis points', () => {
    expect(() => vatFromNet(money(5000, 'EUR'), 21.5)).toThrow(/basis points/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/vat.test.ts`
Expected: FAIL — cannot resolve `./vat.js`.

- [ ] **Step 3: Write the implementation**

Create `src/core/vat.ts`:

```ts
import { type Money, money, roundHalfAwayFromZero } from './money.js'

export interface VatBreakdown {
  net: Money
  vat: Money
  gross: Money
  rateBasisPoints: number
}

function assertRate(rateBasisPoints: number): void {
  if (!Number.isInteger(rateBasisPoints)) {
    throw new Error(`VAT rate must be expressed in basis points, received ${rateBasisPoints}`)
  }
  if (rateBasisPoints < 0) {
    throw new Error(`VAT rate must not be negative, received ${rateBasisPoints}`)
  }
}

export function vatFromNet(net: Money, rateBasisPoints: number): VatBreakdown {
  assertRate(rateBasisPoints)
  const vatMinor = roundHalfAwayFromZero((net.minor * rateBasisPoints) / 10000)
  return {
    net,
    vat: money(vatMinor, net.currency),
    gross: money(net.minor + vatMinor, net.currency),
    rateBasisPoints,
  }
}

export function vatFromGross(gross: Money, rateBasisPoints: number): VatBreakdown {
  assertRate(rateBasisPoints)
  const vatMinor = roundHalfAwayFromZero(
    (gross.minor * rateBasisPoints) / (10000 + rateBasisPoints),
  )
  return {
    net: money(gross.minor - vatMinor, gross.currency),
    vat: money(vatMinor, gross.currency),
    gross,
    rateBasisPoints,
  }
}
```

Note the deliberate asymmetry: `vatFromGross` derives net by subtraction rather than by its own rounded division, which is what guarantees `net + vat === gross` exactly.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/core/vat.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/vat.ts src/core/vat.test.ts
git commit -m "feat: VAT breakdown from gross or net amounts"
```

---

### Task 4: Database Connection and Migration Runner

**Files:**
- Create: `src/core/db/schema.sql.ts`, `src/core/db/migrations.ts`, `src/core/db/connection.ts`
- Test: `src/core/db/migrations.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `openDatabase(path: string): Database` — from `connection.ts`, where `Database` is the `better-sqlite3` type
  - `migrate(db: Database): number` — applies pending migrations, returns the resulting schema version
  - `currentVersion(db: Database): number`
  - `MIGRATIONS: readonly { version: number; sql: string }[]`

- [ ] **Step 1: Write the failing test**

Create `src/core/db/migrations.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { openDatabase } from './connection.js'
import { migrate, currentVersion, MIGRATIONS } from './migrations.js'

function freshDb() {
  return openDatabase(':memory:')
}

describe('migration runner', () => {
  it('starts at version zero', () => {
    expect(currentVersion(freshDb())).toBe(0)
  })

  it('applies every migration and reports the final version', () => {
    const db = freshDb()
    const version = migrate(db)
    expect(version).toBe(MIGRATIONS.length)
    expect(currentVersion(db)).toBe(MIGRATIONS.length)
  })

  it('is idempotent when run twice', () => {
    const db = freshDb()
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
    expect(currentVersion(db)).toBe(MIGRATIONS.length)
  })

  it('creates every expected table', () => {
    const db = freshDb()
    migrate(db)
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => (row as { name: string }).name)
    for (const table of [
      'accounts', 'folder_cursors', 'messages', 'events',
      'purchases', 'purchase_lines', 'items', 'sales',
      'shipments', 'refunds', 'settings', 'notification_rules',
    ]) {
      expect(names).toContain(table)
    }
  })
})

describe('connection', () => {
  it('enables foreign key enforcement', () => {
    const db = freshDb()
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('rejects a row violating a foreign key', () => {
    const db = freshDb()
    migrate(db)
    expect(() =>
      db.prepare(
        "INSERT INTO folder_cursors (account_id, folder, uid_validity, last_uid) VALUES ('missing', 'INBOX', 1, 1)",
      ).run(),
    ).toThrow(/FOREIGN KEY/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/db/migrations.test.ts`
Expected: FAIL — cannot resolve `./connection.js`.

- [ ] **Step 3: Write the schema**

Create `src/core/db/schema.sql.ts`:

```ts
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
```

- [ ] **Step 4: Write the connection module**

Create `src/core/db/connection.ts`:

```ts
import Database from 'better-sqlite3'

export type Db = Database.Database

export function openDatabase(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}
```

- [ ] **Step 5: Write the migration runner**

Create `src/core/db/migrations.ts`:

```ts
import type { Db } from './connection.js'
import { SCHEMA_V1 } from './schema.sql.js'

export const MIGRATIONS: readonly { version: number; sql: string }[] = [
  { version: 1, sql: SCHEMA_V1 },
]

function ensureVersionTable(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
}

export function currentVersion(db: Db): number {
  ensureVersionTable(db)
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
    | { version: number | null }
    | undefined
  return row?.version ?? 0
}

export function migrate(db: Db): number {
  ensureVersionTable(db)
  const from = currentVersion(db)
  const pending = MIGRATIONS.filter((m) => m.version > from)
  const apply = db.transaction(() => {
    for (const migration of pending) {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
    }
  })
  apply()
  return currentVersion(db)
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/core/db/migrations.test.ts`
Expected: PASS, all cases.

- [ ] **Step 7: Commit**

```bash
git add src/core/db
git commit -m "feat: SQLite schema v1 with an idempotent migration runner"
```

---

### Task 5: Message Repository with Content-Hash Deduplication

**Files:**
- Create: `src/core/types.ts`, `src/core/repos/messages.ts`
- Test: `src/core/repos/messages.test.ts`

**Interfaces:**
- Consumes: `Db` from `connection.ts`, `migrate` from `migrations.ts`
- Produces:
  - `type ParseStatus = 'pending' | 'parsed' | 'unrecognized' | 'ignored'`
  - `interface StoredMessage` with fields `id, accountId, uid, folder, messageId, contentHash, fromAddress, fromName, subject, receivedAt, rawPath, bodyPreview, parseStatus, parserId, parsedAt`
  - `interface NewMessage` — `StoredMessage` without `id`, `parseStatus`, `parserId`, `parsedAt`
  - `class MessageRepo` with `upsert(message: NewMessage): StoredMessage`, `findByHash(hash: string): StoredMessage | null`, `listByStatus(status: ParseStatus): StoredMessage[]`, `markParsed(id: string, parserId: string, at: string): void`, `markUnrecognized(id: string): void`
  - `hashContent(raw: string): string` — sha256 hex

- [ ] **Step 1: Write the failing test**

Create `src/core/repos/messages.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../db/connection.js'
import { migrate } from '../db/migrations.js'
import { MessageRepo, hashContent, type NewMessage } from './messages.js'

let db: Db
let repo: MessageRepo

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db)
  db.prepare(
    `INSERT INTO accounts (id, label, email, provider, host, port, username, secret_cipher, created_at)
     VALUES ('acc1', 'Main', 'a@example.com', 'custom', 'imap.example.com', 993, 'a@example.com', 'x', '2026-08-18T10:00:00Z')`,
  ).run()
  repo = new MessageRepo(db)
})

function sample(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    accountId: 'acc1',
    uid: 42,
    folder: 'INBOX',
    messageId: '<order-1@nike.com>',
    contentHash: hashContent('raw email body one'),
    fromAddress: 'orders@nike.com',
    fromName: 'Nike',
    subject: 'Your order is confirmed',
    receivedAt: '2026-08-18T10:00:00Z',
    rawPath: 'mail/acc1/42.eml',
    bodyPreview: 'Thanks for your order',
    ...overrides,
  }
}

describe('hashContent', () => {
  it('is stable and differs for different content', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'))
    expect(hashContent('abc')).not.toBe(hashContent('abd'))
  })
})

describe('MessageRepo.upsert', () => {
  it('stores a message and assigns an id', () => {
    const stored = repo.upsert(sample())
    expect(stored.id).toBeTruthy()
    expect(stored.subject).toBe('Your order is confirmed')
    expect(stored.parseStatus).toBe('pending')
  })

  it('deduplicates the same email delivered to two accounts', () => {
    const first = repo.upsert(sample())
    const second = repo.upsert(sample({ uid: 77 }))
    expect(second.id).toBe(first.id)
    expect(repo.listByStatus('pending')).toHaveLength(1)
  })

  it('does not reset parse status when the same message is seen again', () => {
    const first = repo.upsert(sample())
    repo.markParsed(first.id, 'nike-order', '2026-08-18T11:00:00Z')
    const again = repo.upsert(sample({ uid: 78 }))
    expect(again.parseStatus).toBe('parsed')
    expect(again.parserId).toBe('nike-order')
  })
})

describe('MessageRepo status transitions', () => {
  it('lists unrecognized messages for the review queue', () => {
    const a = repo.upsert(sample())
    const b = repo.upsert(sample({ contentHash: hashContent('two'), subject: 'Mystery' }))
    repo.markParsed(a.id, 'nike-order', '2026-08-18T11:00:00Z')
    repo.markUnrecognized(b.id)

    const queue = repo.listByStatus('unrecognized')
    expect(queue).toHaveLength(1)
    expect(queue[0]!.subject).toBe('Mystery')
  })

  it('finds a message by content hash', () => {
    const stored = repo.upsert(sample())
    expect(repo.findByHash(stored.contentHash)?.id).toBe(stored.id)
    expect(repo.findByHash('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/repos/messages.test.ts`
Expected: FAIL — cannot resolve `./messages.js`.

- [ ] **Step 3: Write the shared types**

Create `src/core/types.ts`:

```ts
export type ParseStatus = 'pending' | 'parsed' | 'unrecognized' | 'ignored'

export type EventType =
  | 'order_placed'
  | 'order_confirmed'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded'
  | 'sale'
  | 'payout'
  | 'listing'

export type ItemStatus =
  | 'incoming'
  | 'in_stock'
  | 'listed'
  | 'sold'
  | 'shipped_to_buyer'
  | 'delivered'
  | 'cancelled'
  | 'returned'
```

- [ ] **Step 4: Write the repository**

Create `src/core/repos/messages.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto'
import type { Db } from '../db/connection.js'
import type { ParseStatus } from '../types.js'

export type { ParseStatus }

export interface StoredMessage {
  id: string
  accountId: string
  uid: number
  folder: string
  messageId: string | null
  contentHash: string
  fromAddress: string
  fromName: string | null
  subject: string
  receivedAt: string
  rawPath: string
  bodyPreview: string
  parseStatus: ParseStatus
  parserId: string | null
  parsedAt: string | null
}

export type NewMessage = Omit<
  StoredMessage,
  'id' | 'parseStatus' | 'parserId' | 'parsedAt'
>

interface MessageRow {
  id: string
  account_id: string
  uid: number
  folder: string
  message_id: string | null
  content_hash: string
  from_address: string
  from_name: string | null
  subject: string
  received_at: string
  raw_path: string
  body_preview: string
  parse_status: ParseStatus
  parser_id: string | null
  parsed_at: string | null
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    accountId: row.account_id,
    uid: row.uid,
    folder: row.folder,
    messageId: row.message_id,
    contentHash: row.content_hash,
    fromAddress: row.from_address,
    fromName: row.from_name,
    subject: row.subject,
    receivedAt: row.received_at,
    rawPath: row.raw_path,
    bodyPreview: row.body_preview,
    parseStatus: row.parse_status,
    parserId: row.parser_id,
    parsedAt: row.parsed_at,
  }
}

export function hashContent(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export class MessageRepo {
  constructor(private readonly db: Db) {}

  findByHash(hash: string): StoredMessage | null {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE content_hash = ?')
      .get(hash) as MessageRow | undefined
    return row ? toMessage(row) : null
  }

  upsert(message: NewMessage): StoredMessage {
    const existing = this.findByHash(message.contentHash)
    if (existing) return existing

    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO messages
          (id, account_id, uid, folder, message_id, content_hash, from_address,
           from_name, subject, received_at, raw_path, body_preview, parse_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        id,
        message.accountId,
        message.uid,
        message.folder,
        message.messageId,
        message.contentHash,
        message.fromAddress,
        message.fromName,
        message.subject,
        message.receivedAt,
        message.rawPath,
        message.bodyPreview,
      )
    return this.findByHash(message.contentHash)!
  }

  listByStatus(status: ParseStatus): StoredMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE parse_status = ? ORDER BY received_at DESC')
      .all(status) as MessageRow[]
    return rows.map(toMessage)
  }

  markParsed(id: string, parserId: string, at: string): void {
    this.db
      .prepare(
        "UPDATE messages SET parse_status = 'parsed', parser_id = ?, parsed_at = ? WHERE id = ?",
      )
      .run(parserId, at, id)
  }

  markUnrecognized(id: string): void {
    this.db
      .prepare("UPDATE messages SET parse_status = 'unrecognized' WHERE id = ?")
      .run(id)
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/core/repos/messages.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/repos/messages.ts src/core/repos/messages.test.ts
git commit -m "feat: message repository with content-hash deduplication"
```

---

### Task 6: Event Repository with Deterministic Identity

**Files:**
- Create: `src/core/repos/events.ts`
- Test: `src/core/repos/events.test.ts`

**Interfaces:**
- Consumes: `Db`, `migrate`, `MessageRepo`, `hashContent`, `EventType`
- Produces:
  - `eventId(messageId: string, parserId: string, ordinal: number): string`
  - `interface ParsedEvent { type: EventType; retailer: string; externalOrderId: string | null; occurredAt: string; payload: Record<string, unknown> }`
  - `interface StoredEvent extends ParsedEvent { id: string; messageId: string; parserId: string; reconciledAt: string | null }`
  - `class EventRepo` with `replaceForMessage(messageId, parserId, events: ParsedEvent[], now: string): StoredEvent[]`, `listUnreconciled(): StoredEvent[]`, `markReconciled(id: string, at: string): void`, `findByOrder(retailer: string, externalOrderId: string): StoredEvent[]`

This is the task that makes parser replay safe. `replaceForMessage` deletes the prior events for that message-and-parser pair before inserting, so re-running a corrected parser over retained mail yields corrected events rather than duplicated inventory.

- [ ] **Step 1: Write the failing test**

Create `src/core/repos/events.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../db/connection.js'
import { migrate } from '../db/migrations.js'
import { MessageRepo, hashContent } from './messages.js'
import { EventRepo, eventId, type ParsedEvent } from './events.js'

let db: Db
let events: EventRepo
let messageId: string

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db)
  db.prepare(
    `INSERT INTO accounts (id, label, email, provider, host, port, username, secret_cipher, created_at)
     VALUES ('acc1', 'Main', 'a@example.com', 'custom', 'imap.example.com', 993, 'a@example.com', 'x', '2026-08-18T10:00:00Z')`,
  ).run()
  const messages = new MessageRepo(db)
  messageId = messages.upsert({
    accountId: 'acc1',
    uid: 1,
    folder: 'INBOX',
    messageId: '<o1@nike.com>',
    contentHash: hashContent('one'),
    fromAddress: 'orders@nike.com',
    fromName: 'Nike',
    subject: 'Order confirmed',
    receivedAt: '2026-08-18T10:00:00Z',
    rawPath: 'mail/1.eml',
    bodyPreview: '',
  }).id
  events = new EventRepo(db)
})

function orderEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    type: 'order_placed',
    retailer: 'nike',
    externalOrderId: 'C012345678',
    occurredAt: '2026-08-18T09:55:00Z',
    payload: { totalMinor: 22000, currency: 'EUR' },
    ...overrides,
  }
}

describe('eventId', () => {
  it('is deterministic for the same inputs', () => {
    expect(eventId('m1', 'nike-order', 0)).toBe(eventId('m1', 'nike-order', 0))
  })

  it('differs by ordinal and by parser', () => {
    expect(eventId('m1', 'nike-order', 0)).not.toBe(eventId('m1', 'nike-order', 1))
    expect(eventId('m1', 'nike-order', 0)).not.toBe(eventId('m1', 'nike-ship', 0))
  })
})

describe('EventRepo.replaceForMessage', () => {
  it('stores parsed events with deterministic ids', () => {
    const stored = events.replaceForMessage(
      messageId, 'nike-order', [orderEvent()], '2026-08-18T10:01:00Z',
    )
    expect(stored).toHaveLength(1)
    expect(stored[0]!.id).toBe(eventId(messageId, 'nike-order', 0))
    expect(stored[0]!.payload).toEqual({ totalMinor: 22000, currency: 'EUR' })
  })

  it('replaces rather than duplicates when a parser is re-run', () => {
    events.replaceForMessage(messageId, 'nike-order', [orderEvent()], '2026-08-18T10:01:00Z')
    const corrected = events.replaceForMessage(
      messageId,
      'nike-order',
      [orderEvent({ payload: { totalMinor: 24500, currency: 'EUR' } })],
      '2026-08-18T12:00:00Z',
    )
    expect(corrected).toHaveLength(1)
    expect(events.listUnreconciled()).toHaveLength(1)
    expect(corrected[0]!.payload).toEqual({ totalMinor: 24500, currency: 'EUR' })
  })

  it('leaves another parser\'s events on the same message untouched', () => {
    events.replaceForMessage(messageId, 'nike-order', [orderEvent()], '2026-08-18T10:01:00Z')
    events.replaceForMessage(
      messageId, 'nike-ship', [orderEvent({ type: 'shipped' })], '2026-08-18T10:02:00Z',
    )
    events.replaceForMessage(messageId, 'nike-order', [orderEvent()], '2026-08-18T13:00:00Z')
    expect(events.listUnreconciled()).toHaveLength(2)
  })

  it('drops to zero events when a corrected parser extracts nothing', () => {
    events.replaceForMessage(messageId, 'nike-order', [orderEvent()], '2026-08-18T10:01:00Z')
    events.replaceForMessage(messageId, 'nike-order', [], '2026-08-18T14:00:00Z')
    expect(events.listUnreconciled()).toHaveLength(0)
  })
})

describe('EventRepo queries', () => {
  it('finds events by retailer and order reference', () => {
    events.replaceForMessage(messageId, 'nike-order', [orderEvent()], '2026-08-18T10:01:00Z')
    expect(events.findByOrder('nike', 'C012345678')).toHaveLength(1)
    expect(events.findByOrder('nike', 'OTHER')).toHaveLength(0)
  })

  it('excludes reconciled events from the unreconciled list', () => {
    const [stored] = events.replaceForMessage(
      messageId, 'nike-order', [orderEvent()], '2026-08-18T10:01:00Z',
    )
    events.markReconciled(stored!.id, '2026-08-18T10:05:00Z')
    expect(events.listUnreconciled()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/repos/events.test.ts`
Expected: FAIL — cannot resolve `./events.js`.

- [ ] **Step 3: Write the repository**

Create `src/core/repos/events.ts`:

```ts
import { createHash } from 'node:crypto'
import type { Db } from '../db/connection.js'
import type { EventType } from '../types.js'

export interface ParsedEvent {
  type: EventType
  retailer: string
  externalOrderId: string | null
  occurredAt: string
  payload: Record<string, unknown>
}

export interface StoredEvent extends ParsedEvent {
  id: string
  messageId: string
  parserId: string
  reconciledAt: string | null
}

interface EventRow {
  id: string
  message_id: string
  parser_id: string
  type: EventType
  retailer: string
  external_order_id: string | null
  occurred_at: string
  payload_json: string
  reconciled_at: string | null
}

function toEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    messageId: row.message_id,
    parserId: row.parser_id,
    type: row.type,
    retailer: row.retailer,
    externalOrderId: row.external_order_id,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    reconciledAt: row.reconciled_at,
  }
}

export function eventId(messageId: string, parserId: string, ordinal: number): string {
  return createHash('sha256')
    .update(`${messageId} ${parserId} ${ordinal}`)
    .digest('hex')
}

export class EventRepo {
  constructor(private readonly db: Db) {}

  replaceForMessage(
    messageId: string,
    parserId: string,
    events: ParsedEvent[],
    now: string,
  ): StoredEvent[] {
    const stored: StoredEvent[] = events.map((event, ordinal) => ({
      ...event,
      id: eventId(messageId, parserId, ordinal),
      messageId,
      parserId,
      reconciledAt: null,
    }))

    const run = this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM events WHERE message_id = ? AND parser_id = ?')
        .run(messageId, parserId)

      const insert = this.db.prepare(
        `INSERT INTO events
          (id, message_id, parser_id, type, retailer, external_order_id,
           occurred_at, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const event of stored) {
        insert.run(
          event.id,
          messageId,
          parserId,
          event.type,
          event.retailer,
          event.externalOrderId,
          event.occurredAt,
          JSON.stringify(event.payload),
          now,
        )
      }
    })
    run()

    // Returned in the order the parser emitted them. Re-querying would order by
    // hashed id, which is arbitrary once a parser emits more than one event.
    return stored
  }

  listUnreconciled(): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE reconciled_at IS NULL ORDER BY occurred_at')
      .all() as EventRow[]
    return rows.map(toEvent)
  }

  findByOrder(retailer: string, externalOrderId: string): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE retailer = ? AND external_order_id = ? ORDER BY occurred_at')
      .all(retailer, externalOrderId) as EventRow[]
    return rows.map(toEvent)
  }

  markReconciled(id: string, at: string): void {
    this.db.prepare('UPDATE events SET reconciled_at = ? WHERE id = ?').run(at, id)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/core/repos/events.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Run the whole suite and the typechecker**

Run: `npm test && npm run typecheck`
Expected: all tests PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/repos/events.ts src/core/repos/events.test.ts
git commit -m "feat: event repository with deterministic identity for safe replay"
```

---

## What This Plan Deliberately Excludes

These belong to later plans and must not be built here:

- IMAP connection and mailbox polling (Plan 2)
- Parser registry and retailer parsers (Plan 2)
- The reconciler and inventory entity transitions (Plan 3)
- Carrier tracking and Discord notifications (Plan 4)
- Electron shell, IPC and the React UI (Plan 5)

## Known Risk Carried Forward

`better-sqlite3` is a native module. It installs from prebuilds under plain Node on this machine (verified: SQLite 3.53.4). Electron uses a different ABI, so Plan 5 must include a task that runs `@electron/rebuild` and verifies the database opens inside the Electron main process before any UI work depends on it.
