"use client";

/**
 * ADR-066 §7 — MCP token issuance UI.
 *
 * Admin-only. Lists the caller's existing tokens (or every token when
 * "show all" is on), lets them mint a new one (returns plaintext ONCE),
 * and revoke individual tokens. Plaintext is displayed with an "I've
 * saved it" acknowledgement — clicking it removes the plaintext from
 * the UI state (and it can never be re-shown).
 */

import { useCallback, useEffect, useState } from "react";
import { useCurrentActor } from "../lib/useCurrentActor";
import ConfirmDialog from "./ConfirmDialog";

interface TokenSummary {
  id: string;
  name: string;
  last4: string;
  actor_email: string;
  actor_role: string;
  created_at: string;
  last_used_at: string | null;
}

export default function McpTokensPanel() {
  const actorState = useCurrentActor();
  const isAdmin = actorState.actor?.role === "Admin";
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState<TokenSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [minting, setMinting] = useState(false);
  const [freshPlaintext, setFreshPlaintext] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<TokenSummary | null>(null);
  const [revoking, setRevoking] = useState(false);

  const refresh = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/mcp/tokens${showAll ? "?all=1" : ""}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setTokens(data.tokens ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [isAdmin, showAll]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  async function mint() {
    setMinting(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName || `Token ${new Date().toISOString().slice(0, 10)}` }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setFreshPlaintext(data.plaintext);
      setNewName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMinting(false);
    }
  }

  async function confirmRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    setError(null);
    try {
      const res = await fetch(`/api/mcp/tokens/${encodeURIComponent(revokeTarget.id)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setRevokeTarget(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div
        className="panel-header"
        onClick={() => setOpen(v => !v)}
        style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <div>
          <strong>🔌 MCP tokens (ADR-066)</strong>
          <span style={{ color: "var(--text-muted)", marginLeft: 8, fontSize: "0.85rem" }}>
            Bearer tokens for Claude Desktop / mcp-remote / other headless MCP clients.
          </span>
        </div>
        <span>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="panel-body" style={{ padding: 12 }}>
          {!isAdmin && (
            <div style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
              Admin required to mint or revoke MCP tokens.
            </div>
          )}
          {isAdmin && (
            <>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="Token label — e.g. 'Claude Desktop laptop'"
                  style={{
                    flex: 1, minWidth: 220, padding: "6px 8px", fontSize: "0.85rem",
                    background: "var(--bg)", color: "var(--text)",
                    border: "1px solid var(--border)", borderRadius: 4,
                  }}
                />
                <button
                  className="btn btn-sm btn-primary"
                  onClick={mint}
                  disabled={minting}
                >
                  {minting ? "Minting…" : "+ Mint token"}
                </button>
                <label style={{ fontSize: "0.78rem", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
                  <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
                  Show all admins&apos; tokens
                </label>
              </div>

              {freshPlaintext && (
                <div style={{
                  padding: 12, marginBottom: 12,
                  background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.4)",
                  borderRadius: 4, fontSize: "0.85rem",
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 6, color: "#22c55e" }}>
                    ✅ Token minted — copy it now. This is the only time it will be shown.
                  </div>
                  <div style={{
                    padding: 8, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: 3, fontFamily: "monospace", fontSize: "0.82rem",
                    wordBreak: "break-all", userSelect: "all",
                  }}>
                    {freshPlaintext}
                  </div>
                  <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => { navigator.clipboard?.writeText(freshPlaintext); }}
                    >
                      📋 Copy
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => setFreshPlaintext(null)}
                    >
                      ✅ I&apos;ve saved it
                    </button>
                  </div>
                </div>
              )}

              {error && (
                <div style={{ color: "var(--red)", fontSize: "0.82rem", marginBottom: 8 }}>Error: {error}</div>
              )}

              {loading ? (
                <div style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>Loading…</div>
              ) : tokens.length === 0 ? (
                <div style={{ color: "var(--text-muted)", fontSize: "0.82rem", fontStyle: "italic" }}>
                  No tokens yet. Mint one above.
                </div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
                      <th style={{ padding: "6px 4px" }}>Name</th>
                      <th style={{ padding: "6px 4px" }}>Owner</th>
                      <th style={{ padding: "6px 4px" }}>Ends in</th>
                      <th style={{ padding: "6px 4px" }}>Created</th>
                      <th style={{ padding: "6px 4px" }}>Last used</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokens.map(t => (
                      <tr key={t.id} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "6px 4px" }}>{t.name}</td>
                        <td style={{ padding: "6px 4px", color: "var(--text-muted)" }}>{t.actor_email} <span style={{ fontSize: "0.72rem" }}>({t.actor_role})</span></td>
                        <td style={{ padding: "6px 4px", fontFamily: "monospace" }}>…{t.last4}</td>
                        <td style={{ padding: "6px 4px", color: "var(--text-muted)" }}>{new Date(t.created_at).toLocaleDateString()}</td>
                        <td style={{ padding: "6px 4px", color: "var(--text-muted)" }}>
                          {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "—"}
                        </td>
                        <td style={{ padding: "6px 4px", textAlign: "right" }}>
                          <button
                            className="btn btn-sm btn-red"
                            onClick={() => setRevokeTarget(t)}
                            style={{ fontSize: "0.72rem" }}
                          >
                            Revoke
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div style={{ marginTop: 12, fontSize: "0.78rem", color: "var(--text-muted)" }}>
                Use tokens with Claude Desktop&apos;s <strong>Custom Connector</strong> (Headers → Authorization: <code>Bearer &lt;token&gt;</code>) or <code>mcp-remote</code>&apos;s <code>--header</code> flag. See the <strong>🔌 Connect via MCP</strong> section in the sidebar for full snippets.
              </div>
            </>
          )}
        </div>
      )}
      <ConfirmDialog
        open={!!revokeTarget}
        title="Revoke MCP token?"
        description={`"${revokeTarget?.name ?? ""}" will stop working immediately. Any MCP client using it will start returning 401 on the next call. This cannot be undone.`}
        confirmLabel="Revoke"
        busy={revoking}
        onConfirm={confirmRevoke}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  );
}
