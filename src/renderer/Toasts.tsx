import { useEffect } from 'react'
import type { AppNotification } from './Notifications.js'

/** How long a toast stays before it takes itself away. */
export const TOAST_MS = 4000

const LEVEL_COLOUR: Record<AppNotification['level'], string> = {
  info: 'oklch(0.76 0.12 232)',
  warn: 'oklch(0.74 0.11 65)',
  error: 'oklch(0.70 0.17 18)',
}

/**
 * Passing notices in the bottom-left corner.
 *
 * They replace the banner that used to push the page down: a message about a
 * finished sync should not move the thing you are reading. Each one leaves
 * after four seconds and stays available in the bell, so nothing is lost by
 * missing it.
 */
export function Toasts({
  toasts,
  onExpire,
}: {
  toasts: AppNotification[]
  onExpire: (id: number) => void
}) {
  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onExpire={onExpire} />
      ))}
    </div>
  )
}

function Toast({
  toast,
  onExpire,
}: {
  toast: AppNotification
  onExpire: (id: number) => void
}) {
  useEffect(() => {
    const timer = setTimeout(() => onExpire(toast.id), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast.id, onExpire])

  const [title, meta] = splitMessage(toast.text)

  return (
    <div className="toast">
      <span className="toast-dot" style={{ background: LEVEL_COLOUR[toast.level] }} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{title}</span>
        {meta && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{meta}</span>}
      </span>
    </div>
  )
}

/**
 * Splits a message into a headline and a detail line.
 *
 * Messages already read as "something happened · the specifics", so the
 * separator is the natural break rather than an arbitrary character count.
 */
function splitMessage(text: string): [string, string | null] {
  const separator = text.indexOf(' · ')
  if (separator !== -1) {
    return [text.slice(0, separator), text.slice(separator + 3)]
  }
  const colon = text.indexOf(': ')
  if (colon !== -1 && colon < 40) {
    return [text.slice(0, colon), text.slice(colon + 2)]
  }
  return [text, null]
}
