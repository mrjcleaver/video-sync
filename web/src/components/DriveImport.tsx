"use client";

/**
 * ADR-071 §1 Publisher path — authenticated Drive ingest.
 *
 * Paste-a-link only for MVP; the Google Picker JS SDK integration is
 * deferred (ADR-071 §Deferred). Server-side ingest uses the Cloud Run
 * runtime service account (`drive.readonly`), so the operator does NOT
 * need to authenticate a personal Google identity here — the role gate
 * on /api/drive/ingest (Publisher+) is enough.
 *
 * Selecting a link with metadata that came back publicly still routes
 * through the same code path — the ingest endpoint accepts the auth
 * hint the client passes and picks the token accordingly.
 */

import { useState } from "react";
import { WasmVideoRecord } from "../lib/wasm";
import { videoStore } from "../lib/store";
import type { DriveVideoMetadata, DriveMetadataRequiresAuth } from "../app/api/drive/metadata/route";
import HelpTip from "./HelpTip";

interface Props {
  onImported: (imported?: { ids: string[] }) => void;
  onEvent: (event: string, fields?: { video_id?: string }) => void;
}

function detectFileId(input: string): string | null {
  const s = input.trim();
  let m = s.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{20,})/i);
  if (m) return m[1];
  m = s.match(/drive\.google\.com\/(?:open|uc)\?[^"']*id=([A-Za-z0-9_-]{20,})/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  return null;
}

export default function DriveImport({ onImported, onEvent }: Props) {
  const [url, setUrl] = useState("");
  const [meta, setMeta] = useState<DriveVideoMetadata | null>(null);
  const [pending, setPending] = useState<DriveMetadataRequiresAuth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "fetching" | "importing">("idle");

  async function fetchMeta() {
    setError(null); setMeta(null); setPending(null);
    const fileId = detectFileId(url);
    if (!fileId) {
      setError("Paste a Google Drive file link (drive.google.com/file/d/…) or a raw file ID.");
      return;
    }
    setStatus("fetching");
    try {
      const res = await fetch("/api/drive/metadata", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: fileId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Drive metadata (${res.status})`);
        return;
      }
      if ("requires_auth" in data && data.requires_auth) {
        setPending(data);
        return;
      }
      setMeta(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatus("idle");
    }
  }

  async function importIt() {
    if (!meta) return;
    setStatus("importing");
    try {
      const extra: Record<string, string> = {
        drive_file_id: meta.file_id,
        drive_mime_type: meta.mime_type,
        drive_web_view_link: meta.web_view_link ?? url,
      };
      if (meta.owner_email) extra.drive_original_owner_email = meta.owner_email;
      if (meta.owner_name) extra.drive_original_owner_name = meta.owner_name;
      if (meta.size_bytes != null) extra.drive_size_bytes = String(meta.size_bytes);
      const cmd = {
        source_id: `drive-${meta.file_id}`,
        source_platform: "GoogleDrive",
        title: meta.name.replace(/\.[a-zA-Z0-9]{2,5}$/, ""),
        description: undefined,
        duration_seconds: Math.max(0, Math.round(meta.duration_seconds ?? 0)),
        participants: [],
        download_url: meta.web_view_link ?? url,
        thumbnail_url: meta.thumbnail_link ?? undefined,
        tags: ["google-drive-import"],
        recorded_at: meta.created_time ?? meta.modified_time ?? undefined,
        metadata_extra: extra,
      };
      const record = new WasmVideoRecord(JSON.stringify(cmd));
      videoStore.add(record);
      const recordId = record.id();
      // Trigger the ingest — Publisher path always uses the SA token,
      // even if the file was publicly resolvable. Consistent auth
      // posture at ingest time is easier to audit.
      void fetch("/api/drive/ingest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: meta.file_id, record_id: recordId, auth: "service_account" }),
      }).catch(() => { /* poll /api/drive/status for state */ });
      onEvent(`VideoIndexed: "${cmd.title}" (Google Drive import — ingest queued)`, { video_id: recordId });
      onImported({ ids: [recordId] });
      setUrl(""); setMeta(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatus("idle");
    }
  }

  return (
    <div className="zoom-import">
      <div className="zoom-import-header">
        <h2>Import from Google Drive</h2>
      </div>
      <HelpTip>
        Paste a <code>drive.google.com/file/d/…</code> link. Files publicly shared OR shared with the org
        runtime service account can be pulled. Bytes stream to the FUSE bucket at import time (ADR-071).
      </HelpTip>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 8 }}>
        <label htmlFor="drive-import-url" className="visually-hidden">Google Drive file URL</label>
        <input
          id="drive-import-url"
          type="url"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setMeta(null); setPending(null); setError(null); }}
          placeholder="https://drive.google.com/file/d/…"
          aria-invalid={!!error}
          style={{
            flex: 1, padding: "6px 8px", background: "var(--bg)", color: "var(--text)",
            border: "1px solid var(--border)", borderRadius: 6, fontSize: "0.85rem", fontFamily: "monospace",
          }}
        />
        <button
          type="button" className="btn btn-sm btn-primary"
          onClick={fetchMeta} disabled={status !== "idle" || !url.trim()}
        >
          {status === "fetching" ? "Fetching…" : "Fetch"}
        </button>
      </div>

      {error && <div className="zoom-import-error" role="alert" style={{ marginTop: 8 }}>{error}</div>}

      {pending && (
        <div role="alert" style={{ marginTop: 8, padding: 10, border: "1px solid var(--warning-border, rgba(234,179,8,0.3))", borderRadius: 6, background: "var(--warning-soft, rgba(234,179,8,0.08))", fontSize: "0.82rem" }}>
          <strong>Not readable.</strong> {pending.reason}
          <div style={{ marginTop: 4, color: "var(--text-muted)" }}>
            Ask the sharer to open "anyone with the link", or share the file with the org&apos;s runtime
            service account, then re-fetch.
          </div>
        </div>
      )}

      {meta && (
        <div style={{ marginTop: 10, padding: 10, border: "1px solid var(--border)", borderRadius: 6 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            {meta.thumbnail_link && (
              <img src={meta.thumbnail_link} alt="" style={{ width: 100, height: 56, objectFit: "cover", borderRadius: 4, flexShrink: 0 }} />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{meta.name}</div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 2 }}>
                {meta.mime_type}
                {meta.duration_seconds != null && ` · ${Math.floor(meta.duration_seconds / 60)}m ${meta.duration_seconds % 60}s`}
                {meta.size_bytes != null && ` · ${(meta.size_bytes / (1024 * 1024)).toFixed(1)} MB`}
                {meta.resolved_via === "service_account" && " · via org service account"}
                {meta.resolved_via === "public" && " · publicly readable"}
              </div>
              {meta.owner_name && (
                <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: 2 }}>
                  Owner: {meta.owner_name}{meta.owner_email ? ` <${meta.owner_email}>` : ""}
                </div>
              )}
            </div>
          </div>
          <button
            type="button" className="btn btn-primary" style={{ marginTop: 10 }}
            onClick={importIt} disabled={status === "importing"}
          >
            {status === "importing" ? "Importing…" : "Import + ingest to FUSE"}
          </button>
        </div>
      )}
    </div>
  );
}
