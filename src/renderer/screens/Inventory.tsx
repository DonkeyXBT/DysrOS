import { useEffect, useMemo, useState } from 'react'
import { api, type ItemView } from '../api.js'
import { Pager, usePaged } from '../Pager.js'
import { SkeletonTable } from '../Skeleton.js'
import { ContextMenu, useContextMenu } from '../ContextMenu.js'
import { Confirm } from '../Confirm.js'

/** The design's column set: selection, thumbnail, then the item's facts. */
const COLUMNS =
  '26px 34px minmax(190px,2fr) 96px 60px 118px 92px 84px 84px 84px 62px 84px 96px'
const MIN_WIDTH = 1250

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

type SortKey = 'title' | 'brand' | 'size' | 'status' | 'purchasedAt' | 'cost' | 'daysHeld' | 'retailer'

const HEADERS: { key: SortKey | null; label: string; right?: boolean }[] = [
  { key: 'title', label: 'Item' },
  { key: 'brand', label: 'Brand' },
  { key: 'size', label: 'Size' },
  { key: 'status', label: 'Status' },
  { key: null, label: 'Parcel' },
  { key: 'purchasedAt', label: 'Bought' },
  { key: 'cost', label: 'Cost', right: true },
  { key: null, label: 'Listed', right: true },
  { key: 'daysHeld', label: 'Days', right: true },
  { key: null, label: 'Location' },
  { key: 'retailer', label: 'Retailer' },
]

