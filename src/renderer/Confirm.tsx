import { useEffect } from 'react'

/**
 * An in-application confirmation, drawn like the rest of the interface.
 *
 * A native system dialog was doing this job, which looked like it belonged to
 * Windows rather than to the tool — jarring for the one action that deletes
 * everything. Escape cancels, so the safe outcome is always one key away.
 */
export function Confirm({
  title,
  body,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: {
  title: string
  body: React.ReactNode
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="modal-scrim" onClick={onCancel}>
      <div
        className="modal"
        style={{ width: 420, borderColor: destructive ? '#43303a' : 'var(--border-input)' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-chrome">
          <span className="modal-pip" />
          <span className="modal-pip" />
          <span className="modal-pip" />
          <span className="modal-chrome-title">{title}</span>
          <button className="modal-x" onClick={onCancel} aria-label="Cancel">×</button>
        </div>

        <div className="modal-body">
          <div style={{ display: 'flex', gap: 13, alignItems: 'flex-start' }}>
            <div
              style={{
                width: 38, height: 38, flex: 'none', borderRadius: 12,
                background: destructive
                  ? 'linear-gradient(140deg,#f7a08a,#e86aa0)'
                  : 'var(--grad-cool)',
              }}
            />
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
              {body}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 2 }}>
            {/* Cancel comes first and is the default: the destructive action
                should never be the one your hand lands on. */}
            <button
              className="btn"
              style={{ padding: '9px 16px' }}
              onClick={onCancel}
              autoFocus
            >
              Cancel
            </button>
            <button
              className="btn"
              style={{
                padding: '9px 16px', fontWeight: 700, border: 0,
                background: destructive ? '#e8386f' : 'var(--accent)',
                color: destructive ? '#fff' : '#0b1020',
              }}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
