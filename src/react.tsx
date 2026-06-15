import { Component, type ErrorInfo, type ReactNode } from "react";
import { Errorgap } from "./index.js";

export interface ErrorgapBoundaryProps {
  children?: ReactNode;
  fallback?: ReactNode | ((error: Error) => ReactNode);
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

export class ErrorgapBoundary extends Component<ErrorgapBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void Errorgap.notify(error, {
      context: {
        source: "react.ErrorgapBoundary",
        component_stack: info.componentStack,
      },
    });
    this.props.onError?.(error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      const { fallback } = this.props;
      if (typeof fallback === "function") return fallback(this.state.error);
      return fallback ?? null;
    }
    return this.props.children ?? null;
  }
}
