import { useEffect, useState } from 'react'
import { api, type ShipmentView } from '../api.js'
import { Pager, usePaged } from '../Pager.js'

const GRID = 'grid-template-columns:70px 110px 170px minmax(160px,1fr) 130px 100px 96px'

const CARRIER_MARK: Record<string, { abbr: string; color: string }> = {
  dhl: { abbr: 'DH', color: 'oklch(0.80 0.14 90)' },
  postnl: { abbr: 'PN', color: 'oklch(0.72 0.13 40)' },
  dpd: { abbr: 'DP', color: 'oklch(0.72 0.12 330)' },
  gls: { abbr: 'GL', color: 'oklch(0.74 0.12 145)' },
  ups: { abbr: 'UP', color: 'oklch(0.68 0.08 65)' },
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'oklch(0.66 0.02 265)',
  in_transit: 'oklch(0.76 0.12 232)',
  out_for_delivery: 'oklch(0.78 0.12 178)',
  delivered: 'oklch(0.78 0.12 148)',
  exception: 'oklch(0.70 0.17 18)',
  unknown: 'oklch(0.74 0.11 65)',
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting code',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  exception: 'Exception',
  unknown: 'Unknown',
}

export function Shipments({ query }: { query: string }) {
  const [shipments, setShipments] = useState<ShipmentView[] | null>(null)
  const [selected, setSelected] = useState<ShipmentView | null>(null)
  const [exported, setExported] = useState<string | null>(null)

  useEffect(() => {
    void api.shipments().then(setShipments)
  }, [])

  const term = query.trim().toLowerCase()
  const rows = (shipments ?? []).filter(
    (s) =>
      !term
      || (s.title ?? '').toLowerCase().includes(term)
      || s.linked.toLowerCase().includes(term)
      || (s.trackingNumber ?? '').toLowerCase().includes(term),
  )

  // Computed before the early returns: hooks must run on every render.
  const paged = usePaged(rows, term)

  if (!shipments) return <div className="empty"><span className="empty-body">Loading…</span></div>

  const redirectable = shipments.filter((s) => s.dhlRedirectable)

  if (shipments.length === 0) {
    return (
      <div className="empty" style={{ margin: '60px auto' }}>
        <div className="empty-title">No shipments yet</div>
        <div className="empty-body">
          Import a shipping email and its carrier, expected delivery date and contents appear here.
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: 13, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 11 }}>
        {redirectable.length > 0 && (
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
              borderRadius: 14, background: 'rgba(91,140,255,.10)', border: '1px solid #2b3a5e',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent-bright)' }}>
              {redirectable.length} DHL parcel{redirectable.length === 1 ? '' : 's'} with a postal code
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>
              needs a resolved tracking code before the redirect tool can run
            </span>
            <button
              className="btn"
              style={{ marginLeft: 'auto' }}
              onClick={async () => {
                const result = await api.exportRedirectCsv()
                if (result.written) setExported(`${result.rows} row(s) written to ${result.path}`)
              }}
            >
              Export trackings.csv
            </button>
          </div>
        )}
        {exported && (
          <div style={{ fontSize: 11.5, color: 'var(--teal)', paddingLeft: 4 }}>{exported}</div>
        )}

        <div className="table">
          <div className="table-scroll">
            <div className="thead" style={{ minWidth: 880, ...gridStyle() }}>
              <div>Dir</div><div>Carrier</div><div>Tracking</div><div>Contents</div>
              <div>Status</div><div>Expected</div><div>Postcode</div>
            </div>
            {paged.visible.map((shipment) => {
              const mark = CARRIER_MARK[shipment.carrier] ?? { abbr: '??', color: '#8d94a6' }
              return (
                <div
                  key={shipment.id}
                  className="trow"
                  style={{ minWidth: 880, ...gridStyle() }}
                  onClick={() => setSelected(shipment)}
                >
                  <div>
                    <span
                      className="chip"
                      style={{
                        color: shipment.direction === 'inbound' ? 'var(--warm)' : 'var(--teal)',
                        background: 'transparent',
                        border: '1px solid currentColor',
                        fontSize: 10,
                      }}
                    >
                      {shipment.direction === 'inbound' ? 'IN' : 'OUT'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span
                      style={{
                        width: 22, height: 18, borderRadius: 5, fontSize: 9, fontWeight: 800,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#101720', background: mark.color,
                      }}
                    >
                      {mark.abbr}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--text-mid)' }}>
                      {shipment.carrier.toUpperCase()}
                    </span>
                  </div>
                  <div className="cell-mono">
                    {shipment.trackingNumber ?? (
                      <span style={{ color: 'var(--text-ghost)' }}>not in the email</span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                    }}
                  >
                    {shipment.quantity > 1 && (
                      <span className="mono" style={{ color: 'var(--text-dimmer)' }}>
                        {shipment.quantity}× </span>
                    )}
                    {shipment.title ?? shipment.linked}
                  </div>
                  <div>
                    <span
                      className="chip"
                      style={{
                        color: STATUS_COLOR[shipment.status],
                        background: `color-mix(in oklab, ${STATUS_COLOR[shipment.status]} 14%, transparent)`,
                        border: `1px solid color-mix(in oklab, ${STATUS_COLOR[shipment.status]} 30%, transparent)`,
                      }}
                    >
                      <span
                        className="chip-dot"
                        style={{ background: STATUS_COLOR[shipment.status] }}
                      />
                      {STATUS_LABEL[shipment.status]}
                    </span>
                  </div>
                  <div className="cell-mono">{shipment.expectedDeliveryAt ?? '—'}</div>
                  <div className="cell-mono">{shipment.postalCode ?? '—'}</div>
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
          noun="shipments"
          onPage={paged.setPage}
        />
        <div style={{ fontSize: 11, color: 'var(--text-ghost)', paddingLeft: 4 }}>
          Click a row for detail
        </div>
      </div>

      {selected && <Detail shipment={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function Detail({ shipment, onClose }: { shipment: ShipmentView; onClose: () => void }) {
  return (
    <aside
      style={{
        width: 320, flex: 'none', border: '1px solid var(--border)',
        borderRadius: 'var(--r-table)', background: 'var(--panel)',
        padding: '15px 16px', display: 'flex', flexDirection: 'column', gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{shipment.carrier.toUpperCase()}</div>
          <div className="cell-mono">{shipment.linked}</div>
        </div>
        <button
          onClick={onClose}
          style={{
            marginLeft: 'auto', border: 0, background: 'transparent',
            color: 'var(--text-faint)', fontSize: 15, cursor: 'pointer',
          }}
        >
          ×
        </button>
      </div>

      {!shipment.trackingNumber && (
        <div
          style={{
            border: '1px solid #4a4030', background: 'rgba(247,160,138,.10)',
            borderRadius: 12, padding: '10px 11px',
            display: 'flex', flexDirection: 'column', gap: 5,
          }}
        >
          <div style={{ fontSize: 11.5, fontWeight: 700, color: '#f2c3b4' }}>
            No tracking code in this email
          </div>
          <div style={{ fontSize: 11.5, color: '#e3c9bd', lineHeight: 1.45 }}>
            bol.com sends only a redirect link, never the carrier barcode. Following that link
            once yields the real code.
          </div>
          {shipment.trackingUrl && (
            <button
              className="btn"
              style={{ alignSelf: 'flex-start', marginTop: 3 }}
              onClick={() => void api.openExternal(shipment.trackingUrl!)}
            >
              Open tracking link
            </button>
          )}
        </div>
      )}

      <Field label="Contents" value={shipment.title ?? '—'} />
      <Field label="Quantity" value={String(shipment.quantity)} mono />
      <Field label="Expected" value={shipment.expectedDeliveryAt ?? '—'} mono />
      <Field label="Postcode" value={shipment.postalCode ?? '—'} mono />
      <Field label="City" value={shipment.city ?? '—'} />

      {shipment.dhlRedirectable && (
        <div
          style={{
            border: '1px solid #2b3a5e', background: 'rgba(91,140,255,.08)',
            borderRadius: 12, padding: '10px 11px', fontSize: 11.5,
            color: 'var(--accent-bright)', lineHeight: 1.45,
          }}
        >
          Postal code known, so this parcel can go to the DHL ServicePoint redirect tool as soon
          as its tracking code is resolved.
        </div>
      )}
    </aside>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <span style={{ color: 'var(--text-dim)', flex: 1 }}>{label}</span>
      <span
        className={mono ? 'mono' : undefined}
        style={{ color: 'var(--text-soft)', textAlign: 'right', minWidth: 0 }}
      >
        {value}
      </span>
    </div>
  )
}

function gridStyle(): React.CSSProperties {
  const [, columns] = GRID.split(':')
  return { gridTemplateColumns: columns }
}
