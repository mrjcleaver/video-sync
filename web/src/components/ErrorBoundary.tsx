"use client";

import { Component, type ReactNode } from "react";
import { clientLog } from "../lib/logger";

interface Props { children: ReactNode }
interface State { error: Error | null; rid: string }

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, rid: "" };
  }

  static getDerivedStateFromError(error: Error): State {
    const rid = crypto.randomUUID().slice(0, 8);
    return { error, rid };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    clientLog("error", "react:boundary", error.message, {
      rid: this.state.rid,
      stack: error.stack?.slice(0, 500),
      component_stack: info.componentStack?.slice(0, 500),
    });
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: "monospace", color: "var(--red, #ef4444)" }}>
          <h2>Something went wrong</h2>
          <p style={{ color: "var(--text, #e2e8f0)" }}>{this.state.error.message}</p>
          <p style={{ fontSize: "0.75rem", color: "var(--text-muted, #94a3b8)" }}>
            Reference: <code>{this.state.rid}</code> — check the Event Log for details.
          </p>
          <button
            style={{ marginTop: 16, padding: "6px 16px", cursor: "pointer" }}
            onClick={() => this.setState({ error: null, rid: "" })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
