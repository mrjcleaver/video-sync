"use client";

/**
 * Admin-only panel that surfaces the in-memory audit ring (ADR-041)
 * aggregated per actor. Answers "who has been in the app and with
 * what effective role?" without an admin having to open Cloud Logging.
 *
 * The ring is per-Cloud-Run-instance + capped at 500 events, so this
 * is a "recent" view. Multi-instance deploys will show per-instance
 * subsets; a full history query still lives in Cloud Logging.
 */

import { useCallback, useEffect, useState } from "react";
import { useCurrentActor } from "../lib/useCurrentActor";

interface ActorRow {
  actor_email: string;
  roles: string[];
  latest_role: string;
  first_seen: string;
  last_seen: string;
  request_count: number;
  mutation_count: number;
  paths_touched: string[];
  last_status: number;
  last_path: string;
}

function fmtRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return iso;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

function roleColor(role: string): string {
  return role === "Admin"       ? "#a78bfa"
       : role === "Publisher"   ? "#22c55e"
       : role === "Contributor" ? "#60a5fa"
       : role === "Viewer"      ? "var(--text-muted)"
       : "var(--text-muted)";
}

export default function AccessLogPanel() {
  const actorState = useCurrentActor();
  const isAdmin = actorState.actor?.role === "Admin";
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ActorRow[]>([]);
  const [ring, setRing] = useState<{ size: number; capacity: number }>({ size: 0, capacity: 500 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const refresh = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/audit/actors");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRows(data.actors ?? []);
      setRing({ size: data.ring_size ?? 0, capacity: data.ring_capacity ?? 500 });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open || !autoRefresh) return;
    const id = setInterval(() => { void refresh(); }, 10_000);
    return () => clearInterval(id);
  }, [open, autoRefresh, refresh]);

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div
        className="panel-header"
        onClick={() => setOpen(v => !v)}
        style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <div>
          <strong>👥 Access log</strong>
          <span style={{ color: "var(--text-muted)", marginLeft: 8, fontSize: "0.85rem" }}>
            Who&apos;s been in the app + effective role (per-instance ring, capped 500).
          </span>
        </div>
        <span>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="panel-body" style={{ padding: 12 }}>
          {!isAdmin && (
            <div style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
              Admin required to view the access log.
            </div>
          )}
          {isAdmin && (
            <>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap", fontSize: "0.78rem" }}>
                <button className="btn btn-sm" onClick={() => void refresh()} disabled={loading}>
                  {loading ? "Refreshing…" : "🔄 Refresh"}
                </button>
                <label style={{ color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
                  <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
                  Auto-refresh (10s)
                </label>
                <span style={{ color: "var(--text-muted)", marginLeft: "auto" }}>
                  Ring: {ring.size} / {ring.capacity} events · {rows.length} distinct actor{rows.length === 1 ? "" : "s"}
                </span>
              </div>

              {error && (
                <div style={{ color: "var(--red)", fontSize: "0.82rem", marginBottom: 8 }}>Error: {error}</div>
              )}

              {rows.length === 0 && !loading ? (
                <div style={{ color: "var(--text-muted)", fontSize: "0.82rem", fontStyle: "italic" }}>
                  No audit events in this instance&apos;s ring yet.
                </div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
                      <th style={{ padding: "6px 4px" }}>User</th>
                      <th style={{ padding: "6px 4px" }}>Role</th>
                      <th style={{ padding: "6px 4px" }}>First seen</th>
                      <th style={{ padding: "6px 4px" }}>Last seen</th>
                      <th style={{ padding: "6px 4px", textAlign: "right" }}>Requests</th>
                      <th style={{ padding: "6px 4px", textAlign: "right" }}>Mutations</th>
                      <th style={{ padding: "6px 4px" }}>Last path</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.actor_email} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "6px 4px" }}>{r.actor_email}</td>
                        <td style={{ padding: "6px 4px" }}>
                          <span style={{ color: roleColor(r.latest_role), fontWeight: 600 }}>
                            {r.latest_role}
                          </span>
                          {r.roles.length > 1 && (
                            <span style={{ color: "var(--text-muted)", fontSize: "0.72rem", marginLeft: 4 }}
                              title={`Seen as: ${r.roles.join(", ")}`}
                            >
                              (also: {r.roles.filter(x => x !== r.latest_role).join(", ")})
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "6px 4px", color: "var(--text-muted)" }} title={r.first_seen}>
                          {fmtRelative(r.first_seen)}
                        </td>
                        <td style={{ padding: "6px 4px" }} title={r.last_seen}>
                          {fmtRelative(r.last_seen)}
                        </td>
                        <td style={{ padding: "6px 4px", textAlign: "right", fontFamily: "monospace" }}>
                          {r.request_count}
                        </td>
                        <td style={{ padding: "6px 4px", textAlign: "right", fontFamily: "monospace", color: r.mutation_count > 0 ? "#f59e0b" : "var(--text-muted)" }}>
                          {r.mutation_count}
                        </td>
                        <td style={{ padding: "6px 4px", fontFamily: "monospace", fontSize: "0.72rem", color: r.last_status >= 400 ? "var(--red)" : "var(--text-muted)" }}>
                          {r.last_status} {r.last_path.length > 40 ? r.last_path.slice(0, 40) + "…" : r.last_path}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div style={{ marginTop: 10, fontSize: "0.72rem", color: "var(--text-muted)" }}>
                Note: the buffer is per-Cloud-Run-instance and holds the last {ring.capacity} events.
                Cold-start clears it. For full audit history query Cloud Logging with
                <code style={{ marginLeft: 4 }}>jsonPayload.audit</code>.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
