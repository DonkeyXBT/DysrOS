import { useEffect, useMemo, useState } from 'react'
import { api, type ActivityRowView, type BestSellerView, type DashboardView, type SeriesPointView } from '../api.js'
import { SkeletonDashboard } from '../Skeleton.js'
import { Thumb } from '../Thumb.js'

/**
 * The dashboard: what is coming, what is held, what sells, and what happened.
 *
 * Every figure is computed from what the mail actually said or what someone
 * recorded by hand. Where a figure cannot be known — profit on goods bought
 * outside this application, a best seller before anything has sold — the tile
 * says so rather than showing a confident zero, which reads as "you made
 * nothing" when the truth is "nobody knows yet".
 */
export function Dashboard({
  onGo,
  onSync,
  dataVersion,
  hasMail,
  mailbox,
}: {
  onGo: (screen: 'Inventory' | 'Shipments' | 'Purchases' | 'Sales' | 'Reports' | 'Settings') => void
  onSync: () => void
  dataVersion: number
  hasMail: boolean
  mailbox: string | null
}) {
  const [data, setData] = useState<DashboardView | null>(null)

  useEffect(() => {
    void api.dashboard().then(setData)
  }, [dataVersion])

  if (!data) return <SkeletonDashboard />

  if (!hasMail) {
    return (
      <div className="empty" style={{ margin: '80px auto' }}>
        <div className="empty-title">Nothing collected yet</div>
        <div className="empty-body">
          Connect a mailbox in Settings and this fills itself: orders, parcels and cancellations
          are read as they arrive.
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="btn" onClick={() => onGo('Settings')}>Connect a mailbox</button>
          <button className="btn" onClick={onSync}>Sync now</button>
        </div>
      </div>
    )
  }

  return (
    <div className="screen dash">
      <Greeting mailbox={mailbox} pending={data.pending} />

      <div className="dash-kpis">
        <Kpi
          label="Pending orders"
          value={String(data.pending.units)}
          note="awaiting arrival"
          foot={data.pending.oldestDays === null
            ? data.pending.value
            : `${data.pending.value} · oldest ${data.pending.oldestDays}d`}
          hue={40}
          onClick={() => onGo('Purchases')}
        />
        <Kpi
          label="Inventory"
          value={String(data.stock.units)}
          note="items in stock"
          foot={`${data.stock.capital} tied up`}
          hue={148}
          onClick={() => onGo('Inventory')}
        />
        <Kpi
          label="Profit"
          value={data.profit.salesRecorded === 0 ? '—' : data.profit.net}
          note={data.profit.salesRecorded === 0 ? 'nothing sold yet' : `${data.profit.salesRecorded} sales`}
          foot={data.profit.uncosted > 0
            ? `${data.profit.uncosted} without a known cost`
            : `${data.profit.revenue} in · ${data.money.out} out`}
          hue={165}
          accent
          onClick={() => onGo('Sales')}
        />
        <Kpi
          label="In transit"
          value={String(data.inFlight.parcels)}
          note="parcels on the way"
          foot={data.inFlight.awaitingCode > 0
            ? `${data.inFlight.awaitingCode} awaiting a code`
            : 'every parcel tracked'}
          hue={232}
          onClick={() => onGo('Shipments')}
        />
        <Kpi
          label="BTW position"
          value={data.vat.balance}
          note={data.vat.balanceMinor >= 0 ? 'owed to the tax office' : 'to reclaim'}
          foot={`${data.vat.collectedOnSales} collected · ${data.vat.paidOnPurchases} paid`}
          hue={285}
          onClick={() => onGo('Reports')}
        />
      </div>

      <div className="dash-middle">
        <BestSeller
          best={data.bestSellers[0] ?? null}
          runnerUp={data.bestSellers[1] ?? null}
          allTime={data.allTimeBest}
          onGo={onGo}
        />
        <RevenueChart initial={data.salesSeries} />
      </div>

      <div className="dash-bottom">
        <TopProducts products={data.topProducts} onGo={onGo} />
        <RecentActivity rows={data.activity} onGo={onGo} />
      </div>
    </div>
  )
}

