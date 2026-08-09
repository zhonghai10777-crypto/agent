import React from "react";

interface ErrorBoundaryProps {
  readonly children: React.ReactNode;
  /** Rendered instead of the children when a descendant throws. */
  readonly fallback: (error: Error, reset: () => void) => React.ReactNode;
  /**
   * When this value changes, a caught error is cleared and the children are
   * retried. Used to recover automatically once the user navigates away from
   * whatever content could not be rendered.
   */
  readonly resetKey?: unknown;
}

interface ErrorBoundaryState {
  readonly error: Error | undefined;
}

/**
 * Stops one bad render from blanking the window. Without a boundary, any throw
 * below the root unmounts the whole tree and leaves an empty page with no way
 * back except killing the app — and the transcript renders untrusted model
 * output through a markdown pipeline, so this is a reachable path, not a
 * theoretical one.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidUpdate(previousProps: ErrorBoundaryProps): void {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: undefined });
    }
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error("[renderer] render failed:", error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ error: undefined });
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return this.props.fallback(this.state.error, this.reset);
    }
    return this.props.children;
  }
}
