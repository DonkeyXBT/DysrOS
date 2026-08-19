import { useCallback, useEffect, useState } from 'react'
import { api, type SummaryView } from './api.js'
import { Dashboard } from './screens/Dashboard.js'
import { Shipments } from './screens/Shipments.js'
import { Purchases } from './screens/Purchases.js'
import { Review } from './screens/Review.js'
import { Settings } from './screens/Settings.js'
import { Inventory } from './screens/Inventory.js'
import { Placeholder } from './screens/Placeholder.js'
import { Logs } from './screens/Logs.js'
import { TitleBar } from './TitleBar.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import type { AppNotification } from './Notifications.js'
import { Updater } from './Updater.js'

/** Nav order and per-item hue, both taken from the mockup. */
/**
 * Navigation, with the icon paths from the design. Review is reached from
 * Settings rather than the sidebar, and its count rides on the Settings badge.
 */
const NAV = [
  { label: 'Dashboard', icon: 'M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z' },
  { label: 'Inventory', icon: 'M2.5 5.5 8 2.5l5.5 3v5L8 13.5 2.5 10.5zM2.5 5.5 8 8.5l5.5-3M8 8.5v5' },
  { label: 'Purchases', icon: 'M3.5 5.5h9l-1 8h-7zM6 5.5V4.2a2 2 0 0 1 4 0v1.3' },
  { label: 'Sales', icon: 'M8.5 2.5H13V7L7 13 2.5 8.5zM10.5 5h.01' },
  { label: 'Shipments', icon: 'M2 5h6.5v5H2zM8.5 6.5h2.6L13 8.4V10H8.5M4 12h.01M11 12h.01' },
  { label: 'Reports', icon: 'M3.5 12.5V8M8 12.5V4M12.5 12.5V7' },
  { label: 'Settings', icon: 'M3 5.5h10M3 10.5h10M6.2 3.6v3.8M10 8.6v3.8' },
] as const

/** Reachable from Settings rather than the sidebar: it is somewhere you go
 *  when something has gone wrong, not part of the daily rotation. */
type Extra = 'Logs' | 'Review'


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
  const [update, setUpdate] = useState<{ available: boolean; version: string | null }>({
    available: false, version: null,
  })

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
    // The update pill only appears when there is genuinely something to install.
    void api.checkForUpdate().then((status) => {
      setUpdate({ available: status.available, version: status.version ?? null })
    })
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
        sync={{
          title: syncing ? 'Syncing' : summary?.messageCount ? 'Synced' : 'Never synced',
          detail: syncing
            ? progress
              ? `${progress.done} read · ${progress.stored} new`
              : 'connecting'
            : summary?.messageCount
              ? `${summary.messageCount} messages · ${summary.eventCount} events`
              : 'connect an account to start',
          colour: syncing
            ? 'oklch(0.76 0.12 232)'
            : summary?.messageCount ? 'oklch(0.78 0.12 148)' : 'oklch(0.66 0.02 265)',
          // The total is unknown mid-sync, so the bar shows movement rather
          // than a percentage it cannot honestly claim.
          progress: syncing ? ((progress?.done ?? 0) % 100) : null,
        }}
        onSync={syncNow}
        updateAvailable={update.available}
        updateVersion={update.version}
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
        {NAV.map((item) => (
          <button
            key={item.label}
            className={`nav-item${screen === item.label ? ' active' : ''}`}
            onClick={() => setScreen(item.label)}
          >
            <span className="nav-left">
              <svg
                className="nav-icon"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={item.icon} />
              </svg>
              <span>{item.label}</span>
            </span>
            {item.label === 'Settings' && (crashCount > 0 || (summary?.reviewCount ?? 0) > 0) && (
              <span className="nav-badge">{crashCount + (summary?.reviewCount ?? 0)}</span>
            )}
          </button>
        ))}
      </aside>

        <main className="main">
        <header className="topbar">
          <div className="avatar">DN</div>
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
          {screen === 'Dashboard' && (
            <Dashboard
              onSync={syncNow}
              onGo={(target) => setScreen(target)}
              dataVersion={dataVersion}
              hasMail={(summary?.messageCount ?? 0) > 0}
            />
          )}
          {screen === 'Inventory' && <Inventory query={query} dataVersion={dataVersion} />}
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
              onOpenReview={() => setScreen('Review')}
              reviewCount={summary?.reviewCount ?? 0}
            />
          )}
          {(screen === 'Sales' || screen === 'Reports') && (
            <Placeholder screen={screen} />
          )}
          </ErrorBoundary>
        </div>
        </main>
      </div>
    </div>
  )
}
