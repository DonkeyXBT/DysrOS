import { useEffect, useState } from 'react'
import { api } from './api.js'

interface UpdateStatus {
  configured: boolean
  currentVersion: string
  available: boolean
  reason?: string
  version?: string
  sizeLabel?: string
  notes?: string[]
}

/**
 * The software update dialog.
 *
 * Updates come from GitHub Releases via electron-updater. Nothing is downloaded
 * without being asked for, and the progress bar reflects a real download rather
 * than a timer. Running from source has no packaged build to replace, so the
 * dialog says that instead of pretending to check.
 */
export function Updater({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [rate, setRate] = useState('')
  const [downloaded, setDownloaded] = useState(false)

  useEffect(() => {
    void api.checkForUpdate().then(setStatus)
    const offProgress = api.onUpdateProgress((p) => {
      setProgress(p.percent)
      setRate(`${(p.bytesPerSecond / 1_000_000).toFixed(1)} MB/s`)
    })
    const offDone = api.onUpdateDownloaded(() => {
      setDownloaded(true)
      setProgress(100)
    })
    return () => {
      offProgress()
      offDone()
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const upToDate = status !== null && !status.available

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-chrome">
          <span className="modal-pip" />
          <span className="modal-pip" />
          <span className="modal-pip" />
          <span className="modal-chrome-title">Software update</span>
          <button className="modal-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
            <div
              style={{
                width: 44, height: 44, flex: 'none', borderRadius: 14,
                background: status?.available ? 'var(--grad-cool)' : 'linear-gradient(140deg,#2b3346,#1f2532)',
              }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-.02em' }}>
                {status === null
                  ? 'Checking for updates'
                  : status.available
                    ? `Version ${status.version} is available`
                    : 'No updates available'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                {status === null
                  ? 'Contacting the update channel.'
                  : status.available
                    ? `You are on ${status.currentVersion}. The update downloads in the background; you can keep working.`
                    : `You are on ${status.currentVersion}.`}
              </div>
            </div>
          </div>

          {status !== null && !status.configured && (
            <div className="notice-warm">
              <span className="notice-dot" />
              <span>
                {status.reason} Updates will be reported here once one is set up — nothing is
                downloaded or installed in the meantime.
              </span>
            </div>
          )}

          {status?.available && status.notes && status.notes.length > 0 && (
            <div className="modal-panel">
              <div className="modal-panel-label">WHAT CHANGED</div>
              {status.notes.map((note) => (
                <div key={note} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                  <span
                    style={{
                      width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)',
                      marginTop: 6, flex: 'none',
                    }}
                  />
                  <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-muted)' }}>
                    {note}
                  </span>
                </div>
              ))}
            </div>
          )}

          {progress !== null && !downloaded && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={{ height: 6, borderRadius: 6, background: '#1d2331', overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${Math.min(100, progress)}%`, height: '100%',
                    background: 'var(--grad-cool)', transition: 'width .12s linear',
                  }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-mid)' }}>
                  {Math.round(progress)}%
                </span>
                <span
                  className="mono"
                  style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dimmer)' }}
                >
                  {rate}
                </span>
              </div>
            </div>
          )}

          {downloaded && (
            <div className="modal-panel">
              <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Downloaded and verified. It installs when you restart — your database is migrated
                on the next launch.
              </span>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 2 }}>
            <button
              className="btn btn-primary"
              style={{ padding: '9px 16px' }}
              onClick={() => {
                if (downloaded) void api.installUpdate()
                else if (status?.available) void api.downloadUpdate()
                else onClose()
              }}
            >
              {downloaded
                ? 'Restart and install'
                : progress !== null
                  ? 'Downloading…'
                  : upToDate ? 'Close' : 'Download and install'}
            </button>
            {!upToDate && (
              <button className="btn" style={{ padding: '9px 16px' }} onClick={onClose}>
                {progress !== null ? 'Run in background' : 'Later'}
              </button>
            )}
            <span
              className="mono"
              style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-ghost)' }}
            >
              {status?.sizeLabel ?? status?.currentVersion ?? ''}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
