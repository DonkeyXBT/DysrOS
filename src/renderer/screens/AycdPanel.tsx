import { useEffect, useState } from 'react'
import { api, type AycdStatusView } from '../api.js'

/**
 * AYCD Inbox capture.
 *
 * Worth being plain about what this is, because it is not a second mailbox
 * connection: Inbox only ever watches for mail that arrives *after* a task is
 * registered. It cannot fetch anything already in a mailbox, and it returns
 * only the fields a task asked for rather than the message, so a capture can
 * never be re-parsed later the way IMAP-fetched mail can.
 */
export function AycdPanel() {
  const [status, setStatus] = useState<AycdStatusView | null>(null)
  const [key, setKey] = useState('')
  const [addresses, setAddresses] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const refresh = () => {
    void api.aycdStatus().then((s) => {
      setStatus(s)
      setAddresses(s.addresses.join('\n'))
    })
  }

  useEffect(refresh, [])

  // Poll while capture is running so the tally is not frozen on screen.
  useEffect(() => {
    if (!status?.running) return
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [status?.running])

  const run = async (action: () => Promise<{ ok?: boolean; started?: boolean; message?: string }>) => {
    setBusy(true)
    setNote(null)
    try {
      const result = await action()
      if (result.message) {
        setNote({ ok: result.ok ?? result.started ?? true, text: result.message })
      }
      refresh()
    } catch (error) {
      setNote({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  if (!status) return null

  return (
    <section className="section" style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      <div className="section-head" style={{ marginBottom: 0 }}>
        <h2>AYCD Inbox</h2>
        <span className="section-note">catches mail as it arrives</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 7, height: 7, borderRadius: '50%',
              background: status.running
                ? 'oklch(0.78 0.12 148)'
                : status.configured ? 'oklch(0.74 0.11 65)' : 'oklch(0.66 0.02 265)',
              animation: status.running ? 'pulseGlow 2s ease-in-out infinite' : 'none',
            }}
          />
          <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
            {status.running ? 'Watching' : status.configured ? 'Idle' : 'Not configured'}
          </span>
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)', lineHeight: 1.55 }}>
        Watches mail arriving from now on: it cannot read what is already in a mailbox, so it
        complements the IMAP connection rather than replacing it. The Inbox application must be
        running; the key is in its Settings → Tasks (API) screen.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 10.5, color: 'var(--text-dimmer)', letterSpacing: '.04em' }}>
            API KEY {status.configured && <span style={{ color: 'var(--teal)' }}>· stored</span>}
          </span>
          <input
            className="field-input mono"
            type="password"
            autoComplete="off"
            placeholder={status.configured ? '•••••••• (replace to change)' : 'from Inbox → Settings → Tasks'}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 10.5, color: 'var(--text-dimmer)', letterSpacing: '.04em' }}>
            ADDRESSES TO WATCH (ONE PER LINE)
          </span>
          <textarea
            className="field-input mono"
            rows={3}
            placeholder={'you@example.com\nalias@example.com'}
            value={addresses}
            onChange={(event) => setAddresses(event.target.value)}
            style={{ resize: 'vertical', lineHeight: 1.5 }}
          />
        </label>
      </div>

      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="btn"
          disabled={busy || key.trim().length === 0}
          onClick={() => run(async () => {
            await api.aycdSetKey(key.trim())
            setKey('')
            return { ok: true, message: 'API key stored, encrypted with the OS keystore.' }
          })}
        >
          Save key
        </button>

        <button
          className="btn"
          disabled={busy}
          onClick={() => run(async () => {
            const saved = await api.aycdSetAddresses(
              addresses.split('\n').map((a) => a.trim()).filter(Boolean),
            )
            return { ok: true, message: `Watching ${saved.length} address(es).` }
          })}
        >
          Save addresses
        </button>

        <button className="btn" disabled={busy || !status.configured} onClick={() => run(api.aycdVerify)}>
          Test connection
        </button>

        {status.running ? (
          <button
            className="btn"
            disabled={busy}
            onClick={() => run(async () => {
              await api.aycdStop()
              return { ok: true, message: 'Capture stopped.' }
            })}
          >
            Stop capture
          </button>
        ) : (
          <button className="btn btn-primary" disabled={busy} onClick={() => run(api.aycdStart)}>
            Start capture
          </button>
        )}

        {status.configured && (
          <button
            className="btn"
            disabled={busy}
            onClick={() => run(async () => {
              await api.aycdClearKey()
              return { ok: true, message: 'API key removed.' }
            })}
            style={{ marginLeft: 'auto', color: 'var(--pink)' }}
          >
            Remove key
          </button>
        )}
      </div>

      {note && (
        <div
          style={{
            fontSize: 11.5, lineHeight: 1.45,
            color: note.ok ? 'var(--teal)' : 'var(--warm)',
          }}
        >
          {note.text}
        </div>
      )}

      {status.lastError && !note && (
        <div className="notice-warm">
          <span className="notice-dot" />
          <span>{status.lastError}</span>
        </div>
      )}

      {(status.running || status.registered > 0) && (
        <div
          style={{
            display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 10,
            borderTop: '1px solid var(--border-soft)', paddingTop: 11,
          }}
        >
          <Tally label="ACTIVE TASKS" value={status.activeTasks} />
          <Tally label="REGISTERED" value={status.registered} />
          <Tally label="CAPTURED" value={status.succeeded} />
          <Tally label="TIMED OUT" value={status.timedOut} />
          <Tally label="ERRORS" value={status.errored} />
        </div>
      )}
    </section>
  )
}

function Tally({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 10, color: 'var(--text-dimmer)', letterSpacing: '.05em' }}>
        {label}
      </span>
      <span className="mono" style={{ fontSize: 15, fontWeight: 500 }}>{value}</span>
    </div>
  )
}
