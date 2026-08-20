import { useEffect, useState } from 'react'
import { api, type PurchaseView } from '../api.js'
import { Pager, usePaged } from '../Pager.js'
import { SkeletonTable } from '../Skeleton.js'
import { ContextMenu, useContextMenu } from '../ContextMenu.js'
import { Confirm } from '../Confirm.js'

// Sized to fit the page rather than to be scrolled sideways: the last column
// is the one that gets cut, and "no matching order" is the one you most need
// to read.
// The address an order was sent to is the point of the last column — an alias
// per account is common — so it gets the width to be read.
const COLUMNS = '54px 62px 104px 74px minmax(130px,1fr) 34px 72px 74px 80px 96px 168px'

const STATUS_COLOR: Record<string, string> = {
  pending: 'oklch(0.68 0.02 265)',
  confirmed: 'oklch(0.76 0.11 225)',
  shipped: 'oklch(0.78 0.11 195)',
  delivered: 'oklch(0.78 0.12 148)',
  cancelled: 'oklch(0.62 0.015 265)',
  refunded: 'oklch(0.74 0.10 60)',
  // Part of an order gone, the rest still standing.
  partly_cancelled: 'oklch(0.68 0.06 300)',
  partly_refunded: 'oklch(0.74 0.12 40)',
  partially_refunded: 'oklch(0.74 0.12 40)',
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  partly_cancelled: 'Part. cancelled',
  partly_refunded: 'Part. returned',
  partially_refunded: 'Part. refunded',
}

export function Purchases({ query, dataVersion }: { query: string; dataVersion: number }) {
  const [rows, setRows] = useState<PurchaseView[] | null>(null)
  const [kindFilter, setKindFilter] = useState<'all' | 'buy' | 'cancel'>('all')
  const [confirming, setConfirming] = useState<PurchaseView | null>(null)
  const { menu, open, close } = useContextMenu()

  const load = () => {
    void api.purchases().then(setRows)
  }

  useEffect(load, [dataVersion])

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

  if (!rows) return <SkeletonTable columns={COLUMNS} minWidth={995} rows={10} />

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
    <div className="screen">
      <ContextMenu menu={menu} onClose={close} />

      {confirming && (
        <Confirm
          title={confirming.kind === 'cancel' ? 'Delete cancellation' : 'Delete order'}
          destructive
          confirmLabel="Delete"
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            const target = confirming
            setConfirming(null)
            await api.deleteRecord('purchase', target.id)
            load()
          }}
          body={
            <>
              Remove <strong>{confirming.reference ?? confirming.retailer}</strong>? Its units and
              any expected refund go with it, and re-reading mail will not bring it back.
            </>
          }
        />
      )}

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
          <div className="thead" style={{ minWidth: 995, gridTemplateColumns: COLUMNS }}>
            <div>Type</div><div>Retailer</div><div>Order ref</div><div>Date</div><div>Item</div>
            <div style={{ textAlign: 'right' }}>Qty</div>
            <div style={{ textAlign: 'right' }}>Unit</div>
            <div style={{ textAlign: 'right' }}>Shipping</div>
            <div style={{ textAlign: 'right' }}>Total</div>
            <div>Status</div>
            <div>Email</div>
          </div>

          <div className="table-scroll-y">
          {paged.visible.map((row) => {
            const isCancel = row.kind === 'cancel'
            const statusColor = STATUS_COLOR[row.status] ?? '#8d94a6'
            return (
              <div
                key={row.id}
                className="trow"
                style={{ minWidth: 995, gridTemplateColumns: COLUMNS, cursor: 'default' }}
                onContextMenu={(event) =>
                  open(event, row.reference ?? row.retailer, [
                    {
                      label: 'Copy order reference',
                      disabled: !row.reference,
                      onSelect: () => void navigator.clipboard.writeText(row.reference ?? ''),
                    },
                    {
                      label: isCancel ? 'Delete cancellation' : 'Delete order and its units',
                      destructive: true,
                      onSelect: () => setConfirming(row),
                    },
                  ])}
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  {/* The mailbox this order came in on: the mail is where the
                      row came from, and with more than one account connected it
                      is the difference between two of them buying the same
                      thing. */}
                  <span
                    className="mono"
                    style={{ fontSize: 11, display: 'flex', minWidth: 0, whiteSpace: 'nowrap' }}
                    title={[row.mailbox, row.mailSubject].filter(Boolean).join(' — ')}
                  >
                    {/* The part before the @ identifies which alias ordered,
                        so it is the part that must survive a narrow column. */}
                    {/* Both halves may shrink — a grid track will otherwise be
                        pushed wider by a long address and take the table with
                        it — but the domain gives way first. */}
                    <span
                      style={{
                        color: 'var(--text-muted)', minWidth: 0, flexShrink: 1,
                        overflow: 'hidden', textOverflow: 'ellipsis',
                      }}
                    >
                      {(row.mailbox ?? '—').split('@')[0]}
                    </span>
                    {row.mailbox?.includes('@') && (
                      <span
                        style={{
                          color: 'var(--text-ghost)', minWidth: 0, flexShrink: 3,
                          overflow: 'hidden', textOverflow: 'ellipsis',
                        }}
                      >
                        @{row.mailbox.split('@')[1]}
                      </span>
                    )}
                  </span>
                  {/* Only worth saying when something is wrong. That an order's
                      parts add up is the ordinary case, and saying so on every
                      row is noise. */}
                  {isCancel && (
                    <span style={{ fontSize: 11, color: 'var(--text-ghost)' }}>
                      no matching order
                    </span>
                  )}
                  {!isCancel && !row.totalsConsistent && (
                    <span
                      style={{ fontSize: 11, color: 'var(--warm)' }}
                      title="Quantity times the unit price plus postage does not equal the stated total, so something was read from the wrong line."
                    >
                      totals disagree
                    </span>
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
