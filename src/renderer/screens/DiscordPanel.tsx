import { useEffect, useState } from 'react'
import { api, type DiscordSettingsView } from '../api.js'

/**
 * Discord notifications.
 *
 * The webhook URL is a secret — anyone holding it can post into the channel —
 * so it is stored encrypted and only ever shown masked once saved.
 */
export function DiscordPanel() {
  const [settings, setSettings] = useState<DiscordSettingsView | null>(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const refresh = () => {
    void api.discordSettings().then(setSettings)
  }

  useEffect(refresh, [])

  if (!settings) return null

  const act = async (action: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true)
    setNote(null)
    try {
      const result = await action()
      setNote({ ok: result.ok, text: result.message })
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="section" style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      <div className="section-head" style={{ marginBottom: 0 }}>
        <h2>Discord notifications</h2>
        <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          {settings.masked}
        </span>
        <button
          className="btn"
          style={{ marginLeft: 'auto' }}
          disabled={busy || !settings.configured}
          onClick={() => void act(api.discordTest)}
        >
          Send test message
        </button>
      </div>

      <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
        <input
          className="field-input mono"
          type="password"
          autoComplete="off"
          placeholder={
            settings.configured
              ? 'stored — paste a new URL to replace it'
              : 'https://discord.com/api/webhooks/…'
          }
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          style={{ flex: 1 }}
        />
        <button
          className="btn btn-primary"
          disabled={busy || url.trim().length === 0}
          onClick={() => void act(async () => {
            const result = await api.discordSetWebhook(url.trim())
            if (result.ok) setUrl('')
            return result
          })}
        >
          Save
        </button>
        {settings.configured && (
          <button
            className="btn"
            disabled={busy}
            style={{ color: 'var(--pink)' }}
            onClick={() => void act(() => api.discordSetWebhook(''))}
          >
            Remove
          </button>
        )}
      </div>

      {note && (
        <div style={{ fontSize: 11.5, color: note.ok ? 'var(--teal)' : 'var(--warm)' }}>
          {note.text}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: '0 24px' }}>
        {settings.rules.map((rule) => (
          <div
            key={rule.event}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
              borderTop: '1px solid var(--border-soft)',
            }}
          >
            <span style={{ fontSize: 12, color: 'var(--text-mid)', flex: 1 }}>{rule.label}</span>
            <button
              onClick={() => {
                void api.discordSetRule(rule.event, !rule.enabled).then(refresh)
              }}
              aria-label={`${rule.label} notifications`}
              aria-pressed={rule.enabled}
              style={{
                width: 34, height: 19, borderRadius: 999, border: 0, cursor: 'pointer',
                padding: 2, display: 'flex', justifyContent: rule.enabled ? 'flex-end' : 'flex-start',
                background: rule.enabled ? 'var(--teal)' : '#2b3346',
                transition: 'background .15s ease',
              }}
            >
              <span
                style={{
                  width: 15, height: 15, borderRadius: '50%',
                  background: rule.enabled ? '#0d1a18' : '#6f7789',
                }}
              />
            </button>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-ghost)' }}>
        The webhook URL is stored encrypted and never shown again in full.
      </div>
    </section>
  )
}
