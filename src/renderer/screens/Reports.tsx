import { useEffect, useState } from 'react'
import { api, type DashboardView } from '../api.js'
import { SkeletonCards } from '../Skeleton.js'

/**
 * Money over time.
 *
 * This lives here rather than on the dashboard because the dashboard has to fit
 * in one view: a third row pushed it into scrolling, and a figure you have to
 * scroll to find is one you stop looking at.
 */
export function Reports({ dataVersion }: { dataVersion: number }) {
  const [data, setData] = useState<DashboardView | null>(null)

  useEffect(() => {
    void api.dashboard().then(setData)
  }, [dataVersion])

  if (!data) return <SkeletonCards count={2} height={200} />

  return (
    <div className="screen" style={{ overflowY: 'auto' }}>
      <section className="section" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
            channel is connected yet, so it reflects refunds only — money owed back from
            cancellations is shown as owed on the dashboard rather than counted as received.
          </div>
        )}
      </section>

      <section className="section" style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        <div className="section-head" style={{ marginBottom: 0 }}>
          <h2>Where the money went</h2>
          <span className="section-note">from parsed orders</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
          <Figure label="SPENT" value={data.money.out} note={`${data.bought.orders} orders`} />
          <Figure label="TIED UP IN STOCK" value={data.stock.capital} note={`${data.stock.units} units held`} />
          <Figure
            label="OWED BACK"
            value={data.cancelled.owed}
            note={`${data.cancelled.units} cancelled units`}
            alert={data.cancelled.owedMinor > 0}
          />
        </div>
      </section>

      <section className="section" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="section-head" style={{ marginBottom: 0 }}>
          <h2>VAT return</h2>
          <span className="section-note">not available yet</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          A VAT return needs both sides: input VAT from purchases and output VAT from sales. The
          arithmetic is written and tested, but no marketplace mail has been recognised yet, so a
          return produced now would report only half the picture — which is worse than none when
          the figure is one you file.
        </div>
      </section>
    </div>
  )
}

function Figure({
  label, value, note, alert,
}: { label: string; value: string; note: string; alert?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span className="stat-label">{label}</span>
      <span
        className="mono"
        style={{ fontSize: 22, fontWeight: 600, color: alert ? 'var(--warm)' : 'var(--text)' }}
      >
        {value}
      </span>
      <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>{note}</span>
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

function MoneyChart({ series }: { series: { period: string; out: number; in: number }[] }) {
  const peak = Math.max(1, ...series.map((point) => Math.max(point.out, point.in)))
  const height = 170
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
            x1="0" x2="100"
            y1={height - fraction * height}
            y2={height - fraction * height}
            stroke="#1f2532" strokeWidth="0.5" vectorEffect="non-scaling-stroke"
          />
        ))}
        {series.map((point, index) => {
          const left = index * group
          const width = group * 0.32
          const outHeight = (point.out / peak) * (height - 8)
          const inHeight = (point.in / peak) * (height - 8)
          return (
            <g key={point.period}>
              <rect x={left + group * 0.14} y={height - outHeight} width={width} height={outHeight} fill="var(--warm)" opacity={0.85} />
              <rect x={left + group * 0.52} y={height - inHeight} width={width} height={inHeight} fill="var(--teal)" opacity={0.85} />
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
