import { useEffect, useState } from 'react'
import { api, type ReviewView } from '../api.js'

export function Review() {
  const [items, setItems] = useState<ReviewView[] | null>(null)

  useEffect(() => {
    void api.review().then(setItems)
  }, [])

  if (!items) return <div className="empty"><span className="empty-body">Loading…</span></div>

  if (items.length === 0) {
    return (
      <div className="empty" style={{ margin: '70px auto' }}>
        <div
          style={{
            width: 56, height: 56, borderRadius: 20, background: 'var(--grad-cool)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--bg)', fontSize: 24, fontWeight: 800,
          }}
        >
          ✓
        </div>
        <div className="empty-title">Queue clear</div>
        <div className="empty-body">
          Every email imported so far was recognised and filed. Nothing was dropped.
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11, maxWidth: 960 }}>
      {items.map((message) => (
        <div
          key={message.id}
          className="section"
          style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: '14px 16px' }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>{message.from}</span>
            <span className="cell-mono">{message.address}</span>
            <span className="cell-mono" style={{ marginLeft: 'auto' }}>
              {message.receivedAt.slice(0, 16).replace('T', ' ')}
            </span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#dfe4ee' }}>{message.subject}</div>
          <div
            style={{
              fontSize: 12, lineHeight: 1.55, color: 'var(--text-dim)',
              background: 'var(--sunken)', border: '1px solid var(--border-soft)',
              borderRadius: 12, padding: '9px 11px', maxHeight: 92, overflow: 'hidden',
            }}
          >
            {message.preview}
          </div>
          <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--text-ghost)' }}>
              no parser matched this sender — nothing was discarded
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
