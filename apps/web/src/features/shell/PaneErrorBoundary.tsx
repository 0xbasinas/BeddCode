import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RotateCw, TriangleAlert } from 'lucide-react'

interface Props {
  pane: string
  children: ReactNode
}

interface State {
  error: Error | null
  retryKey: number
}

/** Contains render and lazy-load failures inside one side pane. */
export class PaneErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, retryKey: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.pane} pane failed`, error, info.componentStack)
  }

  private retry = () => this.setState(({ retryKey }) => ({ error: null, retryKey: retryKey + 1 }))

  override render() {
    const { error, retryKey } = this.state
    if (error) {
      return (
        <div className="pane-error" role="alert">
          <TriangleAlert size={24} />
          <strong>{this.props.pane} pane stopped after an error.</strong>
          <span className="muted small">Try reloading this pane.</span>
          <button type="button" className="icon-btn" onClick={this.retry}>
            <RotateCw size={14} /> Try again
          </button>
        </div>
      )
    }
    return (
      <div className="pane-isolated-content" key={retryKey}>
        {this.props.children}
      </div>
    )
  }
}
