import { useEffect, useRef, useState } from 'react'
import { api, type ActivityView } from './api.js'

/**
 * What the application is doing, in the corner where it can always be reached.
 *
 * Work happens on its own here — mail arrives, barcodes get followed, parcels
 * get redirected — and a spinner that says only "working" invites the question
 * it refuses to answer. This lists each piece of work with the step it has
 * reached, and keeps what recently finished so a run that took two seconds can
 * still be read afterwards.
 */
export function ActivityButton() {
  const [entries, setEntries] = useState<ActivityView[]>([])
  const [open, setOpen] = useState(false)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void api.activity().then(setEntries)
    return api.onActivity(setEntries)
  }, [])

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    // Deferred, or the click that opened it closes it again.
    const timer = setTimeout(() => document.addEventListener('mousedown', away), 0)
    document.addEventListener('keydown', escape)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const running = entries.filter((entry) => entry.state === 'running')
  const failed = entries.filter((entry) => entry.state === 'failed')

  return (
    <div style={{ position: 'relative' }} ref={panel}>
      {open && (
        <div className="activity-panel">
          <div className="activity-head">
            <span>Background work</span>
            <span className="mono" style={{ color: 'var(--text-ghost)' }}>
              {running.length ? `${running.length} running` : 'idle'}
            </span>
          </div>

          {entries.length === 0 && (
            <div className="activity-empty">
              Nothing has run yet. Syncing, tracking lookups and redirects all appear here as they
              happen.
            </div>
          )}

          <div className="activity-list">
            {entries.map((entry) => (
              <div key={entry.id} className="activity-item">
                <span className={`activity-dot activity-dot-${entry.state}`} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span className="activity-label">{entry.label}</span>
                  <span className="activity-step">{entry.step}</span>
                  {entry.state === 'running' && entry.total !== null && entry.total > 0 && (
                    <span className="activity-bar">
                      <span
                        style={{
                          display: 'block', height: '100%', background: 'var(--accent)',
                          width: `${Math.min(100, Math.max(3, ((entry.done ?? 0) / entry.total) * 100))}%`,
                        }}
                      />
                    </span>
                  )}
                </span>
                <span className="activity-time">{clockOf(entry)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        className={`activity-button${running.length > 0 ? ' activity-button-live' : ''}`}
        onClick={() => setOpen((current) => !current)}
        title="What the app is doing in the background"
      >
        <span
          className={`activity-dot ${running.length > 0
            ? 'activity-dot-running'
            : failed.length > 0 ? 'activity-dot-failed' : 'activity-dot-idle'}`}
        />
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {running.length > 0 ? running[0]!.label : 'Background work'}
        </span>
        {running.length > 1 && (
          <span className="mono activity-count">{running.length}</span>
        )}
      </button>
    </div>
  )
}

/** When it started, or how long ago it finished — whichever is the live fact. */
function clockOf(entry: ActivityView): string {
  const stamp = entry.endedAt ?? entry.startedAt
  const at = Date.parse(stamp)
  if (Number.isNaN(at)) return ''

  if (entry.state === 'running') {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
