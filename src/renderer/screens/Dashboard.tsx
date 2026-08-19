import { useEffect, useState } from 'react'
import { api, type DashboardView } from '../api.js'
import { SkeletonDashboard } from '../Skeleton.js'
import { Thumb } from '../Thumb.js'

/**
 * The dashboard from the design: pipeline, profit, capital, KPIs, and what
 * needs attention.
 *
 * Every figure is computed from what the mail actually said. Where a figure
 * cannot be known yet — profit without a sales channel — the tile says so
 * rather than showing a confident zero, which would read as "you made nothing"
 * instead of "this is not connected".
 */
export function Dashboard({
  onSync,
  onGo,
  dataVersion,
  hasMail,
}: {
  onSync: () => void
  onGo: (screen: 'Inventory' | 'Shipments' | 'Purchases' | 'Settings') => void
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

  const attention = buildAttention(data, onGo)

  return (
    <div className="screen" style={{ gap: 10 }}>
      <section
        style={{
          display: 'grid', gridTemplateColumns: '1.8fr 1fr', gap: 10,
          alignItems: 'stretch', flex: '1 1 44%', minHeight: 0,
        }}
      >
        <Card title="Pipeline" note="units through each stage">
          <Pipeline funnel={data.funnel} />
        </Card>

        <Card title="Net profit">
          <NetProfit profit={data.profit} spend={data.money.out} />
        </Card>
      </section>

      <section
        style={{
          display: 'grid', gridTemplateColumns: '1fr 1.25fr 1fr', gap: 10,
          alignItems: 'stretch', flex: '1 1 56%', minHeight: 0,
        }}
      >
        <Card title="Capital tied up">
          <Capital data={data} onGo={onGo} />
        </Card>

        {/* Shipped, and what is bought most. Parcels waiting for a code, money
            owed back and unrecognised mail all look after themselves — they
            were counters of the plumbing rather than of the business. */}
        <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', gap: 10, minHeight: 0 }}>
          <Kpi
            label="Shipped"
            value={`${data.bought.shipped}/${data.bought.orders}`}
            meta={
              data.bought.delivered > 0
                ? `${data.bought.delivered} delivered · ${data.bought.orders - data.bought.shipped} not yet sent`
                : `${data.bought.orders - data.bought.shipped} order${data.bought.orders - data.bought.shipped === 1 ? '' : 's'} not yet sent`
            }
            hue={40}
            fill={data.bought.orders === 0 ? 0 : data.bought.shipped / data.bought.orders}
            onClick={() => onGo('Shipments')}
          />

          <Card title="Most bought" note="units of each article">
            <MostBought products={data.topProducts} onGo={onGo} />
          </Card>
        </div>

        <div
          style={{
            borderRadius: 20,
            background: 'linear-gradient(155deg,#1b2a4a 0%,#3a3a6e 45%,#e8907e 100%)',
            padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8,
            minWidth: 0, overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                background: 'rgba(255,255,255,.22)', border: '1px solid rgba(255,255,255,.3)',
                borderRadius: 999, padding: '3px 10px', fontSize: 10.5, fontWeight: 700, color: '#fff',
              }}
            >
              Needs you
            </span>
            <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,.72)' }}>
              {attention.length === 0 ? 'nothing right now' : 'most pressing first'}
            </span>
          </div>

          {/* The article you buy most, standing above the passing notices: it
              is the position you are deepest in, and it changes slowly. */}
          {data.topProducts[0] && (
            <button
              onClick={() => onGo('Inventory')}
              title="Show this in inventory"
              style={{
                textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: '#fff',
                border: '1px solid rgba(255,255,255,.28)', background: 'rgba(255,255,255,.16)',
                borderRadius: 14, padding: '9px 10px',
                display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 'none',
              }}
            >
              <Thumb url={data.topProducts[0].imageUrl} size={34} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em',
                    textTransform: 'uppercase', color: 'rgba(255,255,255,.72)',
                  }}
                >
                  Bought most
                </span>
                <span
                  style={{
                    fontSize: 11.5, fontWeight: 700, lineHeight: 1.3,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}
                >
                  {data.topProducts[0].title}
                </span>
                <span className="mono" style={{ fontSize: 10.5, color: 'rgba(255,255,255,.78)' }}>
                  {data.topProducts[0].units}× · {data.topProducts[0].spend}
                </span>
              </span>
            </button>
          )}

          <div
            style={{
              display: 'flex', flexDirection: 'column', gap: 6, flex: 1,
              minHeight: 0, overflow: 'auto',
            }}
          >
            {attention.length === 0 ? (
              <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,.8)', lineHeight: 1.5 }}>
                Nothing is stalled, unmatched or owed. Everything the mail said has been applied.
              </div>
            ) : (
              attention.map((item) => (
                <button
                  key={item.title}
                  onClick={item.go}
                  style={{
                    textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: '#fff',
                    border: '1px solid rgba(255,255,255,.22)', background: 'rgba(255,255,255,.13)',
                    borderRadius: 12, padding: '8px 10px',
                    display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em',
                      textTransform: 'uppercase', color: 'rgba(255,255,255,.72)',
                    }}
                  >
                    {item.kind}
                  </span>
                  <span style={{ fontSize: 11.5, fontWeight: 700, lineHeight: 1.3 }}>{item.title}</span>
                  <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,.72)' }}>{item.meta}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </section>

    </div>
  )
}

function Card({
  title, note, children,
}: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div
      className="section"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, padding: '14px 18px 12px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ fontSize: 14 }}>{title}</h2>
        {note && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{note}</span>}
      </div>
      {children}
    </div>
  )
}

