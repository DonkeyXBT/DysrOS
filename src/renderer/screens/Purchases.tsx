import { useEffect, useState } from 'react'
import { api, type CancellationView, type PurchaseView } from '../api.js'

const COLUMNS = '110px 130px 96px minmax(170px,1fr) 46px 88px 88px 94px 118px 110px'

const STATUS_COLOR: Record<string, string> = {
  pending: 'oklch(0.68 0.02 265)',
  confirmed: 'oklch(0.76 0.11 225)',
  shipped: 'oklch(0.78 0.11 195)',
  delivered: 'oklch(0.78 0.12 148)',
  cancelled: 'oklch(0.62 0.015 265)',
  refunded: 'oklch(0.74 0.10 60)',
  partially_refunded: 'oklch(0.74 0.12 40)',
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  partially_refunded: 'Part. refunded',
}

export function Purchases({ query }: { query: string }) {
  const [purchases, setPurchases] = useState<PurchaseView[] | null>(null)
  const [cancellations, setCancellations] = useState<CancellationView[]>([])

  useEffect(() => {
    void api.purchases().then(setPurchases)
    void api.cancellations().then(setCancellations)
  }, [])

  if (!purchases) return <div className="empty"><span className="empty-body">Loading…</span></div>

  const term = query.trim().toLowerCase()
  const rows = term
    ? purchases.filter(
        (p) =>
          (p.title ?? '').toLowerCase().includes(term) ||
          (p.reference ?? '').toLowerCase().includes(term) ||
          p.retailer.toLowerCase().includes(term),
      )
    : purchases

  if (purchases.length === 0 && cancellations.length === 0) {
    return (
      <div className="empty" style={{ margin: '60px auto' }}>
        <div className="empty-title">No orders yet</div>
        <div className="empty-body">Import an order confirmation and it appears here.</div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {cancellations.length > 0 && (
        <section className="section" style={{ padding: '14px 16px' }}>
          <div className="section-head">
            <h2>Cancellations</h2>
            <span className="section-note">
              bol.com states no amount in these, so a refund value has to come from the original order
            </span>
          </div>
          {cancellations.map((cancellation) => (
            <div
              key={cancellation.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0',
                borderTop: '1px solid var(--border-soft)', fontSize: 12.5,
              }}
            >
              <span className="mono" style={{ color: 'var(--text-dim)', width: 110 }}>
                {cancellation.reference ?? '—'}
              </span>
              <span style={{ flex: 1, color: 'var(--text-muted)' }}>
                {cancellation.title ?? '—'}
              </span>
              {cancellation.refundExpected && (
                <span
                  className="chip"
                  style={{
                    color: 'oklch(0.74 0.10 60)',
                    background: 'color-mix(in oklab, oklch(0.74 0.10 60) 14%, transparent)',
                    border: '1px solid color-mix(in oklab, oklch(0.74 0.10 60) 30%, transparent)',
                  }}
                >
                  refund expected
                </span>
              )}
              {!purchases.some((p) => p.reference === cancellation.reference) && (
                <span style={{ fontSize: 11, color: 'var(--text-ghost)' }}>
                  no matching order imported
                </span>
              )}
            </div>
          ))}
        </section>
      )}

      <div className="table">
        <div className="table-scroll">
          <div className="thead" style={{ minWidth: 990, gridTemplateColumns: COLUMNS }}>
            <div>Retailer</div><div>Order ref</div><div>Ordered</div><div>Item</div>
            <div style={{ textAlign: 'right' }}>Qty</div>
            <div style={{ textAlign: 'right' }}>Unit</div>
            <div style={{ textAlign: 'right' }}>Shipping</div>
            <div style={{ textAlign: 'right' }}>Total</div>
            <div>Status</div>
            <div>Checks</div>
          </div>
          {rows.map((purchase) => (
            <div
              key={purchase.id}
              className="trow"
              style={{ minWidth: 990, gridTemplateColumns: COLUMNS }}
            >
              <div style={{ fontWeight: 600 }}>{purchase.retailer}</div>
              <div className="cell-mono">{purchase.reference ?? '—'}</div>
              <div className="cell-mono">{purchase.orderedAt.slice(0, 10)}</div>
              <div
                style={{
                  fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                }}
              >
                {purchase.title ?? '—'}
              </div>
              <div className="cell-right">{purchase.quantity}</div>
              <div className="cell-right" style={{ color: 'var(--text-muted)' }}>{purchase.unit}</div>
              <div className="cell-right" style={{ color: 'var(--text-muted)' }}>{purchase.shipping}</div>
              <div className="cell-right" style={{ fontSize: 12.5, fontWeight: 600 }}>
                {purchase.total}
              </div>
              <div>
                <span
                  className="chip"
                  style={{
                    color: STATUS_COLOR[purchase.status] ?? 'var(--text-dim)',
                    background: `color-mix(in oklab, ${STATUS_COLOR[purchase.status] ?? '#8d94a6'} 14%, transparent)`,
                    border: `1px solid color-mix(in oklab, ${STATUS_COLOR[purchase.status] ?? '#8d94a6'} 30%, transparent)`,
                  }}
                >
                  {STATUS_LABEL[purchase.status] ?? purchase.status}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {purchase.totalsConsistent ? (
                  <span style={{ fontSize: 11, color: 'var(--teal)' }}>totals check out</span>
                ) : (
                  <span style={{ fontSize: 11, color: 'var(--warm)' }}>totals disagree</span>
                )}
                {purchase.refundOutstanding && (
                  <span className="mono" style={{ fontSize: 11, color: 'var(--pink)' }}>
                    {purchase.refundOutstanding} refund due
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-ghost)', paddingLeft: 4 }}>
        "totals check out" means quantity x unit + shipping equalled the total the retailer stated
      </div>
    </div>
  )
}
