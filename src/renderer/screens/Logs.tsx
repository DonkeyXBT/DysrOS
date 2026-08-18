import { useEffect, useState } from 'react'
import { api, type LogEntryView } from '../api.js'
import { Pager, usePaged } from '../Pager.js'
import { SkeletonCards } from '../Skeleton.js'

const LEVEL_COLOR: Record<string, string> = {
  error: 'oklch(0.70 0.17 18)',
  warn: 'oklch(0.74 0.11 65)',
  info: 'oklch(0.68 0.02 265)',
}

/**
 * What went wrong, kept after the fact.
 *
 * A crash during a sync leaves nothing to look at once the window is gone, so
 * every failure is written to a file as it happens and shown here. Reporting is
 * a deliberate click rather than automatic: the report goes to a public
 * repository, and it is worth seeing what is being published first — even
 * though addresses, order references and user paths are stripped out.
 */
export function Logs() {
  const [entries, setEntries] = useState<LogEntryView[] | null>(null)
  const [levelFilter, setLevelFilter] = useState<'all' | 'error' | 'warn'>('all')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [logPath, setLogPath] = useState('')

  const refresh = () => {
    void api.logEntries().then(setEntries)
  }

  useEffect(() => {
    refresh()
    void api.logPath().then(setLogPath)
    const timer = setInterval(refresh, 4000)
    return () => clearInterval(timer)
  }, [])

  const all = entries ?? []
  const filtered = all.filter((e) => levelFilter === 'all' || e.level === levelFilter)
  const paged = usePaged(filtered, levelFilter)

  const counts = {
    all: all.length,
    error: all.filter((e) => e.level === 'error').length,
    warn: all.filter((e) => e.level === 'warn').length,
  }

  if (!entries) return <SkeletonCards count={6} height={54} />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        {(['all', 'error', 'warn'] as const).map((level) => (
          <button
            key={level}
            className="btn"
            onClick={() => setLevelFilter(level)}
            style={
              levelFilter === level
                ? { background: '#242c3e', color: 'var(--text)', borderColor: '#3a4a6a' }
                : undefined
            }
          >
            {level === 'all' ? 'Everything' : level === 'error' ? 'Errors' : 'Warnings'}{' '}
            <span className="mono" style={{ opacity: .6 }}>{counts[level]}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => void api.logOpenFolder()}>Open log folder</button>
        <button className="btn" onClick={() => void api.logClear().then(refresh)}>Clear view</button>
      </div>

      {counts.error === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          No errors recorded. Warnings are normal — a mailbox refusing a password is a warning,
          not a crash.
        </div>
      )}

      {all.length === 0 ? (
        <div className="empty" style={{ margin: '50px auto' }}>
          <div className="empty-title">Nothing logged yet</div>
          <div className="empty-body">
            Failures are written to disk as they happen, so they survive a crash.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {paged.visible.map((entry, index) => {
            const absoluteIndex = paged.page * 50 + index
            const isOpen = expanded === absoluteIndex
            return (
              <div
                key={`${entry.at}-${absoluteIndex}`}
                className="section"
                style={{ padding: '10px 13px', display: 'flex', flexDirection: 'column', gap: 7 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span
                    className="chip"
                    style={{
                      color: LEVEL_COLOR[entry.level],
                      background: `color-mix(in oklab, ${LEVEL_COLOR[entry.level]} 14%, transparent)`,
                      border: `1px solid color-mix(in oklab, ${LEVEL_COLOR[entry.level]} 30%, transparent)`,
                    }}
                  >
                    {entry.level}
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--text-dimmer)' }}>
                    {entry.at.slice(0, 19).replace('T', ' ')}
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--accent-soft)' }}>
                    {entry.source}
                  </span>
                  <span
                    style={{
                      fontSize: 12.5, color: 'var(--text-soft)', flex: 1, minWidth: 0,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}
                  >
                    {entry.message}
                  </span>
                  {entry.detail && (
                    <button
                      className="btn"
                      onClick={() => setExpanded(isOpen ? null : absoluteIndex)}
                    >
                      {isOpen ? 'Hide' : 'Detail'}
                    </button>
                  )}
                  {entry.level === 'error' && (
                    <button
                      className="btn"
                      onClick={async () => {
                        const report = await api.crashReportUrl(absoluteIndex)
                        if (report) void api.openExternal(report.url)
                      }}
                    >
                      Report on GitHub
                    </button>
                  )}
                </div>

                {isOpen && entry.detail && (
                  <pre
                    className="mono"
                    style={{
                      margin: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--text-dim)',
                      background: 'var(--sunken)', border: '1px solid var(--border-soft)',
                      borderRadius: 10, padding: '10px 12px', overflowX: 'auto',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300,
                    }}
                  >
                    {entry.detail}
                  </pre>
                )}
              </div>
            )
          })}
        </div>
      )}

      <Pager
        page={paged.page}
        pageCount={paged.pageCount}
        from={paged.from}
        to={paged.to}
        total={paged.total}
        noun="entries"
        onPage={paged.setPage}
      />

      <div style={{ fontSize: 11, color: 'var(--text-ghost)', paddingLeft: 4, lineHeight: 1.5 }}>
        Written to <span className="mono">{logPath}</span> as it happens, so a crash cannot take
        it with it. Reports have email addresses, order references, tracking codes, postcodes and
        user paths removed before they leave this machine.
      </div>
    </div>
  )
}