/** The time of day, the mailbox, and the one thing most worth doing. */
function Greeting({
  mailbox,
  pending,
}: {
  mailbox: string | null
  pending: DashboardView['pending']
}) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  const hour = now.getHours()
  const partOfDay = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  const name = (mailbox ?? '').split('@')[0] || 'there'

  return (
    <div className="dash-hello">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <span className="stat-label">DASHBOARD</span>
        <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-.02em' }}>
          Good {partOfDay}, {name}
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
          {pending.units === 0
            ? 'Nothing is outstanding. Everything ordered has arrived.'
            : `${pending.units} unit${pending.units === 1 ? '' : 's'} still on the way, ${pending.value} of stock in transit.`}
        </span>
      </div>

      <div className="dash-clock">
        <span className="stat-label">DATE &amp; TIME</span>
        <span className="mono" style={{ fontSize: 21, fontWeight: 700, letterSpacing: '.04em' }}>
          {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-dimmer)' }}>
          {now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </span>
      </div>
    </div>
  )
}

function Kpi({
  label, value, note, foot, hue, accent, onClick,
}: {
  label: string
  value: string
  note: string
  foot: string
  hue: number
  accent?: boolean
  onClick: () => void
}) {
  return (
    <button className="dash-kpi" onClick={onClick}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="stat-label">{label.toUpperCase()}</span>
        <span
          style={{
            marginLeft: 'auto', width: 22, height: 22, borderRadius: 8,
            background: `oklch(0.72 0.13 ${hue} / .18)`,
            border: `1px solid oklch(0.72 0.13 ${hue} / .35)`,
          }}
        />
      </div>
      <span
        className="mono"
        style={{
          fontSize: 24, fontWeight: 700,
          color: accent ? `oklch(0.78 0.13 ${hue})` : 'var(--text-bright)',
        }}
      >
        {value}
      </span>
      <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{note}</span>
      <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-dimmer)', marginTop: 'auto' }}>
        {foot}
      </span>
    </button>
  )
}

/** What sells, which is a different question from what you buy. */
function BestSeller({
  best,
  runnerUp,
  allTime,
  onGo,
}: {
  best: BestSellerView | null
  runnerUp: BestSellerView | null
  allTime: BestSellerView | null
  onGo: (screen: 'Sales') => void
}) {
  if (!best) {
    return (
      <section className="section dash-best">
        <div className="section-head" style={{ marginBottom: 0 }}>
          <h2>Best seller</h2>
          <span className="section-note">nothing sold yet</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          Sell a unit — from Inventory, or by connecting a marketplace mailbox — and the article
          that sells best appears here with what it earned.
        </div>
      </section>
    )
  }

  return (
    <section className="section dash-best">
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', minWidth: 0 }}>
        <Thumb url={best.imageUrl} size={72} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="chip chip-best">BEST SELLER</span>
            <span style={{ fontSize: 10.5, color: 'var(--text-dimmer)' }}>last 30 days</span>
          </div>
          <span
            style={{
              fontSize: 15, fontWeight: 700, lineHeight: 1.25,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
            title={best.title}
          >
            {best.title}
          </span>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-dimmer)' }}>
            latest sale {best.lastSoldAt.slice(0, 10)}
          </span>
        </div>
      </div>

      <div className="dash-best-figures">
        <Figure label="SOLD" value={String(best.units)} />
        <Figure label="REVENUE" value={best.revenue} />
        <Figure
          label="PROFIT"
          value={best.profit ?? '—'}
          accent={best.profitMinor === null ? undefined : best.profitMinor >= 0}
          note={best.profit === null ? 'bought elsewhere' : undefined}
        />
      </div>

      <div className="dash-best-also">
        <Aside label="RUNNER UP" value={runnerUp?.title ?? '—'} />
        <Aside label="ALL-TIME BEST" value={allTime?.title ?? '—'} />
      </div>

      <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => onGo('Sales')}>
        See every sale
      </button>
    </section>
  )
}

function Figure({
  label, value, accent, note,
}: { label: string; value: string; accent?: boolean; note?: string }) {
  return (
    <div className="dash-figure">
      <span className="stat-label">{label}</span>
      <span
        className="mono"
        style={{
          fontSize: 16, fontWeight: 700,
          color: accent === undefined ? 'var(--text)' : accent ? 'var(--teal)' : 'var(--pink)',
        }}
      >
        {value}
      </span>
      {note && <span style={{ fontSize: 10, color: 'var(--text-ghost)' }}>{note}</span>}
    </div>
  )
}

function Aside({ label, value }: { label: string; value: string }) {
  return (
    <div className="dash-aside">
      <span className="stat-label">{label}</span>
      <span
        style={{
          fontSize: 11.5, color: 'var(--text-muted)', whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis',
        }}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

const RANGES: { label: string; days: number | null }[] = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: 'All time', days: null },
]

