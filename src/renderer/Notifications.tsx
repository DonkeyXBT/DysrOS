import { useEffect, useRef } from 'react'

export interface AppNotification {
  id: number
  at: string
  level: 'info' | 'warn' | 'error'
  text: string
}

const LEVEL_COLOUR: Record<AppNotification['level'], string> = {
  info: 'oklch(0.76 0.12 232)',
  warn: 'oklch(0.74 0.11 65)',
  error: 'oklch(0.70 0.17 18)',
}

/**
 * The bell in the title bar, beside the update indicator.
 *
 * Things worth knowing about — a finished sync, a mailbox that rejected its
 * password, a crash — used to appear only as a banner that scrolled away, or
 * not at all. They collect here instead, so nothing that happened while you
 * were on another screen is lost.
 */
export function NotificationBell({
  notifications,
  unread,
  open,
  onToggle,
  onClose,
}: {
  notifications: AppNotification[]
  unread: number
  open: boolean
  onToggle: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onAway = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    // Deferred, so the click that opened the panel does not immediately close it.
    const timer = setTimeout(() => document.addEventListener('mousedown', onAway), 0)
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', onAway)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  const worst = notifications.slice(0, unread).reduce<AppNotification['level']>(
    (level, n) => (n.level === 'error' ? 'error' : level === 'error' ? 'error' : n.level === 'warn' ? 'warn' : level),
    'info',
  )

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="win-btn"
        onClick={onToggle}
        title={unread > 0 ? `${unread} new notification${unread === 1 ? '' : 's'}` : 'Notifications'}
        aria-label="Notifications"
      >
        <span className="bell-wrap">
          <span className="bell-glyph" />
          {unread > 0 && (
            <span
              className="bell-dot"
              style={{ background: LEVEL_COLOUR[worst] }}
            />
          )}
        </span>
      </button>

      {open && (
        <div className="notif-panel">
          <div className="notif-head">
            <span>Notifications</span>
            {notifications.length > 0 && (
              <button className="notif-clear" onClick={onClose}>Dismiss</button>
            )}
          </div>

          {notifications.length === 0 ? (
            <div className="notif-empty">Nothing to report.</div>
          ) : (
            <div className="notif-list">
              {notifications.slice(0, 12).map((notification) => (
                <div key={notification.id} className="notif-item">
                  <span
                    className="notif-dot"
                    style={{ background: LEVEL_COLOUR[notification.level] }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div className="notif-text">{notification.text}</div>
                    <div className="notif-time mono">
                      {notification.at.slice(11, 16)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
