"use client";

/**
 * Maintain-page card that bulk-compares local descriptions with
 * live YouTube snippets and pushes selected records. Every push
 * captures a backup of the prior YouTube state (server side,
 * data/description-backups.json, capped at 2 per record). Backups
 * are listable + restorable from the same panel.
 */

import { useCallback, useMemo, useState } from "react";
import type { VideoRecordJSON } from "../lib/wasm";
import { useCurrentActor } from "../lib/useCurrentActor";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  videos: VideoRecordJSON[];
  onEvent: (msg: string, ctx?: { video_id?: string }) => void;
}

interface Delta {
  record_id: string;
  yt_video_id: string;
  title: string;
  local_description: string;
  yt_description: string;
  status: "in_sync" | "differs" | "yt_empty" | "local_empty" | "missing_on_yt";
}

interface BackupRow {
  id: string;
  record_id: string;
  yt_video_id: string;
  taken_at: string;
  taken_by: string;
  prior_title: string;
  prior_description: string;
  new_title?: string;
}

function getYouTubeCreds(): { refreshToken: string; clientId: string; clientSecret: string } | null {
  try {
    const raw = localStorage.getItem("video-sync:connections");
    if (!raw) return null;
    const c = JSON.parse(raw)?.YouTube?.credentials;
    if (!c?.refreshToken || !c?.clientId || !c?.clientSecret) return null;
    return { refreshToken: c.refreshToken, clientId: c.clientId, clientSecret: c.clientSecret };
  } catch { return null; }
}

function extractYtId(v: VideoRecordJSON): string | null {
  const loc = (v.locations ?? []).find(l => l.platform === "YouTube" && l.role === "Destination" && l.external_id)
           ?? (v.locations ?? []).find(l => l.platform === "YouTube" && l.role === "Origin" && l.external_id);
  const raw = loc?.external_id ?? (v.source_platform === "YouTube" ? v.source_id : null);
  if (!raw) return null;
  return raw.startsWith("youtube-") ? raw.slice("youtube-".length) : raw;
}

function statusColor(s: Delta["status"]): string {
  return s === "in_sync"       ? "var(--text-muted)"
       : s === "differs"       ? "#f59e0b"
       : s === "yt_empty"      ? "#3b82f6"
       : s === "local_empty"   ? "var(--text-muted)"
       : "var(--red)";
}
function statusLabel(s: Delta["status"]): string {
  return s === "in_sync"       ? "in sync"
       : s === "differs"       ? "differs"
       : s === "yt_empty"      ? "YouTube empty; local has copy"
       : s === "local_empty"   ? "local empty"
       : "missing on YouTube";
}