/** Revenue against profit, over whichever span is asked for. */
function RevenueChart({ initial }: { initial: SeriesPointView[] }) {
  const [days, setDays] = useState<number | null>(30)
  const [series, setSeries] = useState(initial)
  const [show, setShow] = useState<'both' | 'revenue' | 'profit'>('both')

  useEffect(() => {
    if (days === 30) return setSeries(initial)
    void api.salesSeries(days).then(setSeries)
  }, [days, initial])

  const peak = Math.max(1, ...series.flatMap((point) => [point.revenueMinor, point.profitMinor]))
  const height = 168

  return (
    <section className="section dash-chart">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <h2 style={{ margin: 0, fontSize: 13.5 }}>Revenue &amp; profit</h2>
          <span className="section-note">from recorded sales</span>
        </div>

        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {(['both', 'revenue', 'profit'] as const).map((option) => (
            <Toggle key={option} active={show === option} onClick={() => setShow(option)}>
              {option === 'both' ? 'Both' : option === 'revenue' ? 'Revenue' : 'Profit'}
            </Toggle>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {RANGES.map((range) => (
            <Toggle key={range.label} active={days === range.days} onClick={() => setDays(range.days)}>
              {range.label}
            </Toggle>
          ))}
        </div>
      </div>

      {series.length === 0 ? (
        <div
          style={{
            flex: 1, minHeight: height, display: 'flex', alignItems: 'center',
            justifyContent: 'center', border: '1px dashed var(--border-strong)',
            borderRadius: 14, fontSize: 12, color: 'var(--text-ghost)',
          }}
        >
          No sales recorded in this period.
        </div>
      ) : (
        <>
          <svg
            viewBox={`0 0 100 ${height}`}
            preserveAspectRatio="none"
            style={{ width: '100%', height, display: 'block' }}
            role="img"
            aria-label="Revenue and profit over time"
          >
            {[0.25, 0.5, 0.75, 1].map((fraction) => (
              <line
                key={fraction}
                x1="0" x2="100"
                y1={height - fraction * height} y2={height - fraction * height}
                stroke="#1f2532" strokeWidth="0.5" vectorEffect="non-scaling-stroke"
              />
            ))}
            {show !== 'profit' && (
              <Line points={series.map((p) => p.revenueMinor)} peak={peak} height={height} colour="var(--accent)" />
            )}
            {show !== 'revenue' && (
              <Line points={series.map((p) => p.profitMinor)} peak={peak} height={height} colour="var(--teal)" />
            )}
          </svg>

          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            {show !== 'profit' && <Legend colour="var(--accent)" label="Revenue" />}
            {show !== 'revenue' && <Legend colour="var(--teal)" label="Profit" />}
            <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-ghost)' }}>
              {series.length === 1
                ? series[0]!.period
                : `${series[0]?.period} → ${series[series.length - 1]?.period}`}
            </span>
          </div>
        </>
      )}
    </section>
  )
}

function Line({
  points, peak, height, colour,
}: { points: number[]; peak: number; height: number; colour: string }) {
  if (points.length === 0) return null

  const y = (value: number) => height - (value / peak) * (height - 12)
  // One period is a level, not a slope: a single point drawn as a line from
  // zero invents a trend that the data does not show.
  const coordinates = points.length === 1
    ? [[0, y(points[0]!)], [100, y(points[0]!)]] as const
    : points.map((value, index) => [(index * 100) / (points.length - 1), y(value)] as const)

  const path = coordinates
    .map(([x, top], index) => `${index === 0 ? 'M' : 'L'} ${x} ${top}`)
    .join(' ')

  return (
    <>
      <path d={`${path} L 100 ${height} L 0 ${height} Z`} fill={colour} opacity={0.09} />
      <path d={path} fill="none" stroke={colour} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      {/* Marked while there are few enough periods to tell apart, so a short
          span reads as the handful of days it is. */}
      {points.length <= 10 && coordinates.map(([x, top], index) => (
        <circle
          key={index}
          cx={x} cy={top} r="2.4"
          fill={colour}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </>
  )
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 8, height: 8, borderRadius: 999, background: colour }} />
      <span style={{ fontSize: 11, color: 'var(--text-dimmer)' }}>{label}</span>
    </span>
  )
}

function Toggle({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="btn"
      onClick={onClick}
      style={{
        padding: '3px 9px', fontSize: 10.5,
        ...(active ? { background: '#242c3e', color: 'var(--text)', borderColor: '#3a4a6a' } : {}),
      }}
    >
      {children}
    </button>
  )
}

/** What is bought most, which is where the money is committed. */
function TopProducts({
  products,
  onGo,
}: {
  products: DashboardView['topProducts']
  onGo: (screen: 'Inventory') => void
}) {
  const most = products[0]?.units ?? 1

  return (
    <section className="section">
      <div className="section-head" style={{ marginBottom: 0 }}>
        <h2>Bought most</h2>
        <span className="section-note">units of each article</span>
      </div>

      {products.length === 0 ? (
        <div style={{ fontSize: 11.5, color: 'var(--text-ghost)' }}>
          Nothing bought yet. Every article an order brings in is counted here.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflow: 'auto' }}>
          {products.slice(0, 5).map((product) => (
            <button
              key={product.title}
              onClick={() => onGo('Inventory')}
              style={{
                display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, textAlign: 'left',
                border: 0, background: 'transparent', padding: 0, cursor: 'pointer',
                fontFamily: 'inherit', color: 'inherit',
              }}
            >
              <Thumb url={product.imageUrl} size={26} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
                <span
                  style={{
                    fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}
                >
                  {product.title}
                </span>
                <span style={{ display: 'block', height: 3, borderRadius: 2, background: '#1c2330' }}>
                  <span
                    style={{
                      display: 'block', height: '100%', background: 'var(--accent)',
                      width: `${Math.max(6, Math.round((product.units / most) * 100))}%`,
                    }}
                  />
                </span>
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                <span className="mono" style={{ fontSize: 12.5, fontWeight: 700 }}>{product.units}×</span>
                <span className="mono" style={{ fontSize: 10, color: 'var(--text-dimmer)' }}>
                  {product.spend}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

const ACTIVITY_KINDS: { key: ActivityRowView['kind'] | 'all'; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'order', label: 'Orders' },
  { key: 'sale', label: 'Sales' },
  { key: 'parcel', label: 'Parcels' },
]

/** The latest thing that happened, whatever kind of thing it was. */
function RecentActivity({
  rows,
  onGo,
}: {
  rows: ActivityRowView[]
  onGo: (screen: 'Inventory' | 'Shipments' | 'Purchases' | 'Sales') => void
}) {
  const [kind, setKind] = useState<ActivityRowView['kind'] | 'all'>('all')
  const shown = useMemo(
    () => rows.filter((row) => kind === 'all' || row.kind === kind),
    [rows, kind],
  )

  return (
    <section className="section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <h2 style={{ margin: 0, fontSize: 13.5 }}>Recent activity</h2>
          <span className="section-note">newest first</span>
        </div>
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {ACTIVITY_KINDS.map((option) => (
            <Toggle key={option.key} active={kind === option.key} onClick={() => setKind(option.key)}>
              {option.label}
            </Toggle>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <div style={{ fontSize: 11.5, color: 'var(--text-ghost)' }}>Nothing of that kind yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, overflow: 'auto' }}>
          {shown.map((row) => (
            <button
              key={`${row.kind}-${row.id}`}
              className="dash-activity"
              onClick={() => onGo(row.kind === 'sale' ? 'Sales' : row.kind === 'parcel' ? 'Shipments' : 'Purchases')}
            >
              <Thumb url={row.imageUrl} size={28} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                <span
                  style={{
                    fontSize: 11.5, fontWeight: 700, color: 'var(--text)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}
                >
                  {row.title}
                </span>
                <span className="mono" style={{ fontSize: 10, color: 'var(--text-dimmer)' }}>
                  {row.meta} · {row.at.slice(0, 10)}
                </span>
              </span>
              {row.amount && (
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {row.amount}
                </span>
              )}
              <span className={`chip chip-${row.kind}`}>{statusLabel(row)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function statusLabel(row: ActivityRowView): string {
  if (row.kind === 'sale') return 'Sold'
  const words: Record<string, string> = {
    pending: 'Awaiting code',
    in_transit: 'In transit',
    out_for_delivery: 'Out for delivery',
    ready_for_pickup: 'At a point',
    delivered: 'Delivered',
    confirmed: 'Ordered',
    cancelled: 'Cancelled',
  }
  return words[row.status] ?? row.status
}
