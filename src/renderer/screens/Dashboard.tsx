import { useEffect, useState } from 'react'
import { api, type DashboardView } from '../api.js'
import { SkeletonDashboard } from '../Skeleton.js'

export function Dashboard({
  onSync,
  dataVersion,
  hasMail,
}: {
  onSync: () => void
  dataVersion: number
  hasMail: boolean
}) {
  const [data, setData] = useState<DashboardView | null>(null)

  useEffect(() => {
    void api.dashboard().then(setData)
  }, [dataVersion])

  if (!data) return <SkeletonDashboard />

  if (!hasMail && data.bought.orders === 0) {
    return (
      <div className="empty" style={{ margin: '70px auto', maxWidth: 520 }}>
        <div style={{ width: 64, height: 64, borderRadius: 22, background: 'var(--grad-cool)', opacity: .9 }} />
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
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 13 }}>
        <Stat
          label="BOUGHT"
          value={String(data.bought.orders)}
          unit={`order${data.bought.orders === 1 ? '' : 's'}`}
          note={`${data.bought.units} unit${data.bought.units === 1 ? '' : 's'} · ${data.bought.spend}`}
          hue={225}
        />
        <Stat
          label="ON THE WAY"
          value={String(data.inFlight.units)}
          unit="units"
          note={
            data.inFlight.awaitingCode > 0
              ? `${data.inFlight.parcels} parcels · ${data.inFlight.awaitingCode} awaiting a code`
              : `${data.inFlight.parcels} parcel${data.inFlight.parcels === 1 ? '' : 's'} in transit`
          }
          hue={40}
        />
        <Stat
          label="IN STOCK"
          value={String(data.stock.units)}
          unit="units"
          note={`${data.stock.capital} tied up`}
          hue={148}
        />
        <Stat
          label="CANCELLED"
          value={String(data.cancelled.units)}
          unit="units"
          note={
            data.cancelled.owedMinor > 0
              ? `${data.cancelled.owed} owed back to you`
              : 'nothing outstanding'
          }
          hue={350}
          alert={data.cancelled.owedMinor > 0}
        />
      </section>

      <section className="section" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h2>Money out and in</h2>
          <span className="section-note">last 12 weeks</span>
          <div style={{ display: 'flex', gap: 18, marginLeft: 'auto', alignItems: 'baseline' }}>
            <Legend colour="var(--warm)" label="Spent" value={data.money.out} />
            <Legend colour="var(--teal)" label="Received" value={data.money.in} />
          </div>
        </div>

        <MoneyChart series={data.series} />

        {data.money.salesRecorded === 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--text-ghost)', lineHeight: 1.5 }}>
            Received counts refunds that have actually arrived, and marketplace payouts. No sales
            channel is connected yet, so it reflects refunds only — money owed back to you from
            cancellations is shown above rather than counted as received.
          </div>
        )}
      </section>
    </div>
  )
}

function Stat({
  label, value, unit, note, hue, alert,
}: {
  label: string
  value: string
  unit: string
  note: string
  hue: number
  alert?: boolean
}) {
  return (
    <div
      className="section"
      style={{
        display: 'flex', flexDirection: 'column', gap: 6,
        borderColor: alert ? '#3a2b33' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span
          style={{
            width: 6, height: 6, borderRadius: '50%',
            background: `oklch(0.76 0.13 ${hue})`, flex: 'none',
          }}
        />
        <span className="stat-label">{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span className="stat-value" style={{ fontSize: 28 }}>{value}</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>{unit}</span>
      </div>
      <div
        style={{
          fontSize: 11.5, lineHeight: 1.4,
          color: alert ? 'var(--warm)' : 'var(--text-dimmer)',
        }}
      >
        {note}
      </div>
    </div>
  )
}

function Legend({ colour, label, value }: { colour: string; label: string; value: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: colour }} />
      <span style={{ fontSize: 11, color: 'var(--text-dimmer)' }}>{label}</span>
      <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-soft)' }}>{value}</span>
    </span>
  )
}

/**
 * Money out and in, week by week.
 *
 * Paired bars rather than a line: these are discrete weekly totals, and a line
 * drawn between them would imply values on days that were never measured.
 */
function MoneyChart({ series }: { series: { period: string; out: number; in: number }[] }) {
  const peak = Math.max(1, ...series.map((point) => Math.max(point.out, point.in)))
  const height = 150
  const group = 100 / Math.max(1, series.length)

  if (series.every((point) => point.out === 0 && point.in === 0)) {
    return (
      <div
        style={{
          height, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, color: 'var(--text-ghost)',
          border: '1px dashed var(--border-strong)', borderRadius: 14,
        }}
      >
        No money recorded in this period yet.
      </div>
    )
  }

  return (
    <div>
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height, display: 'block' }}
        role="img"
        aria-label="Money spent and received per week"
      >
        {[0.25, 0.5, 0.75, 1].map((fraction) => (
          <line
            key={fraction}
            x1="0"
            x2="100"
            y1={height - fraction * height}
            y2={height - fraction * height}
            stroke="#1f2532"
            strokeWidth="0.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {series.map((point, index) => {
          const left = index * group
          const width = group * 0.32
          const outHeight = (point.out / peak) * (height - 8)
          const inHeight = (point.in / peak) * (height - 8)
          return (
            <g key={point.period}>
              <rect
                x={left + group * 0.14}
                y={height - outHeight}
                width={width}
                height={outHeight}
                fill="var(--warm)"
                opacity={0.85}
              />
              <rect
                x={left + group * 0.52}
                y={height - inHeight}
                width={width}
                height={inHeight}
                fill="var(--teal)"
                opacity={0.85}
              />
            </g>
          )
        })}
      </svg>

      <div style={{ display: 'flex', marginTop: 6 }}>
        {series.map((point, index) => (
          <span
            key={point.period}
            className="mono"
            style={{
              flex: 1, textAlign: 'center', fontSize: 9.5, color: 'var(--text-ghost)',
              // Every other label, so they never collide at narrow widths.
              visibility: index % 2 === 0 ? 'visible' : 'hidden',
            }}
          >
            {point.period}
          </span>
        ))}
      </div>
    </div>
  )
}
