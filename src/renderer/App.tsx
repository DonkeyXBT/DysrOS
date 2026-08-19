import { useCallback, useEffect, useState } from 'react'
import { api, type SummaryView } from './api.js'
import { Dashboard } from './screens/Dashboard.js'
import { Shipments } from './screens/Shipments.js'
import { Purchases } from './screens/Purchases.js'
import { Review } from './screens/Review.js'
import { Settings } from './screens/Settings.js'
import { Inventory } from './screens/Inventory.js'
import { Reports } from './screens/Reports.js'
import { Placeholder } from './screens/Placeholder.js'
import { Logs } from './screens/Logs.js'
import { TitleBar } from './TitleBar.js'
import { ActivityButton } from './Activity.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import type { AppNotification } from './Notifications.js'
import { Toasts } from './Toasts.js'
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

/** Initials from an address, so the chip identifies the mailbox it belongs to. */
function initials(email: string | null): string {
  if (!email) return '—'
  const name = email.split('@')[0] ?? ''
  const parts = name.split(/[._-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return name.slice(0, 2).toUpperCase() || '—'
}

export function App() {
  const [screen, setScreen] = useState<Screen>('Dashboard')
  // Whether the menu is folded down to its icons. Remembered, because it is a
  // preference about the window, not about this session.
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem('rail-collapsed') === '1',
  )

  useEffect(() => {
    localStorage.setItem('rail-collapsed', railCollapsed ? '1' : '0')
  }, [railCollapsed])
  const [summary, setSummary] = useState<SummaryView | null>(null)
  const [query, setQuery] = useState('')
  const [toasts, setToasts] = useState<AppNotification[]>([])
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
  const [mailboxes, setMailboxes] = useState<string[]>([])

  /** Everything worth saying appears as a passing toast and stays in the bell. */
  const notify = useCallback((level: AppNotification['level'], text: string) => {
    const entry: AppNotification = {
      id: Date.now() + Math.floor(performance.now()),
      at: new Date().toISOString(),
      level,
      text,
    }
    setNotifications((current) => [entry, ...current].slice(0, 50))
    setToasts((current) => [...current, entry].slice(-4))
    setUnread((n) => n + 1)
  }, [])

  const refresh = useCallback(async () => {
    setSummary(await api.summary())
    setMailboxes((await api.accounts()).filter((a) => a.enabled).map((a) => a.email))
  }, [])

  useEffect(() => {
    void refresh()
    // The update pill only appears when there is genuinely something to install.
    void api.checkForUpdate().then((status) => {
      setUpdate({ available: status.available, version: status.version ?? null })
    })
    const offUpdate = api.onUpdateAvailable((info) => {
      setUpdate({ available: true, version: info.version })
      notify('info', `Update available · version ${info.version}`)
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
      offUpdate()
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
    setProgress(null)
    try {
      const result = await api.syncAccounts()
      const message = result.failures.length > 0
        ? `${result.failures[0]!.email}: ${result.failures[0]!.error}`
        : result.accounts === 0
          ? 'No mailbox connected yet - add one in Settings.'
          : `Pulled ${result.fetched} message${result.fetched === 1 ? '' : 's'} from ` +
            `${result.accounts} account${result.accounts === 1 ? '' : 's'} - ${result.stored} new`
      notify(result.failures.length > 0 ? 'warn' : 'info', message)
      await refresh()
    } catch (error) {
      notify('error', error instanceof Error ? error.message : String(error))
    } finally {
      setSyncing(false)
      setProgress(null)
    }
  }, [refresh, syncing, notify])

  const account = {
    primary: mailboxes[0] ?? null,
    label: mailboxes.length > 1
      ? `${mailboxes.length} mailboxes`
      : mailboxes.length === 1 ? 'Connected' : 'Connect one in Settings',
  }

  return (
    <div className="app">
      <TitleBar
        screen={screen}
        query={query}
        onQuery={setQuery}
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
      <Toasts
        toasts={toasts}
        onExpire={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))}
      />
      <div className="shell">
      <aside className={`sidebar${railCollapsed ? ' sidebar-narrow' : ''}`}>
        {/* Folds the menu down to its icons, for when the table matters more
            than knowing what the icons mean. */}
        <button
          className="rail-toggle"
          onClick={() => setRailCollapsed((current) => !current)}
          title={railCollapsed ? 'Show the menu' : 'Collapse the menu'}
          aria-label={railCollapsed ? 'Show the menu' : 'Collapse the menu'}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }}>
            <path d={railCollapsed ? 'M6 3l5 5-5 5' : 'M10 3L5 8l5 5'} />
          </svg>
        </button>

        <div className="sidebar-nav">
        {NAV.map((item) => (
          <button
            key={item.label}
            className={`nav-item${screen === item.label ? ' active' : ''}`}
            onClick={() => setScreen(item.label)}
          >
            <span className="nav-left" title={item.label}>
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
              <span className="nav-label">{item.label}</span>
            </span>
            {item.label === 'Settings' && (crashCount > 0 || (summary?.reviewCount ?? 0) > 0) && (
              <span className="nav-badge">{crashCount + (summary?.reviewCount ?? 0)}</span>
            )}
          </button>
        ))}
        </div>

        {/* Directly above the account: what the app is doing on its own. */}
        <ActivityButton />

        <button
          className="account-chip"
          onClick={() => setScreen('Settings')}
          title="Mailboxes and settings"
        >
          <span className="account-avatar">{initials(account.primary)}</span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
            <span
              style={{
                fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >
              {account.primary ?? 'No mailbox'}
            </span>
            <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
              {account.label}
            </span>
          </span>
        </button>
      </aside>

        <main className="main">
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
          {screen === 'Inventory' && <Inventory query={query} dataVersion={dataVersion} onSearch={setQuery} />}
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
          {screen === 'Reports' && <Reports dataVersion={dataVersion} />}
          {screen === 'Sales' && (
            <Placeholder screen={screen} />
          )}
          </ErrorBoundary>
        </div>
        </main>
      </div>
    </div>
  )
}
