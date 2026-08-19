import { useEffect, useMemo, useState } from 'react'
import { api, type ItemView } from '../api.js'
import { Pager, usePaged } from '../Pager.js'
import { SkeletonTable } from '../Skeleton.js'
import { ContextMenu, useContextMenu } from '../ContextMenu.js'
import { Confirm } from '../Confirm.js'
import { Thumb } from '../Thumb.js'
import { groupByProduct, type ProductGroup } from './inventory-groups.js'
import { SellDialog } from '../Sell.js'

/** The design's column set: selection, thumbnail, then the item's facts. */
const COLUMNS =
  '26px 34px minmax(180px,2fr) 78px 52px 104px 88px 74px 84px 88px 88px 54px 92px 80px'
const MIN_WIDTH = 1320

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

type SortKey =
  | 'title' | 'brand' | 'size' | 'status' | 'purchasedAt' | 'cost' | 'profit'
  | 'daysHeld' | 'retailer'

const HEADERS: { key: SortKey | null; label: string; right?: boolean }[] = [
  { key: 'title', label: 'Item' },
  { key: 'brand', label: 'Brand' },
  { key: 'size', label: 'Size' },
  { key: 'status', label: 'Status' },
  { key: null, label: 'Parcel' },
  { key: 'purchasedAt', label: 'Bought' },
  { key: 'cost', label: 'Cost', right: true },
  { key: null, label: 'Sold for', right: true },
  { key: 'profit', label: 'Profit', right: true },
  { key: 'daysHeld', label: 'Days', right: true },
  { key: null, label: 'Buyer' },
  { key: 'retailer', label: 'Retailer' },
]

export function Inventory({
  query, dataVersion, onSearch,
}: {
  query: string
  dataVersion: number
  /** Lets a product open the units behind it, by searching for its title. */
  onSearch?: (term: string) => void
}) {
  const [items, setItems] = useState<ItemView[] | null>(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'purchasedAt', dir: 'desc',
  })
  const [selected, setSelected] = useState<string[]>([])
  const [confirming, setConfirming] = useState<ItemView | null>(null)
  // Units are the truth; by product is how you read it. Which one is showing
  // is a view, not a filter — the status chips still apply to both.
  const [view, setView] = useState<'units' | 'products'>('units')
  /** Units being recorded as sold, one or several to the same buyer. */
  const [selling, setSelling] = useState<ItemView[] | null>(null)
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
          // Unsold units sort below sold ones rather than as a zero profit,
          // which would read as breaking even.
          case 'profit': return item.profitMinor ?? Number.NEGATIVE_INFINITY
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
  const products = useMemo(() => groupByProduct(filtered), [filtered])

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

      {selling && (
        <SellDialog
          units={selling}
          onClose={() => setSelling(null)}
          onSold={() => {
            setSelected([])
            load()
          }}
        />
      )}

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
        <Chip active={view === 'products'} onClick={() => setView(view === 'products' ? 'units' : 'products')}>
          By product <span className="mono" style={{ opacity: .6 }}>{products.length}</span>
        </Chip>
        <span style={{ width: 1, height: 18, background: 'var(--border)' }} />
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
              style={{ borderColor: '#2b3a5e', color: 'var(--accent-bright)' }}
              onClick={() => setSelling(all.filter((item) => selected.includes(item.id)))}
            >
              Sell {selected.length}
            </button>
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

      {view === 'products' && (
        <ByProduct
          groups={products}
          onOpen={(title) => {
            // Opening a product shows the units behind it, which is the row
            // the count came from.
            setView('units')
            onSearch?.(title)
          }}
        />
      )}

      {view === 'units' && (
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
                        label: checked && selected.length > 1
                          ? `Sold ${selected.length} units…`
                          : 'Sold this unit…',
                        onSelect: () => setSelling(
                          checked && selected.length > 1
                            ? all.filter((row) => selected.includes(row.id))
                            : [item],
                        ),
                      },
                      {
                        label: 'Not sold after all',
                        disabled: item.soldMinor === null,
                        onSelect: async () => {
                          await api.unsellItems([item.id])
                          load()
                        },
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

                  <Thumb url={item.imageUrl} />

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
                  <Cell mono right>{item.sold ?? '—'}</Cell>
                  <div
                    className="mono"
                    style={{
                      fontSize: 11, textAlign: 'right', whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                      color: item.profitMinor === null
                        ? 'var(--text-ghost)'
                        : item.profitMinor >= 0 ? 'var(--teal)' : 'var(--pink)',
                    }}
                    title={item.buyer ? `Sold to ${item.buyer}` : undefined}
                  >
                    {item.profit ?? '—'}
                  </div>
                  <Cell mono right>{item.daysHeld ?? '—'}</Cell>
                  <Cell>{item.buyer ?? item.location ?? '—'}</Cell>
                  <Cell>{item.retailer ?? '—'}</Cell>
                </div>
              )
            })}
          </div>
        </div>
      </div>
      )}

      {view === 'units' ? (
        <Pager
          page={paged.page}
          pageCount={paged.pageCount}
          from={paged.from}
          to={paged.to}
          total={paged.total}
          noun="units"
          onPage={paged.setPage}
        />
      ) : (
        <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)', paddingLeft: 4 }}>
          {products.length} product{products.length === 1 ? '' : 's'} ·{' '}
          {filtered.length} unit{filtered.length === 1 ? '' : 's'} · click one to see its units
        </div>
      )}
    </div>
  )
}

