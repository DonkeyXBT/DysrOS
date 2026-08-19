import { useEffect, useState } from 'react'
import { api, type ShipmentView } from '../api.js'
import { Pager, usePaged } from '../Pager.js'
import { SkeletonTable } from '../Skeleton.js'
import { ContextMenu, useContextMenu } from '../ContextMenu.js'
import { Confirm } from '../Confirm.js'
import { Thumb } from '../Thumb.js'
import { RedirectDialog } from '../Redirect.js'

const GRID = 'grid-template-columns:26px 70px 110px 170px minmax(160px,1fr) 130px 100px 96px'

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
  ready_for_pickup: 'oklch(0.80 0.13 95)',
  delivered: 'oklch(0.78 0.12 148)',
  exception: 'oklch(0.70 0.17 18)',
  unknown: 'oklch(0.74 0.11 65)',
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting code',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  ready_for_pickup: 'At a ServicePoint',
  delivered: 'Delivered',
  exception: 'Exception',
  unknown: 'Unknown',
}

export function Shipments({ query, dataVersion }: { query: string; dataVersion: number }) {
  const [shipments, setShipments] = useState<ShipmentView[] | null>(null)
  const [selected, setSelected] = useState<ShipmentView | null>(null)
  const [exported, setExported] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [resolveNote, setResolveNote] = useState<string | null>(null)

  const [confirming, setConfirming] = useState<ShipmentView | null>(null)
  // Parcels ticked for a redirect. Kept by id, so a refresh mid-run does not
  // lose the selection.
  const [picked, setPicked] = useState<string[]>([])
  const [redirecting, setRedirecting] = useState<ShipmentView[] | null>(null)
  const { menu, open, close } = useContextMenu()

  const load = () => {
    void api.shipments().then(setShipments)
  }

  useEffect(load, [dataVersion])

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

  if (!shipments) {
    return <SkeletonTable columns={gridStyle().gridTemplateColumns as string} minWidth={880} rows={8} />
  }

  const redirectable = shipments.filter((s) => s.dhlRedirectable)
  const awaiting = shipments.filter((s) => s.trackingNumber === null)
  const pickedParcels = redirectable.filter((parcel) => picked.includes(parcel.id))

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
    <div className="screen" style={{ flexDirection: 'row', gap: 13, alignItems: 'stretch' }}>
      <ContextMenu menu={menu} onClose={close} />

      {redirecting && (
        <RedirectDialog
          parcels={redirecting}
          onClose={() => setRedirecting(null)}
          onDone={() => {
            setPicked([])
            load()
          }}
        />
      )}

      {confirming && (
        <Confirm
          title="Delete shipment"
          destructive
          confirmLabel="Delete"
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            const target = confirming
            setConfirming(null)
            await api.deleteRecord('shipment', target.id)
            setSelected(null)
            load()
          }}
          body={
            <>
              Remove this <strong>{confirming.carrier.toUpperCase()}</strong> parcel? The order it
              belongs to stays, and re-reading mail will not bring the parcel back.
            </>
          }
        />
      )}

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 11 }}>
        {awaiting.length > 0 && (
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
              borderRadius: 14, background: 'rgba(247,160,138,.10)', border: '1px solid #4a4030',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: '#f2c3b4' }}>
              {awaiting.length} parcel{awaiting.length === 1 ? '' : 's'} without a tracking code
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>
              picked up automatically every few minutes — the retailer sends a redirect rather
              than the barcode, and following it once gets the code
            </span>
            <button
              className="btn"
              style={{ marginLeft: 'auto' }}
              disabled={resolving}
              onClick={async () => {
                setResolving(true)
                setResolveNote(null)
                try {
                  const result = await api.resolveTracking()
                  setResolveNote(
                    `Resolved ${result.resolved} of ${result.attempted}` +
                    (result.failed > 0 ? ` · ${result.failed} still unresolved` : ''),
                  )
                } finally {
                  setResolving(false)
                }
              }}
            >
              {resolving ? 'Resolving…' : 'Get them now'}
            </button>
          </div>
        )}
        {resolveNote && (
          <div style={{ fontSize: 11.5, color: 'var(--teal)', paddingLeft: 4 }}>{resolveNote}</div>
        )}

        {/* Nothing announces that parcels could be redirected: the row's own
            tick box and its right-click menu say so where the parcel is. This
            bar exists only once something is picked, because then there is an
            action waiting to be taken. */}
        {pickedParcels.length > 0 && (
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
              borderRadius: 14, background: 'rgba(91,140,255,.10)', border: '1px solid #2b3a5e',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent-bright)' }}>
              {pickedParcels.length} selected
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>
              to the nearest ServicePoint instead of your door
            </span>
            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
              <button
                className="btn"
                style={{ borderColor: '#2b3a5e', color: 'var(--accent-bright)' }}
                onClick={() => setRedirecting(pickedParcels)}
              >
                Redirect {pickedParcels.length}
              </button>
              {pickedParcels.length < redirectable.length && (
                <button
                  className="btn"
                  onClick={() => setPicked(redirectable.map((parcel) => parcel.id))}
                >
                  Select all {redirectable.length}
                </button>
              )}
              <button className="btn" onClick={() => setPicked([])}>Clear</button>
            </div>
          </div>
        )}
        {exported && (
          <div style={{ fontSize: 11.5, color: 'var(--teal)', paddingLeft: 4 }}>{exported}</div>
        )}

        <div className="table">
          <div className="table-scroll">
            <div className="thead" style={{ minWidth: 880, ...gridStyle() }}>
              <div />
              <div>Dir</div><div>Carrier</div><div>Tracking</div><div>Contents</div>
              <div>Status</div><div>Expected</div><div>Postcode</div>
            </div>
            <div className="table-scroll-y">
            {paged.visible.map((shipment) => {
              const mark = CARRIER_MARK[shipment.carrier] ?? { abbr: '??', color: '#8d94a6' }
              const ticked = picked.includes(shipment.id)
              // Right-clicking inside a selection acts on the whole selection,
              // which is what "redirect these" means once several are ticked.
              const batch = ticked && pickedParcels.length > 1 ? pickedParcels : null
              return (
                <div
                  key={shipment.id}
                  className="trow"
                  style={{ minWidth: 880, ...gridStyle() }}
                  onClick={() => setSelected(shipment)}
                  onContextMenu={(event) =>
                    open(event, shipment.title ?? shipment.linked, [
                      {
                        label: batch
                          ? `Send ${batch.length} parcels to a ServicePoint…`
                          : 'Send to a ServicePoint…',
                        disabled: !shipment.dhlRedirectable && !batch,
                        onSelect: () => setRedirecting(batch ?? [shipment]),
                      },
                      {
                        label: ticked ? 'Deselect' : 'Select for redirect',
                        disabled: !shipment.dhlRedirectable,
                        onSelect: () => setPicked((current) =>
                          ticked
                            ? current.filter((id) => id !== shipment.id)
                            : [...current, shipment.id]),
                      },
                      {
                        label: 'Save the shipping label…',
                        disabled: !shipment.hasLabel,
                        onSelect: async () => {
                          const result = await api.saveLabel(shipment.id)
                          if (result.saved) setExported(`Label saved to ${result.path}`)
                          else if (result.reason) setExported(result.reason)
                        },
                      },
                      {
                        label: 'Open the shipping label',
                        disabled: !shipment.hasLabel,
                        onSelect: () => void api.openLabel(shipment.id),
                      },
                      {
                        label: 'Copy tracking code',
                        disabled: !shipment.trackingNumber,
                        onSelect: () =>
                          void navigator.clipboard.writeText(shipment.trackingNumber ?? ''),
                      },
                      {
                        label: 'Copy tracking link',
                        disabled: !shipment.trackingUrl,
                        onSelect: () =>
                          void navigator.clipboard.writeText(shipment.trackingUrl ?? ''),
                      },
                      {
                        label: 'Open tracking link',
                        disabled: !shipment.trackingUrl,
                        onSelect: () => void api.openExternal(shipment.trackingUrl!),
                      },
                      {
                        label: 'Delete shipment',
                        destructive: true,
                        onSelect: () => setConfirming(shipment),
                      },
                    ])}
                >
                  <div onClick={(event) => event.stopPropagation()}>
                    {shipment.dhlRedirectable && (
                      <button
                        aria-label={ticked ? 'Deselect parcel' : 'Select parcel'}
                        onClick={() => setPicked((current) =>
                          ticked
                            ? current.filter((id) => id !== shipment.id)
                            : [...current, shipment.id])}
                        style={{
                          width: 15, height: 15, borderRadius: 4, cursor: 'pointer', padding: 0,
                          border: `1px solid ${ticked ? 'var(--accent)' : 'var(--border-pill)'}`,
                          background: ticked ? 'var(--accent)' : 'transparent',
                          color: '#0b1020', fontSize: 10, lineHeight: 1,
                        }}
                      >
                        {ticked ? '✓' : ''}
                      </button>
                    )}
                  </div>
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
                  <div className="cell-mono" style={{ minWidth: 0 }}>
                    {shipment.trackingUrl ? (
                      // The barcode is the link: it is what the user wants to
                      // click, and the carrier page it opens is built from the
                      // barcode and the postcode.
                      <button
                        className="track-link"
                        title={shipment.trackingUrl}
                        onClick={(event) => {
                          event.stopPropagation()
                          void api.openExternal(shipment.trackingUrl!)
                        }}
                      >
                        {shipment.trackingNumber ?? 'Follow the parcel'}
                        <span className="track-link-mark">↗</span>
                      </button>
                    ) : (
                      shipment.trackingNumber ?? (
                        <span style={{ color: 'var(--text-ghost)' }}>not in the email</span>
                      )
                    )}
                  </div>
                  <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
                    <Thumb url={shipment.imageUrl} size={28} />
                    <div style={{ minWidth: 0 }}>
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
                        {shipment.title ?? '—'}
                      </div>
                      <div
                        className="mono"
                        style={{
                          fontSize: 10,
                          color: shipment.linkedToPurchase ? 'var(--teal)' : 'var(--text-ghost)',
                        }}
                      >
                        {shipment.linkedToPurchase ? shipment.linked : `${shipment.linked} · no order yet`}
                      </div>
                    </div>
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
                  <div className="cell-mono" style={{ minWidth: 0 }}>
                    {shipment.expectedDeliveryAt ?? '—'}
                    {shipment.deliveryWindow && (
                      <div style={{ fontSize: 10, color: 'var(--teal)' }}>
                        {shipment.deliveryWindow}
                      </div>
                    )}
                  </div>
                  <div className="cell-mono">{shipment.postalCode ?? '—'}</div>
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
          noun="shipments"
          onPage={paged.setPage}
        />
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            fontSize: 11, color: 'var(--text-ghost)', paddingLeft: 4,
          }}
        >
          <span>Click a row for detail · right-click a DHL parcel to send it to a ServicePoint</span>
          {redirectable.length > 0 && (
            <button
              className="btn"
              style={{ padding: '3px 9px', fontSize: 10.5, marginLeft: 'auto' }}
              onClick={async () => {
                const result = await api.exportRedirectCsv()
                if (result.written) setExported(`${result.rows} row(s) written to ${result.path}`)
              }}
            >
              Export trackings.csv
            </button>
          )}
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
      <Field
        label="Expected"
        value={[shipment.expectedDeliveryAt, shipment.deliveryWindow].filter(Boolean).join(' · ') || '—'}
        mono
      />
      {shipment.hasLabel && (
        <div
          style={{
            border: '1px solid #2b3a5e', background: 'rgba(91,140,255,.08)',
            borderRadius: 12, padding: '10px 11px',
            display: 'flex', flexDirection: 'column', gap: 6,
          }}
        >
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--accent-bright)' }}>
            Shipping label
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.45 }}>
            The marketplace attached it to its mail. This is that file, unchanged.
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn" onClick={() => void api.openLabel(shipment.id)}>Open</button>
            <button className="btn" onClick={() => void api.saveLabel(shipment.id)}>Save as…</button>
          </div>
        </div>
      )}

      <Field label="Tracking code" value={shipment.trackingNumber ?? '—'} mono />
      <TrackingLink url={shipment.trackingUrl} />
      <Field label="Postcode" value={shipment.postalCode ?? '—'} mono />

      {shipment.redirect && (
        <div
          style={{
            border: `1px solid ${shipment.redirect.outcome === 'redirected' ? '#25443a' : '#4a4030'}`,
            background: shipment.redirect.outcome === 'redirected'
              ? 'rgba(93,224,183,.07)'
              : 'rgba(247,160,138,.08)',
            borderRadius: 12, padding: '10px 11px',
            display: 'flex', flexDirection: 'column', gap: 4,
          }}
        >
          <div
            style={{
              fontSize: 11.5, fontWeight: 700,
              color: shipment.redirect.outcome === 'redirected' ? 'var(--teal)' : '#f2c3b4',
            }}
          >
            {shipment.redirect.outcome === 'redirected'
              ? 'Going to a ServicePoint'
              : shipment.redirect.outcome === 'test'
                ? 'Test run only'
                : 'Redirect not accepted'}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.45 }}>
            {shipment.redirect.message}
          </div>
        </div>
      )}
      <Field label="City" value={shipment.city ?? '—'} />

      {shipment.dhlRedirectable && (
        <div
          style={{
            border: '1px solid #2b3a5e', background: 'rgba(91,140,255,.08)',
            borderRadius: 12, padding: '10px 11px', fontSize: 11.5,
            color: 'var(--accent-bright)', lineHeight: 1.45,
          }}
        >
          {shipment.trackingNumber
            ? 'Postal code and tracking code both known, so this parcel can go straight to the DHL ServicePoint redirect tool.'
            : 'Postal code known, so this parcel can go to the DHL ServicePoint redirect tool as soon as its tracking code is resolved.'}
        </div>
      )}
    </aside>
  )
}

/**
 * The carrier's own page for this parcel.
 *
 * Shown in full rather than hidden behind a button: it is built from the
 * barcode and the postcode, so seeing it is how you know both were read
 * correctly — and it is the address to paste anywhere else.
 */
function TrackingLink({ url }: { url: string | null }) {
  const [copied, setCopied] = useState(false)

  if (!url) return <Field label="Tracking link" value="—" />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="stat-label">TRACKING LINK</span>
      <button
        className="track-link"
        style={{ textAlign: 'left', wordBreak: 'break-all', whiteSpace: 'normal', lineHeight: 1.4 }}
        onClick={() => void api.openExternal(url)}
      >
        {url}
      </button>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn" onClick={() => void api.openExternal(url)}>Open</button>
        <button
          className="btn"
          onClick={() => {
            void navigator.clipboard.writeText(url)
            setCopied(true)
            setTimeout(() => setCopied(false), 1800)
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </div>
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
