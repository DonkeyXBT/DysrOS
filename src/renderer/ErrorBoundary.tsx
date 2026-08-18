import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Named in the message so a report says which screen failed. */
  area: string
  onReset?: () => void
}

interface State {
  error: Error | null
}

/**
 * Keeps one broken screen from taking down the application.
 *
 * Without this, any exception thrown while rendering unmounts the entire React
 * tree and leaves a blank window with no way back — which is exactly what a
 * stale prop reference did in 0.0.1. A failure should cost you the screen you
 * are on, not the app.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Goes to the renderer console, which the packaged app can surface via
    // View > Toggle Developer Tools.
    console.error(`[${this.props.area}] ${error.message}`, info.componentStack)
  }

  private reset = (): void => {
    this.setState({ error: null })
    this.props.onReset?.()
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="empty" style={{ margin: '60px auto', maxWidth: 560 }}>
        <div className="empty-title">The {this.props.area} screen hit an error</div>
        <div className="empty-body">
          The rest of the application is unaffected and your data is untouched — this screen
          failed to draw, nothing was written.
        </div>
        <div
          className="mono"
          style={{
            fontSize: 11.5, color: 'var(--warm)', background: 'var(--sunken)',
            border: '1px solid var(--border-soft)', borderRadius: 10,
            padding: '10px 12px', maxWidth: 520, textAlign: 'left', wordBreak: 'break-word',
          }}
        >
          {error.message}
        </div>
        <button className="btn btn-primary" style={{ marginTop: 4 }} onClick={this.reset}>
          Try again
        </button>
      </div>
    )
  }
}