const PRODUCT_COLUMNS = '34px minmax(200px,3fr) 76px 84px 80px 72px 104px 96px 104px 96px'

function ByProduct({
  groups,
  onOpen,
}: {
  groups: ProductGroup[]
  onOpen: (title: string) => void
}) {
  return (
    <div className="table">
      <div className="table-scroll">
        <div className="thead" style={{ minWidth: 900, gridTemplateColumns: PRODUCT_COLUMNS }}>
          <div />
          <div>Product</div>
          <div style={{ textAlign: 'right' }}>Total</div>
          <div style={{ textAlign: 'right' }}>Incoming</div>
          <div style={{ textAlign: 'right' }}>In stock</div>
          <div style={{ textAlign: 'right' }}>Gone</div>
          <div style={{ textAlign: 'right' }}>Spent</div>
          <div style={{ textAlign: 'right' }}>Avg unit</div>
          <div style={{ textAlign: 'right' }}>Profit</div>
          <div>Last bought</div>
        </div>
        <div className="table-scroll-y">
          {groups.map((group) => (
            <div
              key={group.title}
              className="trow"
              style={{ minWidth: 900, gridTemplateColumns: PRODUCT_COLUMNS }}
              onClick={() => onOpen(group.title)}
              title="Show these units"
            >
              <Thumb url={group.imageUrl} />
              <Cell>{group.title}</Cell>
              <div
                className="mono"
                style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', textAlign: 'right' }}
              >
                {group.units}×
              </div>
              <Cell mono right>{group.incoming || '—'}</Cell>
              <Cell mono right>{group.inStock || '—'}</Cell>
              <Cell mono right>{group.gone || '—'}</Cell>
              <Cell mono right>{money(group.costMinor)}</Cell>
              <Cell mono right>{money(Math.round(group.costMinor / group.units))}</Cell>
              <div
                className="mono"
                style={{
                  fontSize: 11, textAlign: 'right',
                  color: group.soldMinor === 0
                    ? 'var(--text-ghost)'
                    : group.profitMinor >= 0 ? 'var(--teal)' : 'var(--pink)',
                }}
              >
                {group.soldMinor === 0 ? '—' : money(group.profitMinor)}
              </div>
              <Cell mono>{group.lastBoughtAt?.slice(0, 10) ?? '—'}</Cell>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function money(minor: number): string {
  return `€${(minor / 100).toFixed(2)}`
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
