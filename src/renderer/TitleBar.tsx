import { useEffect, useState } from 'react'
import { api } from './api.js'
import { NotificationBell, type AppNotification } from './Notifications.js'

export interface SyncState {
  title: string
  detail: string
  colour: string
  progress: number | null
}

/**
 * The application's own title bar, replacing the native frame.
 *
 * It carries the screen name, the update and sync controls, notifications and
 * the window buttons. The bar itself is a drag region; everything interactive
 * opts out, or the window would move when you clicked it.
 */
export function TitleBar({
  screen,
  sync,
  onSync,
  updateAvailable,
  updateVersion,
  onOpenUpdater,
  notifications,
  unread,
  notificationsOpen,
  onToggleNotifications,
  onCloseNotifications,
}: {
  screen: string
  sync: SyncState
  onSync: () => void
  updateAvailable: boolean
  updateVersion: string | null
  onOpenUpdater: () => void
  notifications: AppNotification[]
  unread: number
  notificationsOpen: boolean
  onToggleNotifications: () => void
  onCloseNotifications: () => void
}) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void api.windowState().then((state) => setMaximized(state.maximized))
    return api.onWindowState((state) => setMaximized(state.maximized))
  }, [])

  return (
    <div className="titlebar">
      <span className="titlebar-label">{screen}</span>
      <div style={{ flex: 1 }} />

      <div className="titlebar-actions">
        {updateAvailable && (
          <button className="pill pill-update" onClick={onOpenUpdater}>
            <span className="pill-dot pill-dot-pulse" style={{ background: 'var(--accent)' }} />
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-bright)' }}>
              Update available
            </span>
            {updateVersion && (
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-dimmer)' }}>
                v{updateVersion}
              </span>
            )}
          </button>
        )}

        <button className="pill" onClick={onSync} title="Sync mail now">
          <span
            className={`pill-dot${sync.progress !== null ? ' pill-dot-pulse' : ''}`}
            style={{ background: sync.colour }}
          />
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mid)' }}>
            {sync.title}
          </span>
          <span
            style={{
              fontSize: 10.5, color: 'var(--text-dimmer)', maxWidth: 220,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {sync.detail}
          </span>
          {sync.progress !== null && (
            <span className="pill-bar">
              <span
                style={{
                  display: 'block', height: '100%', background: sync.colour,
                  width: `${Math.min(100, Math.max(4, sync.progress))}%`,
                }}
              />
            </span>
          )}
        </button>
      </div>

      <NotificationBell
        notifications={notifications}
        unread={unread}
        open={notificationsOpen}
        onToggle={onToggleNotifications}
        onClose={onCloseNotifications}
      />

      <div className="titlebar-buttons">
        <button
          className="win-btn"
          title="Minimize"
          onClick={() => void api.minimize()}
          aria-label="Minimize"
        >
          <span className="win-glyph-minimize" />
        </button>
        <button
          className="win-btn"
          title={maximized ? 'Restore' : 'Maximize'}
          onClick={() => void api.toggleMaximize().then(setMaximized)}
          aria-label={maximized ? 'Restore' : 'Maximize'}
        >
          <span className={maximized ? 'win-glyph-restore' : 'win-glyph-maximize'} />
        </button>
        <button
          className="win-btn win-btn-close"
          title="Close"
          onClick={() => void api.close()}
          aria-label="Close"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
