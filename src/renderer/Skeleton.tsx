/**
 * Placeholder shapes shown while data loads.
 *
 * They mirror the layout that is about to appear rather than being generic
 * bars, so the page does not visibly rearrange when the real rows arrive.
 */

export function SkeletonLine({ width = '100%', height = 12 }: { width?: string; height?: number }) {
  return <span className="skeleton" style={{ width, height, borderRadius: 6 }} />
}

/** A stand-in for a table, matching the column layout it replaces. */
export function SkeletonTable({
  columns,
  rows = 8,
  minWidth,
}: {
  columns: string
  rows?: number
  minWidth?: number
}) {
  return (
    <div className="table">
      <div className="table-scroll">
        <div className="thead" style={{ minWidth, gridTemplateColumns: columns }}>
          {columns.split(' ').map((_, index) => (
            <SkeletonLine key={index} width="60%" height={9} />
          ))}
        </div>
        {Array.from({ length: rows }, (_, rowIndex) => (
          <div
            key={rowIndex}
            className="trow"
            style={{ minWidth, gridTemplateColumns: columns, cursor: 'default' }}
          >
            {columns.split(' ').map((_, cellIndex) => (
              <SkeletonLine
                key={cellIndex}
                // Varying widths read as content rather than as a grid of bars.
                width={`${55 + ((rowIndex * 7 + cellIndex * 13) % 40)}%`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/** A stand-in for a stack of cards, as the Review and Logs screens use. */
export function SkeletonCards({ count = 4, height = 96 }: { count?: number; height?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="section" style={{ height, display: 'flex', flexDirection: 'column', gap: 9 }}>
          <SkeletonLine width="30%" height={11} />
          <SkeletonLine width="65%" />
          <SkeletonLine width="90%" height={10} />
        </div>
      ))}
    </div>
  )
}

export function SkeletonDashboard() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
      <section style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 13 }}>
        <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 190 }}>
          <SkeletonLine width="28%" height={11} />
          <SkeletonLine width="45%" height={30} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginTop: 'auto' }}>
            <SkeletonLine width="70%" height={13} />
            <SkeletonLine width="70%" height={13} />
            <SkeletonLine width="70%" height={13} />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
          <div className="section" style={{ flex: 1, minHeight: 88 }} />
          <div className="section" style={{ flex: 1, minHeight: 88 }} />
        </div>
      </section>
      <div className="section" style={{ height: 110 }} />
    </div>
  )
}
