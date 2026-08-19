import type Database from 'better-sqlite3'

/**
 * One parcel, one row.
 *
 * A parcel is announced more than once — handed to the carrier, out for
 * delivery, delivered — and each mail is its own event, so each first arrives
 * as its own shipment row with no barcode yet. The moment two of those rows
 * resolve to the same barcode they are the same parcel, and the database says
 * so with a unique index. Left alone that surfaces as a crash mid-sync
 * (`UNIQUE constraint failed: shipments.carrier, shipments.tracking_number`)
 * and, before the crash, as the same parcel listed twice.
 *
 * So they are folded: the row that got there first is kept, everything the
 * later row learned is carried across, and the duplicate goes.
 */

/** How far along a parcel is, least to most. A later mail may say less than an
 *  earlier one — a delivered parcel never goes back to being in transit. */
const PROGRESS = ['pending', 'in_transit', 'out_for_delivery', 'delivered']

export function furthestStatus(a: string | null, b: string | null): string {
  const rank = (status: string | null) => PROGRESS.indexOf(status ?? 'pending')
  return rank(b) > rank(a) ? (b ?? 'pending') : (a ?? 'pending')
}

/** The row already holding this barcode, if it is not the one asking. */
export function findParcel(
  db: Database.Database,
  carrier: string,
  trackingNumber: string,
  exceptId: string,
): string | null {
  const row = db
    .prepare('SELECT id FROM shipments WHERE carrier = ? AND tracking_number = ? AND id != ?')
    .get(carrier, trackingNumber, exceptId) as { id: string } | undefined
  return row?.id ?? null
}

export interface ShipmentFacts {
  status?: string | null
  purchaseId?: string | null
  trackingUrl?: string | null
  postalCode?: string | null
  expectedDeliveryAt?: string | null
  lastPolledAt?: string | null
}

/**
 * Carries what a duplicate knows into the row that keeps the barcode.
 *
 * Nothing already known is overwritten by a blank, and the status only ever
 * moves forward.
 */
export function mergeInto(
  db: Database.Database,
  keepId: string,
  facts: ShipmentFacts,
): void {
  const current = db
    .prepare('SELECT status FROM shipments WHERE id = ?')
    .get(keepId) as { status: string } | undefined
  if (!current) return

  db.prepare(
    `UPDATE shipments
     SET status = ?,
         purchase_id = COALESCE(purchase_id, ?),
         tracking_url = COALESCE(?, tracking_url),
         postal_code = COALESCE(?, postal_code),
         expected_delivery_at = COALESCE(?, expected_delivery_at),
         last_polled_at = COALESCE(?, last_polled_at)
     WHERE id = ?`,
  ).run(
    furthestStatus(current.status, facts.status ?? null),
    facts.purchaseId ?? null,
    facts.trackingUrl ?? null,
    facts.postalCode ?? null,
    facts.expectedDeliveryAt ?? null,
    facts.lastPolledAt ?? null,
    keepId,
  )
}

/** Folds one shipment row into another and removes the duplicate. */
export function foldShipment(db: Database.Database, duplicateId: string, keepId: string): void {
  const duplicate = db
    .prepare(
      `SELECT status, purchase_id, tracking_url, postal_code, expected_delivery_at, last_polled_at
       FROM shipments WHERE id = ?`,
    )
    .get(duplicateId) as Record<string, string | null> | undefined
  if (!duplicate) return

  mergeInto(db, keepId, {
    status: duplicate.status ?? null,
    purchaseId: duplicate.purchase_id ?? null,
    trackingUrl: duplicate.tracking_url ?? null,
    postalCode: duplicate.postal_code ?? null,
    expectedDeliveryAt: duplicate.expected_delivery_at ?? null,
    lastPolledAt: duplicate.last_polled_at ?? null,
  })
  db.prepare('DELETE FROM shipments WHERE id = ?').run(duplicateId)
}
