"use client";

/**
 * ADR-057 Option A — wrapping layout for every activity route.
 *
 * Provides the shared state context (AppProvider) + persistent
 * left-nav sidebar. Children are the individual per-route page
 * components.
 */

import { AppProvider, useApp } from "./AppContext";
import { Sidebar } from "./Sidebar";
import ErrorBoundary from "../../components/ErrorBoundary";
import BuildBadge from "../../components/BuildBadge";
import EventLog from "../../components/EventLog";
import ThemeSelector from "../../components/ThemeSelector";
import { useState } from "react";

function AppShell({ children }: { children: React.ReactNode }) {
  const { ready, actorState, events } = useApp();
  const [showLogs, setShowLogs] = useState(false);

  if (!ready) {
    return <div className="loading">Loading WASM module...</div>;
  }

  return (
    <>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      {actorState.error && (
        <div
          role="alert"
          style={{
            padding: "10px 14px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger-border)",
            borderRadius: 6,
            color: "var(--red)",
            fontSize: "0.85rem",
            margin: "12px 12px 0",
          }}
        >
          <strong>Not authenticated:</strong> {actorState.error}.{" "}
          Mutating actions (approve, publish, etc.) will fail. Contact your Workspace admin to be added to a video-sync group.
        </div>
      )}
      <div style={{ display: "flex", alignItems: "stretch", minHeight: "100vh" }}>
        <Sidebar />
        <main id="main-content" tabIndex={-1} style={{ flex: 1, minWidth: 0, padding: "16px 24px 32px" }}>
          {/* Slim per-page header bar. Individual pages render their
              own H1 inside. This band carries app-wide affordances
              (build badge, log toggle). */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <BuildBadge />
            <div style={{ flex: 1 }} />
            <ThemeSelector />
            <button
              className={`btn btn-sm ${showLogs ? "btn-primary" : ""}`}
              onClick={() => setShowLogs(v => !v)}
              title="Toggle the session Event Log"
            >
              {showLogs ? "Hide Logs" : "View Logs"}
            </button>
          </div>
          {children}
          {showLogs && <EventLog events={events} forceShow />}
        </main>
      </div>
    </>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary>
      <AppProvider>
        <AppShell>{children}</AppShell>
      </AppProvider>
    </ErrorBoundary>
  );
}
