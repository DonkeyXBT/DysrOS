import { useCallback, useEffect, useState } from 'react'
import { api, type SummaryView } from './api.js'
import { Dashboard } from './screens/Dashboard.js'
import { Shipments } from './screens/Shipments.js'
import { Purchases } from './screens/Purchases.js'
import { Review } from './screens/Review.js'
import { Settings } from './screens/Settings.js'
import { Placeholder } from './screens/Placeholder.js'
import { Logs } from './screens/Logs.js'
import { TitleBar } from './TitleBar.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import type { AppNotification } from './Notifications.js'
import { Updater } from './Updater.js'

/** Nav order and per-item hue, both taken from the mockup. */
const NAV = [
  { label: 'Dashboard', hue: 178 },
  { label: 'Inventory', hue: 225 },
  { label: 'Purchases', hue: 285 },
  { label: 'Sales', hue: 148 },
  { label: 'Shipments', hue: 40 },
  { label: 'Review', hue: 350 },
  { label: 'Reports', hue: 260 },
  { label: 'Settings', hue: 220 },
] as const

/** Reachable from Settings rather than the sidebar: it is somewhere you go
 *  when something has gone wrong, not part of the daily rotation. */
type Extra = 'Logs'

const SUBTITLES: Record<string, string> = {
  Dashboard: 'What you have, what it cost, what is moving',
  Inventory: 'Units held or in flight',
  Purchases: 'Retailer orders and refunds',
  Sales: 'Payouts and profit by channel',
  Shipments: 'Track and trace, both directions',
  Review: 'Emails no parser recognised',
  Reports: 'P&L, VAT and currency exposure',
  Settings: 'Mailboxes and integrations',
  Logs: 'Errors, warnings and crash reports',

}

export type Screen = (typeof NAV)[number]['label'] | Extra

