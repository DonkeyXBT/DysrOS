import { useEffect, useMemo, useState } from 'react'
import { api, type ReviewView } from '../api.js'
import { Pager, usePaged } from '../Pager.js'
import { SkeletonCards } from '../Skeleton.js'
import { groupReviewQueue } from './review-groups.js'

export function Review({ dataVersion }: { dataVersion: number }) {
  const [items, setItems] = useState<ReviewView[] | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    void api.review().then(setItems)
  }, [dataVersion])

  // Stacked by kind: ten copies of one template are one thing to fix, not ten.
  const groups = useMemo(() => groupReviewQueue(items ?? []), [items])
  const paged = usePaged(groups, 'review')

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
    <div className="screen" style={{ overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          No parser recognised these. Export one and a parser can be written for it.
        </span>
        <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>
          {groups.length} kind{groups.length === 1 ? '' : 's'} · {items.length} email
          {items.length === 1 ? '' : 's'}
        </span>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button
            className="btn"
            onClick={async () => {
              // One of each kind is what a parser is written from; the rest are
              // the same mail again.
              const result = await api.exportAllUnrecognised(groups.map((group) => group.latest.id))
              setNote(
                result.reason
                  ?? (result.saved > 0 ? `Saved ${result.saved} file(s) to ${result.folder}` : null),
              )
            }}
          >
            Export one of each kind
          </button>
          <button
            className="btn"
            onClick={async () => {
              const result = await api.exportAllUnrecognised()
              setNote(
                result.reason
                  ?? (result.saved > 0 ? `Saved ${result.saved} file(s) to ${result.folder}` : null),
              )
            }}
          >
            Export all {items.length}
          </button>
        </div>
      </div>
      {note && (
        <div style={{ fontSize: 11.5, color: 'var(--teal)', paddingLeft: 2 }}>{note}</div>
      )}

      {paged.visible.map((group) => {
        const message = group.latest
        return (
        <div
          key={message.id}
          className="section"
          style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: '14px 16px' }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>{message.from}</span>
            <span className="cell-mono">{message.address}</span>
            {group.count > 1 && (
              <span
                className="mono"
                style={{
                  fontSize: 10.5, fontWeight: 700, color: 'var(--accent-bright)',
                  border: '1px solid #2b3a5e', borderRadius: 999, padding: '1px 8px',
                }}
                title={`${group.count} emails of this kind, ${group.firstSeenAt.slice(0, 10)} to ${group.lastSeenAt.slice(0, 10)}`}
              >
                ×{group.count}
              </span>
            )}
            <span className="cell-mono" style={{ marginLeft: 'auto' }}>
              {message.receivedAt.slice(0, 16).replace('T', ' ')}
            </span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#dfe4ee' }}>{message.subject}</div>
          {group.count > 1 && (
            <div style={{ fontSize: 11, color: 'var(--text-ghost)' }}>
              {group.count} emails like this, {group.firstSeenAt.slice(0, 10)} to{' '}
              {group.lastSeenAt.slice(0, 10)} · one parser covers them all
            </div>
          )}
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
              {group.count > 1 ? 'one of these is enough to write a parser' : 'nothing was discarded'}
            </span>
          </div>
        </div>
        )
      })}
      <Pager
        page={paged.page}
        pageCount={paged.pageCount}
        from={paged.from}
        to={paged.to}
        total={paged.total}
        noun="kinds"
        onPage={paged.setPage}
      />
    </div>
  )
}
