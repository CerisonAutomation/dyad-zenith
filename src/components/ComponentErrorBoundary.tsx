/**
 * Component-level error boundary.
 * Wraps individual components to prevent full-app crashes from render errors.
 *
 * @example
 * <ComponentErrorBoundary name="ChatMessages">
 *   <MessagesList />
 * </ComponentErrorBoundary>
 */

import React, { Component, type ReactNode } from "react";
import log from "electron-log";

const logger = log.scope("component-error-boundary");

interface Props {
  children: ReactNode;
  /** Human-readable name for logging and fallback UI */
  name: string;
  /** Optional custom fallback UI */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ComponentErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error(
      `Error in ${this.props.name}:`,
      error.message,
      errorInfo.componentStack,
    );
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          className="flex items-center justify-center p-4 text-sm text-muted-foreground border border-dashed rounded-md m-1"
          role="alert"
          aria-live="assertive"
        >
          <span>
            Something went wrong in {this.props.name}.{" "}
            <button
              className="underline hover:text-foreground"
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              Try again
            </button>
          </span>
        </div>
      );
    }

    return this.props.children;
  }
}