export function App() {
  const [screen, setScreen] = useState<Screen>('Dashboard')
  const [summary, setSummary] = useState<SummaryView | null>(null)
  const [query, setQuery] = useState('')
  const [flash, setFlash] = useState<string | null>(null)
  const [updaterOpen, setUpdaterOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [crashCount, setCrashCount] = useState(0)
  const [progress, setProgress] = useState<{ done: number; stored: number; subject: string } | null>(null)
  /**
   * Bumped whenever stored data changes. Screens depend on it, so a sync
   * running in the background updates what you are looking at instead of
   * requiring the application to be restarted.
   */
  const [dataVersion, setDataVersion] = useState(0)
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [unread, setUnread] = useState(0)
  const [bellOpen, setBellOpen] = useState(false)

  const notify = useCallback((level: AppNotification['level'], text: string) => {
    setNotifications((current) => [
      { id: Date.now() + Math.floor(performance.now()), at: new Date().toISOString(), level, text },
      ...current,
    ].slice(0, 50))
    setUnread((n) => n + 1)
  }, [])

  const refresh = useCallback(async () => {
    setSummary(await api.summary())
  }, [])

  useEffect(() => {
    void refresh()
    // The main process ingests on launch and whenever new mail lands, so the UI
    // follows along rather than asking anyone to import anything.
    const offMail = api.onMailUpdated(() => {
      void refresh()
      setDataVersion((n) => n + 1)
    })
    const offCrash = api.onCrash((entry) => {
      setCrashCount((n) => n + 1)
      notify('error', entry?.message ? `Something failed: ${entry.message}` : 'Something failed')
    })
    // Each message reports as it lands, so a long sync shows movement rather
    // than sitting still until it finishes.
    const offProgress = api.onSyncProgress((p) => setProgress(p))

    // A renderer fault should reach the same log as everything else, rather
    // than disappearing into a console nobody has open.
    const onError = (event: ErrorEvent) => {
      void api.reportRendererError(event.message, event.error?.stack ?? '')
    }
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason
      void api.reportRendererError(
        reason instanceof Error ? reason.message : String(reason),
        reason instanceof Error ? reason.stack ?? '' : '',
      )
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)

    return () => {
      offMail()
      offCrash()
      offProgress()
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [refresh, notify])

  /**
   * Syncing lives here rather than on the Settings screen, so switching screens
   * mid-sync neither cancels it nor loses sight of it. The work itself runs in
   * the main process; this only tracks whether it is still going.
   */
  const syncNow = useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    setFlash(null)
    setProgress(null)
    try {
      const result = await api.syncAccounts()
      const message = result.failures.length > 0
        ? `${result.failures[0]!.email}: ${result.failures[0]!.error}`
        : result.accounts === 0
          ? 'No mailbox connected yet - add one in Settings.'
          : `Pulled ${result.fetched} message${result.fetched === 1 ? '' : 's'} from ` +
            `${result.accounts} account${result.accounts === 1 ? '' : 's'} - ${result.stored} new`
      setFlash(message)
      notify(result.failures.length > 0 ? 'warn' : 'info', message)
      await refresh()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setFlash(message)
      notify('error', message)
    } finally {
      setSyncing(false)
      setProgress(null)
    }
  }, [refresh, syncing, notify])

  return (
    <div className="app">
      <TitleBar
        screen={screen}
        onOpenUpdater={() => setUpdaterOpen(true)}
        notifications={notifications}
        unread={unread}
        notificationsOpen={bellOpen}
        onToggleNotifications={() => {
          setBellOpen((open) => !open)
          setUnread(0)
        }}
        onCloseNotifications={() => setBellOpen(false)}
      />
      {updaterOpen && <Updater onClose={() => setUpdaterOpen(false)} />}
      <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">R</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <div className="brand-name">Resell Ops</div>
            <div className="brand-sub">local · one seat</div>
          </div>
        </div>

        {NAV.map((item) => (
          <button
            key={item.label}
            className={`nav-item${screen === item.label ? ' active' : ''}`}
            onClick={() => setScreen(item.label)}
          >
            <span className="nav-left">
              <span
                className="nav-dot"
                style={{ background: `oklch(0.76 0.13 ${item.hue})` }}
              />
              <span>{item.label}</span>
            </span>
            {item.label === 'Review' && summary && summary.reviewCount > 0 && (
              <span className="nav-badge">{summary.reviewCount}</span>
            )}
            {item.label === 'Settings' && crashCount > 0 && (
              <span className="nav-badge">{crashCount}</span>
            )}
          </button>
        ))}

        <div style={{ flex: 1 }} />

        <button className="sync" onClick={syncNow} disabled={syncing}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 7, height: 7, borderRadius: '50%', flex: 'none',
                background: syncing
                  ? 'oklch(0.76 0.12 232)'
                  : summary?.messageCount ? 'oklch(0.78 0.12 148)' : 'oklch(0.66 0.02 265)',
                animation: syncing ? 'pulseGlow 1.4s ease-in-out infinite' : 'none',
              }}
            />
            <span className="sync-title">{syncing ? 'Syncing mail' : 'Sync now'}</span>
          </div>
          {syncing && progress?.subject && (
            <div
              style={{
                fontSize: 10, color: 'var(--text-ghost)', whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
              }}
            >
              {progress.subject}
            </div>
          )}
          <div className="sync-detail">
            {syncing
              ? progress
                ? `${progress.done} read · ${progress.stored} new`
                : 'Connecting…'
              : summary
                ? `${summary.messageCount} message${summary.messageCount === 1 ? '' : 's'} · ${summary.eventCount} events`
                : 'Starting up'}
          </div>
        </button>
      </aside>

        <main className="main">
        <header className="topbar">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <h1>{screen}</h1>
            <div className="topbar-sub">{SUBTITLES[screen]}</div>
          </div>
          <div style={{ flex: 1 }} />
          <div className="search">
            <span
              style={{
                width: 11, height: 11, border: '1.5px solid #6f7789',
                borderRadius: '50%', flex: 'none',
              }}
            />
            <input
              value={query}
              placeholder="Search title or order ref"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="avatar">DN</div>
        </header>

        {flash && (
          <div className="banner">
            <span className="banner-dot" />
            <span>{flash}</span>
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setFlash(null)}>
              Dismiss
            </button>
          </div>
        )}

        <div className="content">
          {/* Keyed by screen so moving to another screen clears a failed one. */}
          <ErrorBoundary area={screen} key={screen} onReset={() => void refresh()}>
          {screen === 'Dashboard' && <Dashboard summary={summary} onSync={syncNow} />}
          {screen === 'Shipments' && <Shipments query={query} dataVersion={dataVersion} />}
          {screen === 'Purchases' && <Purchases query={query} dataVersion={dataVersion} />}
          {screen === 'Review' && <Review dataVersion={dataVersion} />}
          {screen === 'Logs' && <Logs />}
          {screen === 'Settings' && (
            <Settings
              onAccountsChanged={() => {
                void refresh()
                setDataVersion((n) => n + 1)
              }}
              onSync={syncNow}
              syncing={syncing}
              onOpenLogs={() => {
                setScreen('Logs')
                setCrashCount(0)
              }}
            />
          )}
          {(screen === 'Inventory' || screen === 'Sales' || screen === 'Reports') && (
            <Placeholder screen={screen} />
          )}
          </ErrorBoundary>
        </div>
        </main>
      </div>
    </div>
  )
}
