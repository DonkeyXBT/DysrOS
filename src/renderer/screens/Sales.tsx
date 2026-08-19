import { useEffect, useMemo, useState } from 'react'
import { api, type SaleView } from '../api.js'
import { Pager, usePaged } from '../Pager.js'
import { SkeletonTable } from '../Skeleton.js'
import { ContextMenu, useContextMenu } from '../ContextMenu.js'
import { Confirm } from '../Confirm.js'
import { Thumb } from '../Thumb.js'
import { EditSaleDialog } from '../Sell.js'

const COLUMNS = '34px minmax(200px,2fr) 110px 96px 96px 96px 96px 110px'
const MIN_WIDTH = 980

/**
 * What has been sold.
 *
 * A sale is recorded by hand today — a buyer, a price, a date — so this screen
 * has to be correctable: prices get agreed in a hurry and written down wrong.
 * Right-clicking a row edits it or undoes it, and undoing puts the unit back
 * in stock rather than deleting anything about the goods.
 */
export function Sales({ query, dataVersion }: { query: string; dataVersion: number }) {
  const [sales, setSales] = useState<SaleView[] | null>(null)
  const [editing, setEditing] = useState<SaleView | null>(null)
  const [undoing, setUndoing] = useState<SaleView | null>(null)
  const { menu, open, close } = useContextMenu()

  const load = () => {
    void api.sales().then(setSales)
  }

  useEffect(load, [dataVersion])

  const term = query.trim().toLowerCase()
  const rows = useMemo(
    () => (sales ?? []).filter(
      (sale) =>
        !term
        || sale.title.toLowerCase().includes(term)
        || (sale.buyer ?? '').toLowerCase().includes(term)
        || (sale.orderRef ?? '').toLowerCase().includes(term),
    ),
    [sales, term],
  )

  const paged = usePaged(rows, term)

  if (!sales) return <SkeletonTable columns={COLUMNS} minWidth={MIN_WIDTH} rows={8} />

  if (sales.length === 0) {
    return (
      <div className="empty" style={{ margin: '70px auto' }}>
        <div className="empty-title">Nothing sold yet</div>
        <div className="empty-body">
          Sell a unit from Inventory — right-click it, or tick several and sell them together —
          and it appears here with what it fetched and what it earned.
        </div>
      </div>
    )
  }

  const revenue = rows.reduce((sum, sale) => sum + sale.grossMinor, 0)
  // Only sales with a cost behind them can say what was earned; the rest are
  // counted separately rather than treated as pure profit.
  const costed = rows.filter((sale) => sale.profitMinor !== null)
  const profit = costed.reduce((sum, sale) => sum + (sale.profitMinor ?? 0), 0)
  const vat = rows.reduce((sum, sale) => sum + sale.vatMinor, 0)

  return (
    <div className="screen">
      <ContextMenu menu={menu} onClose={close} />

      {editing && (
        <EditSaleDialog
          sale={editing}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}

      {undoing && (
        <Confirm
          title="Undo this sale"
          destructive
          confirmLabel="Undo the sale"
          onCancel={() => setUndoing(null)}
          onConfirm={async () => {
            const target = undoing
            setUndoing(null)
            await api.deleteSale(target.id)
            load()
          }}
          body={
            <>
              <strong>{undoing.title}</strong> goes back into stock and the {undoing.gross} it
              fetched stops counting. The unit itself and its order are untouched.
            </>
          }
        />
      )}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
        <Figure label="SOLD" value={String(rows.length)} note="units" />
        <Figure label="RECEIVED" value={money(revenue)} note="including BTW" />
        <Figure
          label="PROFIT"
          value={costed.length === 0 ? '—' : money(profit)}
          note={costed.length === rows.length
            ? 'received less cost'
            : `${costed.length} of ${rows.length} with a known cost`}
          accent={costed.length === 0 ? undefined : profit >= 0}
        />
        <Figure label="BTW COLLECTED" value={money(vat)} note="owed on these sales" />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-ghost)' }}>
          Right-click a sale to correct it
        </span>
      </div>

      <div className="table">
        <div className="table-scroll">
          <div className="thead" style={{ minWidth: MIN_WIDTH, gridTemplateColumns: COLUMNS }}>
            <div />
            <div>Item</div>
            <div>Buyer</div>
            <div>Sold</div>
            <div style={{ textAlign: 'right' }}>Cost</div>
            <div style={{ textAlign: 'right' }}>Received</div>
            <div style={{ textAlign: 'right' }}>Profit</div>
            <div style={{ textAlign: 'right' }}>BTW</div>
          </div>

          <div className="table-scroll-y">
            {paged.visible.map((sale) => (
              <div
                key={sale.id}
                className="trow"
                style={{ minWidth: MIN_WIDTH, gridTemplateColumns: COLUMNS, cursor: 'default' }}
                onContextMenu={(event) =>
                  open(event, sale.title, [
                    { label: 'Edit this sale…', onSelect: () => setEditing(sale) },
                    {
                      label: 'Copy buyer',
                      disabled: !sale.buyer,
                      onSelect: () => void navigator.clipboard.writeText(sale.buyer ?? ''),
                    },
                    {
                      label: 'Undo the sale',
                      destructive: true,
                      onSelect: () => setUndoing(sale),
                    },
                  ])}
                onDoubleClick={() => setEditing(sale)}
              >
                <Thumb url={sale.imageUrl} />

                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600, fontSize: 12.5, whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                    }}
                  >
                    {sale.title}
                  </div>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                    {[sale.retailer, sale.orderRef].filter(Boolean).join(' · ')
                      || (sale.channel === 'offline' ? 'sold privately' : sale.channel)}
                  </div>
                </div>

                <Cell>{sale.buyer ?? '—'}</Cell>
                <Cell mono>{sale.soldAt.slice(0, 10)}</Cell>
                <Cell mono right>{sale.cost ?? '—'}</Cell>
                <Cell mono right>{sale.gross}</Cell>
                <div
                  className="mono"
                  style={{
                    fontSize: 11, textAlign: 'right',
                    color: sale.profitMinor === null
                      ? 'var(--text-ghost)'
                      : sale.profitMinor >= 0 ? 'var(--teal)' : 'var(--pink)',
                  }}
                  title={sale.profitMinor === null ? 'Bought outside this application' : undefined}
                >
                  {sale.profit ?? '—'}
                </div>
                <Cell mono right>{sale.vat}</Cell>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Pager
        page={paged.page}
        pageCount={paged.pageCount}
        from={paged.from}
        to={paged.to}
        total={paged.total}
        noun="sales"
        onPage={paged.setPage}
      />
    </div>
  )
}

function money(minor: number): string {
  return `€${(minor / 100).toFixed(2)}`
}

function Figure({
  label, value, note, accent,
}: { label: string; value: string; note: string; accent?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="stat-label">{label}</span>
      <span
        className="mono"
        style={{
          fontSize: 17, fontWeight: 700,
          color: accent === undefined ? 'var(--text)' : accent ? 'var(--teal)' : 'var(--pink)',
        }}
      >
        {value}
      </span>
      <span style={{ fontSize: 10.5, color: 'var(--text-dimmer)' }}>{note}</span>
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
