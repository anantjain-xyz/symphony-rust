import { Component } from "react";
import type { ReactNode } from "react";

export function ViewLoading({ view }: { view: string }) {
  return (
    <div className="view-loading" aria-busy="true" aria-live="polite">
      <div className="view-loading-header">
        <span />
        <span />
      </div>
      <div className="view-loading-panels">
        <span />
        <span />
      </div>
      <span className="screen-reader-only">Loading {view}…</span>
    </div>
  );
}

type ChunkErrorBoundaryProps = {
  children: ReactNode;
  onRetry: () => void;
  view: string;
};

type ChunkErrorBoundaryState = { error: Error | null };

export class ChunkErrorBoundary extends Component<
  ChunkErrorBoundaryProps,
  ChunkErrorBoundaryState
> {
  state: ChunkErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ChunkErrorBoundaryState {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="view-chunk-error" role="alert">
        <strong>Unable to load {this.props.view}</strong>
        <button type="button" onClick={this.props.onRetry}>
          Retry
        </button>
      </div>
    );
  }
}
