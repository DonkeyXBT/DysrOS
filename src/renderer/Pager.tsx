import { useEffect, useMemo, useState } from 'react'

export const PAGE_SIZE = 50

/**
 * Splits a list into pages and keeps the current page honest.
 *
 * Filtering or searching can shrink a list below the page you are standing on,
 * which would otherwise leave you looking at an empty table with rows that do
 * exist. Passing the current filters as `resetKey` returns to the first page
 * whenever they change.
 */
export function usePaged<T>(rows: T[], resetKey: string, pageSize = PAGE_SIZE) {
  const [page, setPage] = useState(0)

  useEffect(() => {
    setPage(0)
  }, [resetKey])

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)

  const visible = useMemo(
    () => rows.slice(safePage * pageSize, safePage * pageSize + pageSize),
    [rows, safePage, pageSize],
  )

  return {
    visible,
    page: safePage,
    pageCount,
    setPage,
    from: rows.length === 0 ? 0 : safePage * pageSize + 1,
    to: Math.min(rows.length, (safePage + 1) * pageSize),
    total: rows.length,
  }
}

export function Pager({
  page,
  pageCount,
  from,
  to,
  total,
  noun,
  onPage,
}: {
  page: number
  pageCount: number
  from: number
  to: number
  total: number
  noun: string
  onPage: (page: number) => void
}) {
  if (total === 0) return null

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 4 }}>
      <span style={{ fontSize: 11, color: 'var(--text-ghost)' }}>
        {from}–{to} of {total} {noun}
      </span>

      {pageCount > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <button className="btn" onClick={() => onPage(page - 1)} disabled={page === 0}>
            Previous
          </button>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
            {page + 1} / {pageCount}
          </span>
          <button
            className="btn"
            onClick={() => onPage(page + 1)}
            disabled={page >= pageCount - 1}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