export default function DescriptionSyncPanel({ videos, onEvent }: Props) {
  const actorState = useCurrentActor();
  const isPublisherPlus = actorState.actor?.role === "Admin" || actorState.actor?.role === "Publisher";
  const [scanning, setScanning] = useState(false);
  const [deltas, setDeltas] = useState<Delta[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBackups, setShowBackups] = useState<string | null>(null);   // record_id whose backups are open
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [restoreTarget, setRestoreTarget] = useState<BackupRow | null>(null);
  const [restoring, setRestoring] = useState(false);

  const eligible = useMemo(
    () => videos.filter(v => v.source_platform !== "OpusClip" && extractYtId(v) && (v.description ?? "").length > 0),
    [videos],
  );

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    setDeltas([]);
    setSelected(new Set());
    try {
      const creds = getYouTubeCreds();
      if (!creds) throw new Error("YouTube credentials missing. Configure in Connections first.");
      const byYtId = new Map<string, VideoRecordJSON>();
      for (const v of eligible) {
        const id = extractYtId(v);
        if (id) byYtId.set(id, v);
      }
      const ids = Array.from(byYtId.keys());
      const results: Delta[] = [];
      // Batch fetch — server accepts up to 50 per call.
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const res = await fetch("/api/youtube/snippets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoIds: chunk, ...creds }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        const returnedIds = new Set<string>();
        for (const s of (data.snippets ?? []) as Array<{ id: string; title: string; description: string }>) {
          returnedIds.add(s.id);
          const rec = byYtId.get(s.id);
          if (!rec) continue;
          const local = rec.description ?? "";
          const yt = s.description ?? "";
          let status: Delta["status"] = "in_sync";
          if (!local) status = "local_empty";
          else if (!yt) status = "yt_empty";
          else if (local.trim() !== yt.trim()) status = "differs";
          results.push({
            record_id: rec.id, yt_video_id: s.id, title: rec.title,
            local_description: local, yt_description: yt, status,
          });
        }
        // Any chunk ids YouTube didn't return = not-found / deleted
        for (const id of chunk) {
          if (returnedIds.has(id)) continue;
          const rec = byYtId.get(id);
          if (!rec) continue;
          results.push({
            record_id: rec.id, yt_video_id: id, title: rec.title,
            local_description: rec.description ?? "", yt_description: "",
            status: "missing_on_yt",
          });
        }
      }
      setDeltas(results);
      onEvent(`Description sync scan: ${results.length} records compared, ${results.filter(d => d.status === "differs" || d.status === "yt_empty").length} need push`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }, [eligible, onEvent]);

  const needsPush = deltas.filter(d => d.status === "differs" || d.status === "yt_empty");

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function selectAllNeedsPush() {
    setSelected(new Set(needsPush.map(d => d.record_id)));
  }

  const push = useCallback(async () => {
    if (selected.size === 0) return;
    setPushing(true);
    setError(null);
    try {
      const creds = getYouTubeCreds();
      if (!creds) throw new Error("YouTube credentials missing.");
      let ok = 0, failed = 0;
      for (const d of deltas) {
        if (!selected.has(d.record_id)) continue;
        const rec = videos.find(v => v.id === d.record_id);
        if (!rec) continue;
        try {
          const res = await fetch("/api/youtube/update-title", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              videoId: d.yt_video_id,
              title: rec.title,
              description: rec.description ?? "",
              record_id: rec.id,
              ...creds,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && (data as { updated?: boolean }).updated) {
            ok++;
            onEvent(`YouTubePush ok YouTube/${d.yt_video_id}: bulk-sync description`, { video_id: rec.id });
          } else if (res.ok) {
            // Already matches — no-op.
            onEvent(`YouTubePush no-op YouTube/${d.yt_video_id}: already matches`, { video_id: rec.id });
          } else {
            failed++;
            onEvent(`YouTubePush failed YouTube/${d.yt_video_id}: ${(data as { error?: string }).error ?? `HTTP ${res.status}`}`, { video_id: rec.id });
          }
        } catch (err) {
          failed++;
          onEvent(`YouTubePush errored YouTube/${d.yt_video_id}: ${err instanceof Error ? err.message : String(err)}`, { video_id: rec.id });
        }
      }
      onEvent(`Bulk description sync complete — ${ok} pushed, ${failed} failed. Prior YouTube states backed up (2 kept per record).`);
      // Re-scan to update the deltas view.
      void scan();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPushing(false);
    }
  }, [selected, deltas, videos, onEvent, scan]);

  async function openBackupsFor(record_id: string) {
    setShowBackups(record_id);
    setBackups([]);
    try {
      const res = await fetch(`/api/description/backups?record_id=${encodeURIComponent(record_id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setBackups(data.backups ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function confirmRestore() {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      const creds = getYouTubeCreds();
      if (!creds) throw new Error("YouTube credentials missing.");
      const res = await fetch(`/api/description/backups/${encodeURIComponent(restoreTarget.id)}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creds),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
      onEvent(`YouTubeRestore ok: backup ${restoreTarget.id.slice(0, 8)}… restored`);
      setRestoreTarget(null);
      if (showBackups) void openBackupsFor(showBackups);
      void scan();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoring(false);
    }
  }

  if (!isPublisherPlus) return null;

  return (
    <div style={{
      marginTop: 12, padding: 10,
      background: "rgba(59,130,246,0.05)", border: "1px solid rgba(59,130,246,0.28)", borderRadius: 4,
      fontSize: "0.82rem",
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>↗ YouTube description sync</div>
      <div style={{ color: "var(--text-muted)", marginBottom: 8 }}>
        Compare local <code>video.description</code> with each record&apos;s live YouTube description; push
        the selected records&apos; local values to YouTube. Every push captures a backup of the prior
        YouTube state (2 kept per record) — click <strong>Backups</strong> on any row to view or Restore.
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn btn-sm btn-primary" onClick={scan} disabled={scanning || pushing}>
          {scanning ? "Scanning…" : `🔄 Scan ${eligible.length} record${eligible.length === 1 ? "" : "s"}`}
        </button>
        {deltas.length > 0 && (
          <>
            <button className="btn btn-sm" onClick={selectAllNeedsPush} disabled={needsPush.length === 0}>
              ☑ Select all differing ({needsPush.length})
            </button>
            <button className="btn btn-sm btn-primary" onClick={push} disabled={pushing || selected.size === 0}>
              {pushing ? "Pushing…" : `↗ Push ${selected.size} to YouTube`}
            </button>
            <span style={{ color: "var(--text-muted)" }}>
              In sync: {deltas.filter(d => d.status === "in_sync").length} ·
              Differs: {deltas.filter(d => d.status === "differs").length} ·
              YT-empty: {deltas.filter(d => d.status === "yt_empty").length} ·
              Missing: {deltas.filter(d => d.status === "missing_on_yt").length}
            </span>
          </>
        )}
      </div>

      {error && <div style={{ color: "var(--red)", marginTop: 8 }}>Error: {error}</div>}

      {deltas.length > 0 && (
        <div style={{ marginTop: 10, maxHeight: 400, overflowY: "auto", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
            <thead style={{ position: "sticky", top: 0, background: "var(--bg-alt, var(--bg))" }}>
              <tr style={{ textAlign: "left", color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: "5px 4px", width: 30 }}></th>
                <th style={{ padding: "5px 4px" }}>Title</th>
                <th style={{ padding: "5px 4px" }}>Status</th>
                <th style={{ padding: "5px 4px" }}>Local / YT chars</th>
                <th style={{ padding: "5px 4px", width: 90 }}></th>
              </tr>
            </thead>
            <tbody>
              {deltas.map(d => (
                <tr key={d.record_id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "5px 4px" }}>
                    {(d.status === "differs" || d.status === "yt_empty") && (
                      <input
                        type="checkbox"
                        checked={selected.has(d.record_id)}
                        onChange={() => toggle(d.record_id)}
                      />
                    )}
                  </td>
                  <td style={{ padding: "5px 4px" }}>{d.title}</td>
                  <td style={{ padding: "5px 4px", color: statusColor(d.status) }}>{statusLabel(d.status)}</td>
                  <td style={{ padding: "5px 4px", fontFamily: "monospace", fontSize: "0.72rem", color: "var(--text-muted)" }}>
                    {d.local_description.length} / {d.yt_description.length}
                  </td>
                  <td style={{ padding: "5px 4px" }}>
                    <button
                      className="btn btn-sm"
                      style={{ fontSize: "0.68rem" }}
                      onClick={() => openBackupsFor(d.record_id)}
                    >
                      Backups
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showBackups && (
        <div style={{ marginTop: 10, padding: 8, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <strong>Backups for {showBackups.slice(0, 8)}…</strong>
            <button className="btn btn-sm" style={{ fontSize: "0.7rem" }} onClick={() => setShowBackups(null)}>✕ Close</button>
          </div>
          {backups.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>No backups on this record yet.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
                  <th style={{ padding: "4px" }}>Taken</th>
                  <th style={{ padding: "4px" }}>By</th>
                  <th style={{ padding: "4px" }}>Prior title</th>
                  <th style={{ padding: "4px", textAlign: "right" }}>Prior desc</th>
                  <th style={{ padding: "4px" }}></th>
                </tr>
              </thead>
              <tbody>
                {backups.map(b => (
                  <tr key={b.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "4px" }}>{new Date(b.taken_at).toLocaleString()}</td>
                    <td style={{ padding: "4px", color: "var(--text-muted)" }}>{b.taken_by}</td>
                    <td style={{ padding: "4px" }}>{b.prior_title.slice(0, 60)}{b.prior_title.length > 60 ? "…" : ""}</td>
                    <td style={{ padding: "4px", textAlign: "right", fontFamily: "monospace" }}>{b.prior_description.length}</td>
                    <td style={{ padding: "4px", textAlign: "right" }}>
                      <button
                        className="btn btn-sm btn-primary"
                        style={{ fontSize: "0.68rem" }}
                        onClick={() => setRestoreTarget(b)}
                      >
                        ↶ Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <ConfirmDialog
        open={!!restoreTarget}
        title="Restore this backup?"
        description={`This PUTs the prior title + description back to YouTube. The current YouTube state gets captured as a new backup first, so this action is itself undoable. Backup taken ${restoreTarget ? new Date(restoreTarget.taken_at).toLocaleString() : ""} by ${restoreTarget?.taken_by ?? ""}.`}
        confirmLabel="Restore"
        busy={restoring}
        onConfirm={confirmRestore}
        onCancel={() => setRestoreTarget(null)}
      />
    </div>
  );
}