export function Inventory({ query, dataVersion }: { query: string; dataVersion: number }) {
  const [items, setItems] = useState<ItemView[] | null>(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'purchasedAt', dir: 'desc',
  })
  const [selected, setSelected] = useState<string[]>([])
  const [confirming, setConfirming] = useState<ItemView | null>(null)
  const { menu, open, close } = useContextMenu()

  const load = () => {
    void api.inventory().then(setItems)
  }

  useEffect(load, [dataVersion])

  const all = useMemo(() => items ?? [], [items])
  const term = query.trim().toLowerCase()

  const filtered = useMemo(() => {
    const rows = all
      .filter((item) => statusFilter === 'all' || item.status === statusFilter)
      .filter((item) =>
        !term
        || item.title.toLowerCase().includes(term)
        || (item.orderRef ?? '').toLowerCase().includes(term)
        || (item.trackingNumber ?? '').toLowerCase().includes(term))

    const direction = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const pick = (item: ItemView): string | number => {
        switch (sort.key) {
          case 'cost': return item.costMinor
          case 'daysHeld': return item.daysHeld ?? -1
          case 'purchasedAt': return item.purchasedAt ?? ''
          case 'brand': return item.brand ?? ''
          case 'size': return item.size ?? ''
          case 'retailer': return item.retailer ?? ''
          case 'status': return item.status
          default: return item.title.toLowerCase()
        }
      }
      const left = pick(a)
      const right = pick(b)
      return (left > right ? 1 : left < right ? -1 : 0) * direction
    })
  }, [all, statusFilter, term, sort])

  const paged = usePaged(filtered, `${statusFilter}|${term}|${sort.key}${sort.dir}`)

  if (!items) return <SkeletonTable columns={COLUMNS} minWidth={MIN_WIDTH} rows={12} />

  if (all.length === 0) {
    return (
      <div className="empty" style={{ margin: '60px auto' }}>
        <div className="empty-title">No stock yet</div>
        <div className="empty-body">
          Every unit of every order becomes a row here. An order for three of something becomes
          three rows, each with its own cost.
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

  const remove = async (item: ItemView) => {
    await api.deleteRecord('item', item.id)
    setSelected((current) => current.filter((id) => id !== item.id))
    load()
  }

  return (
    <div className="screen">
      <ContextMenu menu={menu} onClose={close} />

      {confirming && (
        <Confirm
          title="Delete unit"
          destructive
          confirmLabel="Delete"
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const target = confirming
            setConfirming(null)
            void remove(target)
          }}
          body={
            <>
              Remove <strong>{confirming.title}</strong> from inventory? The order it came from
              stays; only this unit goes.
            </>
          }
        />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <Chip active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>
          All <span className="mono" style={{ opacity: .6 }}>{all.length}</span>
        </Chip>
        {Object.entries(STATUS)
          .filter(([status]) => counts[status])
          .map(([status, meta]) => (
            <Chip
              key={status}
              active={statusFilter === status}
              onClick={() => setStatusFilter(status)}
            >
              <span
                className="chip-dot"
                style={{ background: statusColour(status), marginRight: 6, display: 'inline-block' }}
              />
              {meta.label} <span className="mono" style={{ opacity: .6 }}>{counts[status]}</span>
            </Chip>
          ))}
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
          {held.length} held · €{(capital / 100).toFixed(2)} tied up
        </span>
      </div>

      {selected.length > 0 && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px',
            borderRadius: 14, background: 'rgba(91,140,255,.10)', border: '1px solid #2b3a5e',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent-bright)' }}>
            {selected.length} selected
          </span>
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <button
              className="btn"
              style={{ color: 'var(--pink)', borderColor: '#43303a' }}
              onClick={async () => {
                for (const id of selected) await api.deleteRecord('item', id)
                setSelected([])
                load()
              }}
            >
              Delete {selected.length}
            </button>
            <button className="btn" onClick={() => setSelected([])}>Clear</button>
          </div>
        </div>
      )}

      <div className="table">
        <div className="table-scroll">
          <div className="thead" style={{ minWidth: MIN_WIDTH, gridTemplateColumns: COLUMNS }}>
            <div />
            <div />
            {HEADERS.map((header) => (
              <button
                key={header.label}
                onClick={() => {
                  if (!header.key) return
                  setSort((current) => ({
                    key: header.key!,
                    dir: current.key === header.key && current.dir === 'desc' ? 'asc' : 'desc',
                  }))
                }}
                style={{
                  border: 0, background: 'transparent', padding: 0,
                  fontFamily: 'inherit', fontSize: 10, fontWeight: 700,
                  letterSpacing: '.07em', textTransform: 'uppercase',
                  textAlign: header.right ? 'right' : 'left',
                  cursor: header.key ? 'pointer' : 'default',
                  color: sort.key === header.key ? 'var(--text-mid)' : 'var(--text-faint)',
                }}
              >
                {header.label}
                {sort.key === header.key && (sort.dir === 'asc' ? ' ↑' : ' ↓')}
              </button>
            ))}
          </div>

          <div className="table-scroll-y">
            {paged.visible.map((item) => {
              const checked = selected.includes(item.id)
              return (
                <div
                  key={item.id}
                  className="trow"
                  style={{ minWidth: MIN_WIDTH, gridTemplateColumns: COLUMNS, cursor: 'default' }}
                  onContextMenu={(event) =>
                    open(event, item.title, [
                      {
                        label: checked ? 'Deselect' : 'Select',
                        onSelect: () => setSelected((current) =>
                          checked ? current.filter((id) => id !== item.id) : [...current, item.id]),
                      },
                      {
                        label: 'Copy order reference',
                        disabled: !item.orderRef,
                        onSelect: () => void navigator.clipboard.writeText(item.orderRef ?? ''),
                      },
                      {
                        label: 'Delete unit',
                        destructive: true,
                        onSelect: () => setConfirming(item),
                      },
                    ])}
                >
                  <button
                    onClick={() => setSelected((current) =>
                      checked ? current.filter((id) => id !== item.id) : [...current, item.id])}
                    aria-label={checked ? 'Deselect' : 'Select'}
                    style={{
                      width: 15, height: 15, borderRadius: 4, cursor: 'pointer',
                      border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-pill)'}`,
                      background: checked ? 'var(--accent)' : 'transparent',
                      color: '#0b1020', fontSize: 10, lineHeight: 1, padding: 0,
                    }}
                  >
                    {checked ? '✓' : ''}
                  </button>

                  <div
                    style={{
                      width: 26, height: 26, borderRadius: 8,
                      background: 'repeating-linear-gradient(135deg,#1e2534 0 5px,#242c3e 5px 10px)',
                    }}
                  />

                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 600, fontSize: 12.5, whiteSpace: 'nowrap',
                        overflow: 'hidden', textOverflow: 'ellipsis',
                      }}
                    >
                      {item.title}
                    </div>
                    <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                      {item.orderRef ?? '—'}
                    </div>
                  </div>

                  <Cell>{item.brand ?? '—'}</Cell>
                  <Cell mono>{item.size ?? '—'}</Cell>

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

                  <div style={{ fontSize: 11.5, color: 'var(--text-dim)', minWidth: 0 }}>
                    {item.carrier ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
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
                          {item.trackingNumber ?? 'no code'}
                        </span>
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-ghost)' }}>—</span>
                    )}
                  </div>

                  <Cell mono>{item.purchasedAt?.slice(5, 10) ?? '—'}</Cell>
                  <Cell mono right>{item.cost}</Cell>
                  <Cell mono right>—</Cell>
                  <Cell mono right>{item.daysHeld ?? '—'}</Cell>
                  <Cell>{item.location ?? '—'}</Cell>
                  <Cell>{item.retailer ?? '—'}</Cell>
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
        noun="units"
        onPage={paged.setPage}
      />
    </div>
  )
}

function Cell({
  children, mono, right,
}: { children: React.ReactNode; mono?: boolean; right?: boolean }) {
  return (
    <div
      className={mono ? 'mono' : undefined}
      style={{
        fontSize: mono ? 11 : 12,
        color: 'var(--text-muted)',
        textAlign: right ? 'right' : 'left',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {children}
    </div>
  )
}

function Chip({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="btn"
      onClick={onClick}
      style={active ? { background: '#242c3e', color: 'var(--text)', borderColor: '#3a4a6a' } : undefined}
    >
      {children}
    </button>
  )
}
