import { useEffect, useState } from 'react'
import { api, type RedirectReportView, type ShipmentView } from './api.js'

/**
 * Sending parcels to a DHL ServicePoint.
 *
 * This changes where real parcels go, so it names exactly which ones before it
 * starts, shows what is happening while it runs, and reports every parcel
 * afterwards — including the ones DHL refused. A test run walks the whole path
 * and stops before the last click, which is how the sequence can be checked
 * without committing to anything.
 */
export function RedirectDialog({
  parcels,
  onClose,
  onDone,
}: {
  parcels: ShipmentView[]
  onClose: () => void
  onDone: () => void
}) {
  const [email, setEmail] = useState('')
  const [dryRun, setDryRun] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; step: string } | null>(null)
  const [reports, setReports] = useState<RedirectReportView[] | null>(null)

  useEffect(() => {
    void api.redirectEmail().then((value) => setEmail(value ?? ''))
    return api.onRedirectProgress((update) => {
      setProgress({ done: update.done, total: update.total, step: update.step })
    })
  }, [])

  const start = async () => {
    setRunning(true)
    setReports(null)
    try {
      await api.setRedirectEmail(email)
      setReports(await api.redirectParcels(parcels.map((parcel) => parcel.id), dryRun))
      onDone()
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const title = reports
    ? 'Redirect finished'
    : `Send ${parcels.length} parcel${parcels.length === 1 ? '' : 's'} to a ServicePoint`

  return (
    <div className="modal-scrim" onClick={running ? undefined : onClose}>
      <div
        className="modal"
        style={{ width: 540 }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-chrome">
          <span className="modal-pip" />
          <span className="modal-pip" />
          <span className="modal-pip" />
          <span className="modal-chrome-title">{title}</span>
          {!running && (
            <button className="modal-x" onClick={onClose} aria-label="Close">×</button>
          )}
        </div>

        <div className="modal-body">
          {!reports && (
            <>
              <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
                DHL will take {parcels.length === 1 ? 'this parcel' : 'these parcels'} to the
                nearest ServicePoint instead of your door. It happens on DHL&apos;s own page, in a
                window you can watch, and only while DHL still offers the choice.
              </div>

              <div className="modal-panel">
                <span className="modal-panel-label">PARCELS</span>
                {parcels.map((parcel) => (
                  <div
                    key={parcel.id}
                    style={{ display: 'flex', gap: 9, alignItems: 'baseline', minWidth: 0 }}
                  >
                    <span className="mono" style={{ fontSize: 11.5, color: 'var(--text)' }}>
                      {parcel.trackingNumber}
                    </span>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-dimmer)' }}>
                      {parcel.postalCode}
                    </span>
                    <span
                      style={{
                        fontSize: 11.5, color: 'var(--text-dim)', minWidth: 0,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}
                    >
                      {parcel.title ?? '—'}
                    </span>
                  </div>
                ))}
              </div>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="modal-panel-label">DHL SENDS THE CONFIRMATION TO</span>
                <input
                  className="field-input"
                  value={email}
                  placeholder="you@example.com"
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={running}
                />
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={dryRun}
                  disabled={running}
                  onChange={(event) => setDryRun(event.target.checked)}
                />
                <span style={{ color: 'var(--text-muted)' }}>
                  Test run — everything except the final confirm
                </span>
              </label>

              {progress && (
                <div className="modal-panel" style={{ gap: 4 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--accent-bright)' }}>
                    Parcel {Math.min(progress.done + 1, progress.total)} of {progress.total}
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{progress.step}</span>
                </div>
              )}
            </>
          )}

          {reports && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
              {reports.map((report) => (
                <div
                  key={report.id}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 3, padding: '9px 11px',
                    borderRadius: 12,
                    border: `1px solid ${report.ok ? '#25443a' : '#4a4030'}`,
                    background: report.ok ? 'rgba(93,224,183,.07)' : 'rgba(247,160,138,.08)',
                  }}
                >
                  <span
                    className="mono"
                    style={{ fontSize: 11.5, color: report.ok ? 'var(--teal)' : '#f2c3b4' }}
                  >
                    {report.trackingNumber ?? 'unknown parcel'}
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                    {report.message}
                  </span>
                  {report.servicePoint?.address && (
                    <span style={{ fontSize: 11, color: 'var(--text-dimmer)' }}>
                      {report.servicePoint.address}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 2 }}>
            {reports ? (
              <button className="btn" style={{ padding: '9px 16px' }} onClick={onClose} autoFocus>
                Close
              </button>
            ) : (
              <>
                <button
                  className="btn"
                  style={{ padding: '9px 16px' }}
                  onClick={onClose}
                  disabled={running}
                  autoFocus
                >
                  Cancel
                </button>
                <button
                  className="btn"
                  style={{
                    padding: '9px 16px', fontWeight: 700, border: 0,
                    background: 'var(--accent)', color: '#0b1020',
                  }}
                  onClick={() => void start()}
                  disabled={running || parcels.length === 0}
                >
                  {running ? 'Working…' : dryRun ? 'Start test run' : `Redirect ${parcels.length}`}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
