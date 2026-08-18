import type { SummaryView } from '../api.js'

export function Dashboard({
  summary,
  onSync,
}: {
  summary: SummaryView | null
  onSync: () => void
}) {
  if (!summary) return <Skeleton />

  if (summary.messageCount === 0) {
    return (
      <div className="empty" style={{ margin: '70px auto', maxWidth: 520 }}>
        <div
          style={{
            width: 64, height: 64, borderRadius: 22,
            background: 'var(--grad-cool)', opacity: .9,
          }}
        />
        <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: '-.02em' }}>
          Nothing here yet
        </h2>
        <p className="empty-body">
          This tool fills itself from your mail. Connect a mailbox in Settings and every order,
          cancellation and shipping notice in it becomes a record here.
        </p>
        <button className="btn btn-primary" style={{ marginTop: 4, padding: '11px 20px' }} onClick={onSync}>
          Sync mail now
        </button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
      {summary.awaitingTracking > 0 && (
        <section
          className="section"
          style={{
            border: '1px solid #33262c',
            background: 'linear-gradient(135deg,rgba(232,106,160,.10),rgba(247,160,138,.03))',
            padding: '14px 16px',
          }}
        >
          <div className="section-head" style={{ marginBottom: 11 }}>
            <h2>Needs you</h2>
            <span className="section-note">derived from what the mail actually said</span>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))',
              gap: 10,
            }}
          >
            <AttentionCard
              hue={40}
              kind="Awaiting tracking code"
              title={`${summary.awaitingTracking} shipment${summary.awaitingTracking === 1 ? '' : 's'} without a barcode`}
              meta="bol.com sends only a redirect link — resolve to get the code"
            />
            {summary.redirectable > 0 && (
              <AttentionCard
                hue={90}
                kind="DHL redirect ready"
                title={`${summary.redirectable} parcel${summary.redirectable === 1 ? '' : 's'} with a postal code`}
                meta="Export trackings.csv from the Shipments screen"
              />
            )}
            {summary.reviewCount > 0 && (
              <AttentionCard
                hue={285}
                kind="Review queue"
                title={`${summary.reviewCount} email${summary.reviewCount === 1 ? '' : 's'} no parser recognised`}
                meta="Nothing was dropped — they are waiting for you"
              />
            )}
          </div>
        </section>
      )}

      <section style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 13 }}>
        <div
          className="section"
          style={{ display: 'flex', flexDirection: 'column', gap: 13 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2>Recorded spend</h2>
            <span className="section-note" style={{ marginLeft: 'auto' }}>
              from {summary.purchaseCount} parsed order{summary.purchaseCount === 1 ? '' : 's'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 22, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div className="stat-label">TOTAL SPEND</div>
              <div className="stat-value">{summary.spend}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>
                purchase side only — sales not yet connected
              </div>
            </div>
          </div>
          <div
            style={{
              display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10,
              borderTop: '1px solid var(--border)', paddingTop: 12,
            }}
          >
            <Breakdown label="EMAILS STORED" value={String(summary.messageCount)} />
            <Breakdown label="EVENTS EXTRACTED" value={String(summary.eventCount)} />
            <Breakdown label="IN REVIEW" value={String(summary.reviewCount)} />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
          <div className="tile inbound">
            <div style={{ display: 'flex', alignItems: 'flex-start' }}>
              <div className="tile-title">Inbound<br />in flight</div>
            </div>
            <div style={{ flex: 1 }} />
            <div className="tile-value">{summary.inbound}</div>
            <div className="tile-note">
              {summary.awaitingTracking} awaiting a tracking code
            </div>
          </div>
          <div className="tile outbound">
            <div style={{ display: 'flex', alignItems: 'flex-start' }}>
              <div className="tile-title">Outbound<br />to buyers</div>
            </div>
            <div style={{ flex: 1 }} />
            <div className="tile-value">{summary.outbound}</div>
            <div className="tile-note">no sales channel connected yet</div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Where the numbers come from</h2>
          <span className="section-note">every figure traces to an email you imported</span>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-dim)' }}>
          Nothing on this screen is estimated. Spend is the sum of totals parsed out of order
          confirmations, and each one was cross-checked against its own quantity, unit price and
          shipping line before being accepted. Where a retailer omits a figure — bol.com states no
          amount at all in a cancellation — it is left empty rather than guessed.
        </p>
      </section>
    </div>
  )
}

function AttentionCard({
  hue, kind, title, meta,
}: { hue: number; kind: string; title: string; meta: string }) {
  return (
    <div
      style={{
        border: '1px solid #2a3040', background: '#151a26', borderRadius: 'var(--r-card)',
        padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span
          style={{
            width: 7, height: 7, borderRadius: '50%', flex: 'none',
            background: `oklch(0.74 0.15 ${hue})`,
          }}
        />
        <span
          style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '.06em',
            textTransform: 'uppercase', color: '#98a0b3',
          }}
        >
          {kind}
        </span>
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.3 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>{meta}</div>
    </div>
  )
}

function Breakdown({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div className="stat-label">{label}</div>
      <div className="stat-small">{value}</div>
    </div>
  )
}

function Skeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {[64, 120, 120, 90].map((height, index) => (
        <div
          key={index}
          style={{
            height, borderRadius: 'var(--r-section)', background: '#141824',
            border: '1px solid var(--border)', opacity: .5,
          }}
        />
      ))}
    </div>
  )
}
