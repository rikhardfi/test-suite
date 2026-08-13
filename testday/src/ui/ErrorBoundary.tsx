import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  /** Named so the card can say which part failed rather than just "something". */
  label: string
  children: ReactNode
  /** Shown instead of the default card, when a panel wants its own fallback. */
  fallback?: (error: Error, retry: () => void) => ReactNode
}

interface State {
  error: Error | null
}

/**
 * Stops one broken panel from taking the window with it.
 *
 * React unmounts the entire tree when a render throws, so without a boundary a
 * single bad number in a chart leaves a white window in the middle of a test.
 * Recording survives that, because it happens in the main process, which makes
 * it worse rather than better: the session is still being written and the
 * operator has no way to see that it is.
 *
 * So each panel gets its own boundary. A failed chart becomes a small card, the
 * timer and the numbers keep running, and the test continues.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console for a developer, and out of the journal on purpose:
    // a recording is data about an athlete, not a place for stack traces.
    console.error(`[${this.props.label}] render failed`, error, info.componentStack)
  }

  private retry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.retry)

    return (
      <div className="panel-error">
        <strong>{this.props.label} stopped drawing.</strong>
        <span className="muted small">{error.message}</span>
        <span className="muted small">
          The recording is unaffected and is still being written to disk.
        </span>
        <button className="ghost" onClick={this.retry}>
          Try again
        </button>
      </div>
    )
  }
}
