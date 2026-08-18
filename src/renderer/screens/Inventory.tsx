import { useEffect, useState } from 'react'
import { api, type ItemView } from '../api.js'
import { Pager, usePaged } from '../Pager.js'
import { SkeletonTable } from '../Skeleton.js'

const COLUMNS = 'minmax(200px,2fr) 104px 118px 92px 96px 130px 96px 116px'

/** The item pipeline, roughly in order. Cancelled and returned are reversals
 *  and read as exceptions rather than as further steps forward. */
const STATUS: Record<string, { label: string; hue: number; muted?: boolean }> = {
  incoming: { label: 'Incoming', hue: 285 },
  in_stock: { label: 'In stock', hue: 250 },
  listed: { label: 'Listed', hue: 225 },
  sold: { label: 'Sold', hue: 195 },
  shipped_to_buyer: { label: 'Shipped', hue: 170 },
  delivered: { label: 'Delivered', hue: 148 },
  cancelled: { label: 'Cancelled', hue: 265, muted: true },
  returned: { label: 'Returned', hue: 25, muted: true },
}

function statusColour(status: string): string {
  const entry = STATUS[status]
  if (!entry) return 'oklch(0.68 0.02 265)'
  return entry.muted ? 'oklch(0.60 0.015 265)' : `oklch(0.76 0.13 ${entry.hue})`
}

export function Inventory({ query, dataVersion }: { query: string; dataVersion: number }) {
  const [items, setItems] = useState<ItemView[] | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('all')

  useEffect(() => {
    void api.inventory().then(setItems)
  }, [dataVersion])

  const all = items ?? []
  const term = query.trim().toLowerCase()
  const filtered = all
    .filter((item) => statusFilter === 'all' || item.status === statusFilter)
    .filter((item) =>
      !term
      || item.title.toLowerCase().includes(term)
      || (item.orderRef ?? '').toLowerCase().includes(term)
      || (item.trackingNumber ?? '').toLowerCase().includes(term))

  const paged = usePaged(filtered, `${statusFilter}|${term}`)

  if (!items) return <SkeletonTable columns={COLUMNS} minWidth={1000} rows={10} />

  if (all.length === 0) {
    return (
      <div className="empty" style={{ margin: '60px auto' }}>
        <div className="empty-title">No stock yet</div>
        <div className="empty-body">
          Every unit of every order becomes a row here. Sync a mailbox, and an order for three
          of something becomes three rows, each with its own cost.
        </div>
      </div>
    )
  }

  const counts = all.reduce<Record<string, number>>((totals, item) => {
    totals[item.status] = (totals[item.status] ?? 0) + 1
    return totals
  }, {})

  const held = all.filter((item) => ['incoming', 'in_stock', 'listed'].includes(item.status))
  const capital = held.reduce((sum, item) => sum + item.costMinor, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <button
          className="btn"
          onClick={() => setStatusFilter('all')}
          style={statusFilter === 'all'
            ? { background: '#242c3e', color: 'var(--text)', borderColor: '#3a4a6a' }
            : undefined}
        >
          All <span className="mono" style={{ opacity: .6 }}>{all.length}</span>
        </button>
        {Object.entries(STATUS)
          .filter(([status]) => counts[status])
          .map(([status, meta]) => (
            <button
              key={status}
              className="btn"
              onClick={() => setStatusFilter(status)}
              style={statusFilter === status
                ? { background: '#242c3e', color: 'var(--text)', borderColor: '#3a4a6a' }
                : undefined}
            >
              <span
                className="chip-dot"
                style={{ background: statusColour(status), marginRight: 6, display: 'inline-block' }}
              />
              {meta.label} <span className="mono" style={{ opacity: .6 }}>{counts[status]}</span>
            </button>
          ))}
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
          {held.length} held · €{(capital / 100).toFixed(2)} tied up
        </span>
      </div>

      <div className="table">
        <div className="table-scroll">
          <div className="thead" style={{ minWidth: 1000, gridTemplateColumns: COLUMNS }}>
            <div>Item</div><div>Status</div><div>Order</div><div>Retailer</div>
            <div style={{ textAlign: 'right' }}>Cost</div>
            <div>Parcel</div><div>Bought</div><div>Expected</div>
          </div>

          {paged.visible.map((item) => (
            <div
              key={item.id}
              className="trow"
              style={{ minWidth: 1000, gridTemplateColumns: COLUMNS, cursor: 'default' }}
            >
              <div
                style={{
                  fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                }}
              >
                {item.title}
              </div>
              <div>
                <span
                  className="chip"
                  style={{
                    color: statusColour(item.status),
                    background: `color-mix(in oklab, ${statusColour(item.status)} 14%, transparent)`,
                    border: `1px solid color-mix(in oklab, ${statusColour(item.status)} 30%, transparent)`,
                  }}
                >
                  <span className="chip-dot" style={{ background: statusColour(item.status) }} />
                  {STATUS[item.status]?.label ?? item.status}
                </span>
              </div>
              <div className="cell-mono">{item.orderRef ?? '—'}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{item.retailer ?? '—'}</div>
              <div className="cell-right">{item.cost}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-dim)', minWidth: 0 }}>
                {item.carrier ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        fontSize: 9, fontWeight: 800, borderRadius: 4, padding: '1px 4px',
                        background: 'var(--raised)', color: 'var(--text-mid)',
                      }}
                    >
                      {item.carrier.toUpperCase()}
                    </span>
                    <span
                      className="mono"
                      style={{
                        fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {item.trackingNumber ?? 'no code yet'}
                    </span>
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-ghost)' }}>not shipped</span>
                )}
              </div>
              <div className="cell-mono">{item.purchasedAt?.slice(0, 10) ?? '—'}</div>
              <div className="cell-mono">{item.expectedDeliveryAt ?? '—'}</div>
            </div>
          ))}
        </div>
      </div>

      <Pager
        page={paged.page}
        pageCount={paged.pageCount}
        from={paged.from}
        to={paged.to}
        total={paged.total}
        noun="units"
        onPage={paged.setPage}
      />

      <div style={{ fontSize: 11, color: 'var(--text-ghost)', paddingLeft: 4 }}>
        One row per physical unit, so an order for three of something is three rows, each with its
        own cost basis. Parcel details come from the shipment matched to that order.
      </div>
    </div>
  )
}
