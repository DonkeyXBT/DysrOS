import { useEffect, useState } from 'react'
import { api } from './api.js'

/**
 * The application's own title bar, replacing the native frame.
 *
 * The bar itself is a drag region; the buttons opt out of dragging so they stay
 * clickable. Maximised state comes from the main process rather than local
 * state, because the window can also be maximised by double-clicking the bar or
 * snapping it to a screen edge.
 */
export function TitleBar({
  screen,
  onOpenUpdater,
}: {
  screen: string
  onOpenUpdater: () => void
}) {
  const [maximized, setMaximized] = useState(false)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void api.windowState().then((state) => setMaximized(state.maximized))
    void api.appVersion().then((v) => setVersion(`v${v}`))
    return api.onWindowState((state) => setMaximized(state.maximized))
  }, [])

  return (
    <div className="titlebar">
      <span className="titlebar-label">Resell Ops — {screen}</span>
      <span className="titlebar-version mono">{version}</span>
      <div style={{ flex: 1 }} />
      <div className="titlebar-buttons">
        <button
          className="win-btn"
          title="Software update"
          onClick={onOpenUpdater}
          aria-label="Software update"
        >
          <span className="win-update-dot" />
        </button>
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
