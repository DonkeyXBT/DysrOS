import { useEffect, useState } from 'react'
import { api, type PurchaseView } from '../api.js'
import { Pager, usePaged } from '../Pager.js'

const COLUMNS = '62px 104px 126px 92px minmax(170px,1fr) 44px 86px 86px 92px 116px 112px'

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
  const [rows, setRows] = useState<PurchaseView[] | null>(null)
  const [kindFilter, setKindFilter] = useState<'all' | 'buy' | 'cancel'>('all')

  useEffect(() => {
    void api.purchases().then(setRows)
  }, [])

  const all = rows ?? []
  const term = query.trim().toLowerCase()
  const filtered = all
    .filter((row) => kindFilter === 'all' || row.kind === kindFilter)
    .filter((row) =>
      !term
      || (row.title ?? '').toLowerCase().includes(term)
      || (row.reference ?? '').toLowerCase().includes(term)
      || row.retailer.toLowerCase().includes(term))

  // Hooks must run on every render, so paging is computed before the early
  // returns below rather than after them.
  const paged = usePaged(filtered, `${kindFilter}|${term}`)

  if (!rows) return <div className="empty"><span className="empty-body">Loading…</span></div>

  if (rows.length === 0) {
    return (
      <div className="empty" style={{ margin: '60px auto' }}>
        <div className="empty-title">No orders yet</div>
        <div className="empty-body">
          Sync a mailbox and every order and cancellation in it appears here.
        </div>
      </div>
    )
  }

  const counts = {
    all: rows.length,
    buy: rows.filter((r) => r.kind === 'buy').length,
    cancel: rows.filter((r) => r.kind === 'cancel').length,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        {(['all', 'buy', 'cancel'] as const).map((kind) => (
          <button
            key={kind}
            className="btn"
            onClick={() => setKindFilter(kind)}
            style={
              kindFilter === kind
                ? { background: '#242c3e', color: 'var(--text)', borderColor: '#3a4a6a' }
                : undefined
            }
          >
            {kind === 'all' ? 'All' : kind === 'buy' ? 'Buys' : 'Cancels'}{' '}
            <span className="mono" style={{ opacity: .6 }}>{counts[kind]}</span>
          </button>
        ))}
      </div>

      <div className="table">
        <div className="table-scroll">
          <div className="thead" style={{ minWidth: 1050, gridTemplateColumns: COLUMNS }}>
            <div>Type</div><div>Retailer</div><div>Order ref</div><div>Date</div><div>Item</div>
            <div style={{ textAlign: 'right' }}>Qty</div>
            <div style={{ textAlign: 'right' }}>Unit</div>
            <div style={{ textAlign: 'right' }}>Shipping</div>
            <div style={{ textAlign: 'right' }}>Total</div>
            <div>Status</div>
            <div>Checks</div>
          </div>

          {paged.visible.map((row) => {
            const isCancel = row.kind === 'cancel'
            const statusColor = STATUS_COLOR[row.status] ?? '#8d94a6'
            return (
              <div
                key={row.id}
                className="trow"
                style={{ minWidth: 1050, gridTemplateColumns: COLUMNS }}
              >
                <div>
                  <span
                    className="chip"
                    style={{
                      color: isCancel ? 'var(--pink)' : 'var(--teal)',
                      background: isCancel
                        ? 'color-mix(in oklab, var(--pink) 14%, transparent)'
                        : 'color-mix(in oklab, var(--teal) 14%, transparent)',
                      border: `1px solid ${isCancel
                        ? 'color-mix(in oklab, var(--pink) 32%, transparent)'
                        : 'color-mix(in oklab, var(--teal) 32%, transparent)'}`,
                      padding: '3px 9px',
                    }}
                  >
                    {isCancel ? 'Cancel' : 'Buy'}
                  </span>
                </div>
                <div style={{ fontWeight: 600 }}>{row.retailer}</div>
                <div className="cell-mono">{row.reference ?? '—'}</div>
                <div className="cell-mono">{row.orderedAt.slice(0, 10)}</div>
                <div
                  style={{
                    fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap',
                    overflow: 'hidden', textOverflow: 'ellipsis',
                  }}
                >
                  {row.title ?? '—'}
                </div>
                <div className="cell-right">{isCancel ? '—' : row.quantity}</div>
                <div className="cell-right" style={{ color: 'var(--text-muted)' }}>{row.unit}</div>
                <div className="cell-right" style={{ color: 'var(--text-muted)' }}>{row.shipping}</div>
                <div className="cell-right" style={{ fontSize: 12.5, fontWeight: 600 }}>
                  {row.total}
                </div>
                <div>
                  <span
                    className="chip"
                    style={{
                      color: statusColor,
                      background: `color-mix(in oklab, ${statusColor} 14%, transparent)`,
                      border: `1px solid color-mix(in oklab, ${statusColor} 30%, transparent)`,
                    }}
                  >
                    {STATUS_LABEL[row.status] ?? row.status}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {isCancel ? (
                    <span style={{ fontSize: 11, color: 'var(--text-ghost)' }}>
                      no matching order
                    </span>
                  ) : row.totalsConsistent ? (
                    <span style={{ fontSize: 11, color: 'var(--teal)' }}>totals check out</span>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--warm)' }}>totals disagree</span>
                  )}
                  {row.refundOutstanding && (
                    <span className="mono" style={{ fontSize: 11, color: 'var(--pink)' }}>
                      {row.refundOutstanding} refund due
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <Pager
        page={paged.page}
        pageCount={paged.pageCount}
        from={paged.from}
        to={paged.to}
        total={paged.total}
        noun="rows"
        onPage={paged.setPage}
      />

      <div style={{ fontSize: 11, color: 'var(--text-ghost)', paddingLeft: 4 }}>
        A Cancel row is a cancellation whose original order has not been seen yet; once it
        arrives, the two merge into one Buy row marked cancelled.
      </div>
    </div>
  )
}
