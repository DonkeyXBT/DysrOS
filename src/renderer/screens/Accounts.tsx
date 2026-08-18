import { useEffect, useState } from 'react'
import { api, type AccountView, type ProviderView } from '../api.js'

/**
 * Connecting a mailbox.
 *
 * This is where setup usually fails, so the form says the awkward things at the
 * point of entry rather than after a rejected login: which providers refuse an
 * ordinary password, and which keep IMAP switched off until you enable it.
 */
export function Accounts({
  onChanged,
  onSync,
  syncing,
}: {
  onChanged: () => void
  onSync: () => void
  syncing: boolean
}) {
  const [accounts, setAccounts] = useState<AccountView[]>([])
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [encryptionOk, setEncryptionOk] = useState(true)

  const [adding, setAdding] = useState(false)
  const [providerId, setProviderId] = useState('gmail')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState(993)
  const [label, setLabel] = useState('')

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const preset = providers.find((p) => p.id === providerId)

  const refresh = () => {
    void api.accounts().then(setAccounts)
  }

  useEffect(() => {
    refresh()
    void api.providers().then(setProviders)
    void api.encryptionAvailable().then(setEncryptionOk)
  }, [])

  // Selecting a provider fills in its server details; Custom leaves them blank.
  useEffect(() => {
    if (!preset) return
    setHost(preset.host)
    setPort(preset.port)
  }, [providerId, providers.length])

  const connection = {
    host: host.trim(),
    port,
    useTls: true,
    username: email.trim(),
    password,
  }
  const complete = connection.host.length > 0 && connection.username.length > 0 && password.length > 0

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await api.testAccount(connection))
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      await api.addAccount({
        label: label.trim() || email.trim(),
        email: email.trim(),
        provider: providerId,
        host: connection.host,
        port,
        useTls: true,
        username: connection.username,
        password,
      })
      setAdding(false)
      setEmail('')
      setPassword('')
      setLabel('')
      setTestResult(null)
      refresh()
      onChanged()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 13, maxWidth: 920 }}>
      <section className="section" style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        <div className="section-head" style={{ marginBottom: 0 }}>
          <h2>Email accounts</h2>
          <span className="section-note">everything downstream depends on these</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 7 }}>
            <button className="btn" onClick={onSync} disabled={syncing || accounts.length === 0}>
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
            <button className="btn btn-primary" onClick={() => setAdding((open) => !open)}>
              {adding ? 'Cancel' : '+ Add account'}
            </button>
          </div>
        </div>

        {!encryptionOk && (
          <div className="notice-warm">
            <span className="notice-dot" />
            <span>
              The OS keystore is unavailable, so passwords cannot be stored safely and adding an
              account is blocked. Nothing is written in the clear as a fallback.
            </span>
          </div>
        )}

        {syncing && (
          <div style={{ fontSize: 11.5, color: 'var(--accent-soft)', paddingLeft: 2 }}>
            Syncing in the background. You can leave this screen; it keeps going.
          </div>
        )}

        {accounts.length === 0 && !adding && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            No mailbox connected yet. Add one and the app pulls order, shipping and cancellation
            mail by itself — nothing needs to be exported or dropped into a folder.
          </div>
        )}

        {accounts.map((account) => (
          <div
            key={account.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
              border: '1px solid var(--border)', borderRadius: 14, background: 'var(--sunken)',
            }}
          >
            <span
              style={{
                width: 7, height: 7, borderRadius: '50%', flex: 'none',
                background: account.lastError
                  ? 'oklch(0.70 0.17 18)'
                  : account.lastSyncAt ? 'oklch(0.78 0.12 148)' : 'oklch(0.66 0.02 265)',
              }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{account.email}</span>
              <span style={{ fontSize: 11, color: 'var(--text-dimmer)' }}>
                {account.provider} · {account.host}:{account.port}
              </span>
            </div>
            <span
              className="mono"
              style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-dim)' }}
            >
              {account.lastSyncAt ? account.lastSyncAt.slice(0, 16).replace('T', ' ') : 'never synced'}
            </span>
            <button className="btn" onClick={() => void api.removeAccount(account.id).then(refresh)}>
              Remove
            </button>
          </div>
        ))}

        {accounts.some((a) => a.lastError) && (
          <div className="notice-warm">
            <span className="notice-dot" />
            <span>{accounts.find((a) => a.lastError)!.lastError}</span>
          </div>
        )}

        {adding && (
          <div
            style={{
              border: '1px solid #2b3a5e', borderRadius: 'var(--r-card)',
              background: 'rgba(91,140,255,.06)', padding: 14,
              display: 'flex', flexDirection: 'column', gap: 11,
            }}
          >
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  className="btn"
                  onClick={() => setProviderId(provider.id)}
                  style={
                    providerId === provider.id
                      ? { background: '#242c3e', color: 'var(--text)', borderColor: '#3a4a6a' }
                      : undefined
                  }
                >
                  {provider.label}
                </button>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10 }}>
              <Field label="EMAIL ADDRESS">
                <input
                  className="field-input mono"
                  type="email"
                  autoComplete="off"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>
              <Field label={preset?.requiresAppPassword ? 'APP PASSWORD' : 'PASSWORD'}>
                <input
                  className="field-input mono"
                  type="password"
                  autoComplete="off"
                  placeholder={preset?.requiresAppPassword ? 'app-specific password' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              <Field label="IMAP HOST">
                <input
                  className="field-input mono"
                  placeholder="imap.example.com"
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                />
              </Field>
              <Field label="PORT">
                <input
                  className="field-input mono"
                  inputMode="numeric"
                  value={port}
                  onChange={(event) => setPort(Number(event.target.value) || 993)}
                />
              </Field>
              <Field label="LABEL (OPTIONAL)">
                <input
                  className="field-input"
                  placeholder="Main mailbox"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </Field>
            </div>

            {preset?.setupNote && (
              <div
                className={preset.requiresAppPassword ? 'notice-warm' : undefined}
                style={
                  preset.requiresAppPassword
                    ? undefined
                    : {
                        display: 'flex', gap: 9, alignItems: 'flex-start',
                        border: '1px solid var(--border-pill)', background: 'var(--sunken)',
                        borderRadius: 12, padding: '9px 11px', fontSize: 11.5,
                        lineHeight: 1.5, color: 'var(--text-dim)',
                      }
                }
              >
                {preset.requiresAppPassword && <span className="notice-dot" />}
                <span>{preset.setupNote}</span>
              </div>
            )}

            <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn" onClick={runTest} disabled={!complete || testing}>
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              <button
                className="btn btn-primary"
                onClick={save}
                disabled={!complete || saving || !encryptionOk}
              >
                {saving ? 'Saving…' : 'Add account'}
              </button>
              {testResult && (
                <span
                  style={{
                    fontSize: 11.5, lineHeight: 1.45, flex: 1, minWidth: 200,
                    color: testResult.ok ? 'var(--teal)' : 'var(--warm)',
                  }}
                >
                  {testResult.message}
                </span>
              )}
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-ghost)', lineHeight: 1.5 }}>
              The password is encrypted with the Windows keystore and never leaves this machine.
              Mailboxes are opened read-only: nothing is marked as read, moved or deleted.
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10.5, color: 'var(--text-dimmer)', letterSpacing: '.04em' }}>
        {label}
      </span>
      {children}
    </label>
  )
}
