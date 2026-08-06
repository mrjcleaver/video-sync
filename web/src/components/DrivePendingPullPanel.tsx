"use client";

/**
 * ADR-071 §2 — Publisher-facing card on /maintain that lists Drive
 * files a contributor submitted but couldn't publicly resolve. Each
 * row has a Pull button that triggers /api/drive/ingest with
 * auth=service_account, streams the file to the FUSE bucket, and
 * clears the drive_pending_curator flag on the record.
 */

import { useCallback, useMemo, useState } from "react";
import type { VideoRecordJSON } from "../lib/wasm";
import { findDrivePendingPulls } from "../lib/drivePendingPull";
import { videoStore } from "../lib/store";
import { useCurrentActor, actorCommand } from "../lib/useCurrentActor";

interface Props {
  videos: VideoRecordJSON[];
  onEvent: (msg: string, ctx?: { video_id?: string }) => void;
}

interface RowState {
  state: "idle" | "queued" | "copying" | "complete" | "failed";
  bytes_copied: number;
  bytes_total: number | null;
  error: string | null;
}

export default function DrivePendingPullPanel({ videos, onEvent }: Props) {
  const candidates = useMemo(() => findDrivePendingPulls(videos), [videos]);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const actorState = useCurrentActor();

  const updateRow = useCallback((recordId: string, patch: Partial<RowState>) => {
    setRowStates((s) => ({ ...s, [recordId]: { ...(s[recordId] ?? { state: "idle", bytes_copied: 0, bytes_total: null, error: null }), ...patch } }));
  }, []);

  async function pollUntilDone(recordId: string) {
    for (let i = 0; i < 240; i++) { // 240 * 2.5s = 10 minutes
      await new Promise((res) => setTimeout(res, 2500));
      try {
        const res = await fetch(`/api/drive/status?record_id=${encodeURIComponent(recordId)}`);
        if (!res.ok) continue;
        const data = await res.json();
        if (data.not_found) continue;
        updateRow(recordId, {
          state: data.state,
          bytes_copied: data.bytes_copied ?? 0,
          bytes_total: data.bytes_total ?? null,
          error: data.error ?? null,
        });
        if (data.state === "complete") {
          // Clear the pending flag on the local record so the row
          // drops out of the queue on next re-scan. Also add the
          // drive_ingested_at timestamp so downstream tooling knows.
          try {
            const rec = videoStore.getAll().find(v => v.id === recordId);
            const existingExtra = (rec as (VideoRecordJSON & { metadata_extra?: Record<string, string> }) | undefined)?.metadata_extra ?? {};
            const nextExtra: Record<string, string> = { ...existingExtra, drive_ingested_at: new Date().toISOString() };
            delete nextExtra.drive_pending_curator;
            videoStore.mutate(recordId, (r) =>
              r.update_metadata(actorCommand(actorState, {
                edits: { metadata_extra: nextExtra },
              })),
            );
          } catch { /* best-effort — the server-side ingest already succeeded */ }
          onEvent(`Drive ingest complete for ${recordId}`, { video_id: recordId });
          return;
        }
        if (data.state === "failed") {
          onEvent(`Drive ingest failed for ${recordId}: ${data.error ?? "unknown"}`, { video_id: recordId });
          return;
        }
      } catch { /* transient network error; try again */ }
    }
    updateRow(recordId, { state: "failed", error: "timed out waiting for ingest" });
  }

  async function pull(candidate: ReturnType<typeof findDrivePendingPulls>[number]) {
    const { record, file_id } = candidate;
    updateRow(record.id, { state: "queued", bytes_copied: 0, bytes_total: null, error: null });
    try {
      const res = await fetch("/api/drive/ingest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id, record_id: record.id, auth: "service_account" }),
      });
      const data = await res.json();
      if (!res.ok) {
        updateRow(record.id, { state: "failed", error: data.error ?? `ingest (${res.status})` });
        onEvent(`Drive ingest kickoff failed: ${data.error ?? res.status}`, { video_id: record.id });
        return;
      }
      updateRow(record.id, {
        state: data.job?.state ?? "queued",
        bytes_total: data.job?.bytes_total ?? null,
      });
      void pollUntilDone(record.id);
    } catch (err) {
      updateRow(record.id, { state: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (candidates.length === 0) {
    return null; // stays out of the way when there's no work
  }

  return (
    <div
      className="panel"
      style={{ padding: 12, marginBottom: 12, border: "1px solid var(--border)", borderRadius: 8 }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        📁 Drive pending pull
      </div>
      <div style={{ fontSize: "0.82rem", color: "var(--text-muted)", marginBottom: 8 }}>
        <strong>{candidates.length}</strong> Drive file{candidates.length === 1 ? "" : "s"} submitted by contributors need authenticated pull. Files are streamed to the FUSE bucket and become durable against the sharer revoking access. (ADR-071 §2.)
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {candidates.map((c) => {
          const rs = rowStates[c.record.id] ?? { state: "idle" as const, bytes_copied: 0, bytes_total: null, error: null };
          const pctLabel = rs.bytes_total
            ? `${((rs.bytes_copied / rs.bytes_total) * 100).toFixed(0)}%`
            : `${(rs.bytes_copied / (1024 * 1024)).toFixed(1)} MB`;
          return (
            <li
              key={c.record.id}
              style={{
                display: "flex", gap: 10, padding: "8px 10px", alignItems: "center",
                border: "1px solid var(--border)", borderRadius: 6,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: "0.88rem" }}>{c.record.title || "(untitled)"}</div>
                <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: 2 }}>
                  {c.submitted_by ? `by ${c.submitted_by} · ` : ""}file id <code>{c.file_id}</code>
                </div>
                {c.web_view_link && (
                  <a
                    href={c.web_view_link} target="_blank" rel="noreferrer"
                    style={{ fontSize: "0.72rem", color: "var(--accent-text, var(--accent))" }}
                  >
                    Open in Drive ↗
                  </a>
                )}
                {rs.state !== "idle" && (
                  <div style={{ fontSize: "0.72rem", color: rs.state === "failed" ? "var(--red)" : "var(--text-muted)", marginTop: 4 }}>
                    {rs.state === "queued" && "queued…"}
                    {rs.state === "copying" && `copying — ${pctLabel}`}
                    {rs.state === "complete" && "✅ complete (ingested to FUSE)"}
                    {rs.state === "failed" && `❌ ${rs.error ?? "failed"}`}
                  </div>
                )}
              </div>
              <button
                type="button" className="btn btn-sm btn-primary"
                onClick={() => pull(c)}
                disabled={rs.state === "queued" || rs.state === "copying" || rs.state === "complete"}
              >
                {rs.state === "queued" || rs.state === "copying" ? "Pulling…" : rs.state === "complete" ? "Done" : "Pull"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