/** Units at each stage, as columns whose height is their share of the largest. */
function Pipeline({ funnel }: { funnel: DashboardView['funnel'] }) {
  const peak = Math.max(1, ...funnel.map((stage) => stage.units))
  const total = funnel.reduce((sum, stage) => sum + stage.units, 0)

  if (total === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-ghost)', padding: '30px 0' }}>
        No units yet. An order becomes one row per unit, and each moves through these stages.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 1, flex: 1, minHeight: 150 }}>
      {funnel.map((stage) => {
        const colour = `oklch(0.76 0.13 ${stage.hue})`
        return (
          <div
            key={stage.label}
            title={`${stage.units} units · ${stage.value}`}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', gap: 5,
              padding: '0 4px', minWidth: 0,
            }}
          >
            <div
              style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '.04em',
                textTransform: 'uppercase', color: 'var(--text-dimmer)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >
              {stage.label}
            </div>
            <div className="mono" style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-.02em' }}>
              {stage.units}
            </div>
            <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end' }}>
              <div
                style={{
                  width: '100%',
                  height: `${Math.max(2, (stage.units / peak) * 100)}%`,
                  background: `color-mix(in oklab, ${colour} 55%, transparent)`,
                  borderTop: `2px solid ${colour}`,
                  borderRadius: '4px 4px 0 0',
                }}
              />
            </div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-ghost)' }}>
              {stage.value}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function NetProfit({
  profit, spend,
}: { profit: DashboardView['profit']; spend: string }) {
  if (profit.salesRecorded === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
        <div className="mono" style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-.03em', color: 'var(--text-dimmer)' }}>
          —
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)', lineHeight: 1.5 }}>
          Profit needs the sell side. No marketplace mail has been recognised yet, so there is no
          revenue to set against cost — showing a number here would mean claiming you sold nothing.
        </div>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 'auto' }}>
          <div className="stat-label">SPENT SO FAR</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>{spend}</div>
        </div>
      </div>
    )
  }

  const positive = profit.netMinor >= 0
  const peak = Math.max(1, ...profit.channels.map((channel) => channel.minor))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9, flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div className="mono" style={{ fontSize: 34, fontWeight: 600, letterSpacing: '-.035em', lineHeight: 1 }}>
          {profit.net}
        </div>
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            background: positive ? 'rgba(110,231,212,.13)' : 'rgba(232,106,160,.13)',
            border: `1px solid ${positive ? 'rgba(110,231,212,.28)' : 'rgba(232,106,160,.28)'}`,
            color: positive ? 'var(--teal)' : 'var(--pink)',
            borderRadius: 999, padding: '4px 9px', fontSize: 11.5, fontWeight: 700,
          }}
        >
          {positive ? '▲' : '▼'} {profit.marginPercent}%
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>
        {profit.revenue} in · {profit.fees} fees
      </div>
      <div
        style={{
          borderTop: '1px solid var(--border)', paddingTop: 10,
          display: 'flex', flexDirection: 'column', gap: 9, flex: 1, minHeight: 0, overflow: 'auto',
        }}
      >
        {profit.channels.map((channel) => (
          <div key={channel.name} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--text-mid)' }}>{channel.name}</span>
              <span className="mono" style={{ marginLeft: 'auto', fontSize: 12 }}>{channel.value}</span>
            </div>
            <div style={{ height: 8, borderRadius: 999, background: '#1d2331', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${(channel.minor / peak) * 100}%`, height: '100%',
                  background: 'var(--grad-cool)',
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Capital({
  data, onGo,
}: { data: DashboardView; onGo: (screen: 'Inventory') => void }) {
  const peak = Math.max(1, ...data.months.map((month) => month.capital))
  const stalled = data.aging.find((band) => band.stalled)

  const points = data.months.map((month, index) => {
    const x = data.months.length === 1 ? 0 : (index / (data.months.length - 1)) * 220
    const y = 96 - (month.capital / peak) * 88
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="mono" style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-.02em' }}>
          {data.stock.capital}
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>{data.stock.units} units</span>
      </div>

      <div style={{ position: 'relative', minHeight: 90 }}>
        {stalled && stalled.units > 0 && (
          <div
            style={{
              position: 'absolute', left: '50%', top: -2, transform: 'translateX(-50%)',
              background: '#1f2635', border: '1px solid var(--border-pill)', borderRadius: 999,
              padding: '3px 9px', fontSize: 10.5, fontWeight: 700, color: '#f0a8c0',
              zIndex: 2, whiteSpace: 'nowrap',
            }}
          >
            {stalled.value} sitting 90+ days
          </div>
        )}
        <svg viewBox="0 0 220 100" preserveAspectRatio="none" style={{ width: '100%', height: 90, display: 'block' }}>
          <path d={`${points} L220,100 L0,100 Z`} fill="rgba(232,106,160,.10)" />
          <path d={points} fill="none" stroke="var(--pink)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>

      <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-ghost)' }}>
        {data.months.map((month) => <span key={month.label}>{month.label}</span>)}
      </div>

      <div
        style={{
          borderTop: '1px solid var(--border)', paddingTop: 9,
          display: 'flex', flexDirection: 'column', gap: 6,
        }}
      >
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-dimmer)' }}>
          AGING · {data.stock.units} UNITS HELD
        </div>
        {data.aging.map((band) => (
          <button
            key={band.bucket}
            onClick={() => onGo('Inventory')}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              border: 0, background: 'transparent', padding: '2px 0',
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mid)', width: 52, textAlign: 'left' }}>
              {band.bucket}d
            </span>
            <span style={{ flex: 1, height: 5, borderRadius: 5, background: '#1d2331', overflow: 'hidden' }}>
              <span
                style={{
                  display: 'block',
                  width: `${data.stock.capitalMinor === 0 ? 0 : (band.minor / data.stock.capitalMinor) * 100}%`,
                  height: '100%',
                  background: band.stalled ? 'var(--pink)' : 'var(--accent)',
                }}
              />
            </span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', width: 22, textAlign: 'right' }}>
              {band.units}
            </span>
            <span
              className="mono"
              style={{
                fontSize: 11, width: 66, textAlign: 'right',
                color: band.stalled && band.units > 0 ? 'var(--pink)' : 'var(--text-dim)',
              }}
            >
              {band.value}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Kpi({
  label, value, meta, hue, fill, alert, onClick,
}: {
  label: string
  value: string
  meta: string
  hue: number
  fill: number
  alert?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="section"
      style={{
        display: 'flex', flexDirection: 'column', gap: 5, textAlign: 'left',
        cursor: 'pointer', fontFamily: 'inherit', color: 'inherit',
        padding: '12px 14px', borderColor: alert ? '#3a2b33' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span
          style={{
            width: 6, height: 6, borderRadius: '50%', flex: 'none',
            background: `oklch(0.76 0.13 ${hue})`,
          }}
        />
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-dimmer)' }}>
          {label}
        </span>
      </div>
      <div style={{ flex: 1 }} />
      <div className="mono" style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-.02em' }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dimmer)', lineHeight: 1.35 }}>{meta}</div>
      <div style={{ height: 4, borderRadius: 4, background: '#1d2331', overflow: 'hidden', marginTop: 2 }}>
        <div
          style={{
            width: `${Math.min(100, Math.max(0, fill * 100))}%`, height: '100%',
            background: `oklch(0.76 0.13 ${hue})`,
          }}
        />
      </div>
    </button>
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
  const height = 130
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

/** Only things that are actually true right now, most costly first. */
function buildAttention(
  data: DashboardView,
  onGo: (screen: 'Inventory' | 'Shipments' | 'Purchases' | 'Settings') => void,
): { kind: string; title: string; meta: string; go: () => void }[] {
  const items: { kind: string; title: string; meta: string; go: () => void }[] = []

  if (data.cancelled.owedMinor > 0) {
    items.push({
      kind: 'Refund outstanding',
      title: `${data.cancelled.owed} owed back to you`,
      meta: `${data.cancelled.units} cancelled units`,
      go: () => onGo('Purchases'),
    })
  }

  const stalled = data.aging.find((band) => band.stalled)
  if (stalled && stalled.units > 0) {
    items.push({
      kind: 'Stalled capital',
      title: `${stalled.value} sitting over 90 days`,
      meta: `${stalled.units} units not moving`,
      go: () => onGo('Inventory'),
    })
  }

  if (data.inFlight.awaitingCode > 0) {
    items.push({
      kind: 'Awaiting tracking',
      title: `${data.inFlight.awaitingCode} parcels without a code`,
      meta: 'resolved automatically every few minutes',
      go: () => onGo('Shipments'),
    })
  }

  if (data.reviewCount > 0) {
    items.push({
      kind: 'Unrecognised mail',
      title: `${data.reviewCount} emails no parser matched`,
      meta: 'export one and a parser can be written',
      go: () => onGo('Settings'),
    })
  }

  return items
}

/**
 * The articles bought most often.
 *
 * Inventory is one row per unit, which answers "what do I hold" but never
 * "what do I keep buying". This does, in the order that matters: most units
 * first, with what they have cost.
 */
function MostBought({
  products,
  onGo,
}: {
  products: DashboardView['topProducts']
  onGo: (screen: 'Inventory' | 'Shipments' | 'Purchases' | 'Settings') => void
}) {
  if (products.length === 0) {
    return (
      <div style={{ fontSize: 11.5, color: 'var(--text-ghost)', lineHeight: 1.5 }}>
        Nothing bought yet. Every article an order brings in is counted here.
      </div>
    )
  }

  const most = products[0]!.units

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, minHeight: 0, overflow: 'auto' }}>
      {products.map((product) => (
        <button
          key={product.title}
          onClick={() => onGo('Inventory')}
          title={`${product.title} · ${product.units} bought · ${product.spend}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, textAlign: 'left',
            border: 0, background: 'transparent', padding: 0, cursor: 'pointer',
            fontFamily: 'inherit', color: 'inherit',
          }}
        >
          <Thumb url={product.imageUrl} size={26} />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
            <span
              style={{
                fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >
              {product.title}
            </span>
            {/* A bar against the biggest, so the shape of the position reads
                without doing the arithmetic. */}
            <span
              style={{
                display: 'block', height: 3, borderRadius: 2, background: '#1c2330', overflow: 'hidden',
              }}
            >
              <span
                style={{
                  display: 'block', height: '100%', background: 'var(--accent)',
                  width: `${Math.max(6, Math.round((product.units / most) * 100))}%`,
                }}
              />
            </span>
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
            <span className="mono" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>
              {product.units}×
            </span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--text-dimmer)' }}>
              {product.spend}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}
