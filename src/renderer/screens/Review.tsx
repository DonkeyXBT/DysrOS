import { useEffect, useState } from 'react'
import { api, type ReviewView } from '../api.js'
import { Pager, usePaged } from '../Pager.js'
import { SkeletonCards } from '../Skeleton.js'

export function Review({ dataVersion }: { dataVersion: number }) {
  const [items, setItems] = useState<ReviewView[] | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    void api.review().then(setItems)
  }, [dataVersion])

  const paged = usePaged(items ?? [], 'review')

  if (!items) return <SkeletonCards count={4} height={128} />

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          No parser recognised these. Export one and a parser can be written for it.
        </span>
        <button
          className="btn"
          style={{ marginLeft: 'auto' }}
          onClick={async () => {
            const result = await api.exportAllUnrecognised()
            setNote(
              result.reason
                ?? (result.saved > 0 ? `Saved ${result.saved} file(s) to ${result.folder}` : null),
            )
          }}
        >
          Export all as .eml
        </button>
      </div>
      {note && (
        <div style={{ fontSize: 11.5, color: 'var(--teal)', paddingLeft: 2 }}>{note}</div>
      )}

      {paged.visible.map((message) => (
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
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
            {message.exportable ? (
              <>
                <button
                  className="btn"
                  onClick={async () => {
                    const result = await api.exportMessage(message.id, 'eml')
                    setNote(result.reason ?? (result.saved ? `Saved to ${result.path}` : null))
                  }}
                >
                  Download .eml
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    const result = await api.exportMessage(message.id, 'html')
                    setNote(result.reason ?? (result.saved ? `Saved to ${result.path}` : null))
                  }}
                >
                  Download .html
                </button>
              </>
            ) : (
              <span style={{ fontSize: 11, color: 'var(--text-ghost)' }}>
                no stored copy — sync again to collect it
              </span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-ghost)' }}>
              nothing was discarded
            </span>
          </div>
        </div>
      ))}
      <Pager
        page={paged.page}
        pageCount={paged.pageCount}
        from={paged.from}
        to={paged.to}
        total={paged.total}
        noun="emails"
        onPage={paged.setPage}
      />
    </div>
  )
}
