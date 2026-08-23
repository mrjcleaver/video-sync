"use client";

import { useState } from "react";
import { WasmVideoRecord } from "../lib/wasm";
import { videoStore } from "../lib/store";
import type { YouTubeVideoInfo } from "../app/api/youtube/video-info/route";
import type { LoomMetadata } from "../app/api/loom/metadata/route";
import type { DriveVideoMetadata, DriveMetadataRequiresAuth } from "../app/api/drive/metadata/route";
import HelpTip from "./HelpTip";

type Platform = "youtube" | "loom" | "zoom-share" | "google-drive" | "unknown";

interface DetectedUrl {
  raw: string;
  platform: Platform;
  id: string | null;
}

interface FetchedItem {
  raw: string;
  platform: Platform;
  id: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number;
  channelOrAuthor: string;
  publishedAt: string;
  extra: Record<string, string>;
  needsTos: boolean;
  error?: string;
  // Loom-specific Apollo extras (other platforms leave these undefined)
  transcriptText?: string;
  participants?: string[];
  chapters?: Array<{ time: number; title: string }>;
  /** ADR-071 — Drive files that couldn't resolve publicly. Still
   *  selectable so the contributor's submission lands in the catalog
   *  with metadata_extra.drive_pending_curator = "1" for the
   *  /maintain queue to pick up. */
  drivePendingCurator?: boolean;
  /** ADR-071 — Drive files should kick /api/drive/ingest at
   *  importSelected time; carries the ingest auth mode. Absent for
   *  pending-curator rows (curator triggers ingest later). */
  driveIngestAuth?: "public" | "service_account";
}

function detect(input: string): DetectedUrl {
  const s = input.trim();
  let m = s.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (m) return { raw: s, platform: "youtube", id: m[1] };
  m = s.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (m) return { raw: s, platform: "youtube", id: m[1] };
  m = s.match(/youtube\.com\/(?:live|embed)\/([a-zA-Z0-9_-]{11})/);
  if (m) return { raw: s, platform: "youtube", id: m[1] };
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return { raw: s, platform: "youtube", id: s };
  m = s.match(/loom\.com\/(?:share|v)\/([a-f0-9]+)/i);
  if (m) return { raw: s, platform: "loom", id: m[1] };
  // Zoom public share URLs — the id after `/rec/share/` is a base64
  // blob that may carry a `.passcode` suffix. We keep the full thing
  // as-is so the source_id round-trips to the exact playable link.
  m = s.match(/zoom\.us\/rec\/share\/([A-Za-z0-9_.\-]+)/i);
  if (m) return { raw: s, platform: "zoom-share", id: m[1] };
  // ADR-071 — Google Drive file URLs. Three shapes:
  //   drive.google.com/file/d/<id>/…
  //   drive.google.com/open?id=<id>
  //   drive.google.com/uc?id=<id>[&export=…]
  // Rejects docs.google.com paths — those are Google-native assets
  // (Docs / Sheets / Slides) not video files.
  m = s.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{20,})/i);
  if (m) return { raw: s, platform: "google-drive", id: m[1] };
  m = s.match(/drive\.google\.com\/(?:open|uc)\?[^"']*id=([A-Za-z0-9_-]{20,})/i);
  if (m) return { raw: s, platform: "google-drive", id: m[1] };
  return { raw: s, platform: "unknown", id: null };
}

function fmt(s: number): string {
  if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
}

function getGoogleApiKey(): string | null {
  try {
    const raw = localStorage.getItem("video-sync:connections");
    if (!raw) return null;
    return JSON.parse(raw)?.YouTube?.credentials?.googleApiKey?.trim() || null;
  } catch { return null; }
}

async function fetchYouTube(id: string): Promise<FetchedItem> {
  const apiKey = getGoogleApiKey();
  const params = new URLSearchParams({ videoId: id });
  if (apiKey) params.set("apiKey", apiKey);
  const res = await fetch(`/api/youtube/video-info?${params}`);
  const data: YouTubeVideoInfo & { error?: string } = await res.json();
  if (!res.ok) throw new Error(data.error ?? `YouTube error (${res.status})`);
  return {
    raw: `https://www.youtube.com/watch?v=${id}`,
    platform: "youtube",
    id,
    title: data.title,
    description: data.description,
    thumbnailUrl: data.thumbnailUrl,
    durationSeconds: data.durationSeconds,
    channelOrAuthor: data.channelTitle,
    publishedAt: data.publishedAt,
    needsTos: true,
    extra: {
      channel: data.channelTitle,
      privacy_status: data.privacyStatus,
      live_broadcast_content: data.liveBroadcastContent,
      youtube_url: `https://www.youtube.com/watch?v=${id}`,
    },
  };
}

async function fetchLoom(id: string, raw: string): Promise<FetchedItem> {
  const res = await fetch(`/api/loom/metadata?url=${encodeURIComponent(raw)}`);
  const data: LoomMetadata & { error?: string } = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Loom error (${res.status})`);

  // Build the participants list from the scraped owner. Prefer email
  // (canonical identity for the dedupe matcher); fall back to name.
  const participants: string[] = [];
  if (data.ownerEmail) participants.push(data.ownerEmail);
  else if (data.ownerName) participants.push(data.ownerName);

  // metadata_extra carries opaque key/value strings — flatten chapters
  // into a count + JSON blob so future UI can render them without a
  // schema change to the WASM record.
  const extra: Record<string, string> = {
    author: data.authorName,
    loom_url: raw,
  };
  if (data.ownerName) extra.owner_name = data.ownerName;
  if (data.ownerEmail) extra.owner_email = data.ownerEmail;
  if (data.language) extra.language = data.language;
  if (data.chapters && data.chapters.length > 0) {
    extra.chapters_count = String(data.chapters.length);
    extra.chapters_json = JSON.stringify(data.chapters);
  }

  return {
    raw,
    platform: "loom",
    id,
    title: data.title,
    description: data.description,
    thumbnailUrl: data.thumbnailUrl,
    durationSeconds: data.durationSeconds ?? 0,
    channelOrAuthor: data.authorName,
    // Real recorded-at from Apollo state when available; fall back to
    // "imported now" so older Looms whose share page no longer exposes
    // createdAt still get a sortable timestamp.
    publishedAt: data.createdAt ?? new Date().toISOString(),
    needsTos: false,
    extra,
    transcriptText: data.transcriptText ?? undefined,
    participants,
    chapters: data.chapters ?? undefined,
  };
}

/**
 * ADR-071 §1 — public Drive share resolution. The server responds
 * with either DriveVideoMetadata (public / SA succeeded) or
 * { requires_auth: true } which we surface as a pending-curator row
 * that still lands in the catalog on import.
 */
async function fetchDrive(id: string, raw: string): Promise<FetchedItem> {
  const res = await fetch("/api/drive/metadata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: id }),
  });
  const data = (await res.json()) as (DriveVideoMetadata & { error?: string }) | DriveMetadataRequiresAuth;
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Drive metadata (${res.status})`);
  }
  if ("requires_auth" in data && data.requires_auth) {
    // Contributor-visible pending-curator row. Placeholder metadata;
    // curator's authenticated pull fills it in later.
    return {
      raw, platform: "google-drive", id,
      title: `Drive video — ${new Date().toISOString().slice(0, 10)}`,
      description: `Contributor-submitted Drive file. Pending curator pull — this file needs authenticated access.\nOriginal URL: ${raw}`,
      thumbnailUrl: null,
      durationSeconds: 0,
      channelOrAuthor: "",
      publishedAt: "",
      needsTos: false,
      extra: {
        drive_file_id: id,
        drive_web_view_link: raw,
        drive_pending_curator: "1",
        contributor_submitted: "1",
      },
      drivePendingCurator: true,
    };
  }
  const meta = data as DriveVideoMetadata;
  const extra: Record<string, string> = {
    drive_file_id: meta.file_id,
    drive_mime_type: meta.mime_type,
    drive_web_view_link: meta.web_view_link ?? raw,
  };
  if (meta.owner_email) extra.drive_original_owner_email = meta.owner_email;
  if (meta.owner_name) extra.drive_original_owner_name = meta.owner_name;
  if (meta.size_bytes != null) extra.drive_size_bytes = String(meta.size_bytes);
  return {
    raw, platform: "google-drive", id,
    title: meta.name.replace(/\.[a-zA-Z0-9]{2,5}$/, ""),
    description: null,
    thumbnailUrl: meta.thumbnail_link,
    durationSeconds: meta.duration_seconds ?? 0,
    channelOrAuthor: meta.owner_name ?? "",
    publishedAt: meta.created_time ?? meta.modified_time ?? "",
    needsTos: false,
    extra,
    driveIngestAuth: meta.resolved_via === "public" ? "public" : "service_account",
  };
}

interface Props {
  /** Called once after a batch of records is created, with the ids of the
   *  records created. Handlers that don't need the ids can take no
   *  arguments — the contribute page uses them to stamp contributor
   *  attribution and apply a pasted transcript. */
  onImported: (result: { ids: string[] }) => void;
  onEvent: (event: string, fields?: { video_id?: string }) => void;
}

export default function URLImport({ onImported, onEvent }: Props) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<(FetchedItem & { fetchError?: string })[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tosAccepted, setTosAccepted] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  async function fetchAll() {
    const lines = input.split("\n").map(s => s.trim()).filter(Boolean);
    if (!lines.length) return;

    setLoading(true);
    setItems([]);
    setSelected(new Set());
    setTosAccepted(false);
    setGlobalError(null);

    const results = await Promise.all(
      lines.map(async (line): Promise<FetchedItem & { fetchError?: string }> => {
        const { platform, id, raw } = detect(line);
        if (!id || platform === "unknown") {
          return { raw: line, platform: "unknown", id: line, title: line, description: null, thumbnailUrl: null, durationSeconds: 0, channelOrAuthor: "", publishedAt: "", needsTos: false, extra: {}, fetchError: "Unrecognised URL — expected YouTube, Loom, a public Zoom share (zoom.us/rec/share/…), or a Google Drive file link" };
        }
        const sourceId = `${platform}-${id}`;
        const alreadyIn = videoStore.getAll().some(v => v.source_id === sourceId);
        if (alreadyIn) {
          return { raw, platform, id, title: "", description: null, thumbnailUrl: null, durationSeconds: 0, channelOrAuthor: "", publishedAt: "", needsTos: false, extra: {}, fetchError: "Already in catalogue" };
        }
        try {
          if (platform === "youtube") return await fetchYouTube(id);
          if (platform === "loom") return await fetchLoom(id, raw);
          if (platform === "google-drive") return await fetchDrive(id, raw);
          // Zoom-share: no unauthenticated metadata API. We accept
          // the URL as-is with a placeholder title. A curator can
          // re-fetch via the authenticated Zoom API later; the raw
          // share URL is preserved in download_url so it stays
          // playable end-to-end.
          return {
            raw, platform, id,
            title: `Zoom recording — ${new Date().toISOString().slice(0, 10)}`,
            description: `Contributor-submitted Zoom share.\nOriginal URL: ${raw}\n\n(Curator: please rename + enrich this record; Zoom's public share page doesn't expose metadata without OAuth.)`,
            thumbnailUrl: null,
            durationSeconds: 0,
            channelOrAuthor: "",
            publishedAt: "",
            needsTos: false,
            extra: { zoom_share_url: raw, contributor_submitted: "1" },
          };
        } catch (err) {
          return { raw, platform, id, title: "", description: null, thumbnailUrl: null, durationSeconds: 0, channelOrAuthor: "", publishedAt: "", needsTos: false, extra: {}, fetchError: String(err) };
        }
      })
    );

    setItems(results);
    const selectable = new Set(results.filter(r => !r.fetchError).map(r => r.id));
    setSelected(selectable);
    setLoading(false);
  }

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const needsTosCheck = items.some(i => selected.has(i.id) && i.needsTos);

  function importSelected() {
    if (needsTosCheck && !tosAccepted) return;
    let count = 0;
    const createdIds: string[] = [];
    for (const item of items) {
      if (!selected.has(item.id) || item.fetchError) continue;
      const sourcePlatform =
        item.platform === "youtube"      ? "YouTube"
      : item.platform === "loom"          ? "Loom"
      : item.platform === "zoom-share"    ? "Zoom"
      : item.platform === "google-drive"  ? "GoogleDrive"
      : "Unknown";
      // Namespace Zoom-share source_ids with a `zoom-share-` prefix so
      // they don't collide with OAuth-imported Zoom rows (which use
      // `zoom-<meeting-uuid>`). The share id is base64 with dots which
      // survives Rust's SourcePlatformId round-trip fine.
      const sourceId =
        item.platform === "youtube"      ? `youtube-${item.id}`
      : item.platform === "loom"          ? `loom-${item.id}`
      : item.platform === "zoom-share"    ? `zoom-share-${item.id}`
      : item.platform === "google-drive"  ? `drive-${item.id}`
      : `${item.platform}-${item.id}`;
      // Drive rows point at the FUSE-copied file on completion; while
      // the ingest is running (or if it's pending curator pull), we
      // leave the raw share URL so the record has a legible link.
      const downloadUrl =
        item.platform === "youtube"      ? `youtube://${item.id}`
      : /* loom / zoom-share / drive */    item.raw;
      const cmd: Record<string, unknown> = {
        source_id: sourceId,
        source_platform: sourcePlatform,
        title: item.title,
        description: item.description || undefined,
        // Loom's oEmbed returns fractional seconds (e.g. 7495.15) but the
        // WASM record's duration_seconds is u32. Round to nearest integer.
        duration_seconds: Math.max(0, Math.round(Number(item.durationSeconds) || 0)),
        participants: item.participants ?? [],
        download_url: downloadUrl,
        thumbnail_url: item.thumbnailUrl || undefined,
        tags: [`${item.platform}-import`],
        recorded_at: item.publishedAt || undefined,
        metadata_extra: item.extra,
      };
      const record = new WasmVideoRecord(JSON.stringify(cmd));
      videoStore.add(record);
      // Loom Apollo state often carries the auto-generated transcript;
      // surface it through videoStore.setTranscript so the artifact API
      // writes it to Drive (transcript.md) just like Fireflies/Zoom imports.
      if (item.transcriptText) {
        videoStore.setTranscript(record.id(), item.transcriptText);
      }
      // ADR-071 §3 — kick the Drive ingest for rows that resolved
      // publicly. Fire-and-forget: the client can poll
      // /api/drive/status later if it wants a progress bar. Pending-
      // curator rows are left for /maintain to trigger.
      if (item.platform === "google-drive" && !item.drivePendingCurator && item.driveIngestAuth) {
        void fetch("/api/drive/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file_id: item.id,
            record_id: record.id(),
            auth: item.driveIngestAuth,
          }),
        }).catch(() => { /* swallow; a re-trigger from /maintain is available */ });
      }
      const transcriptNote = item.transcriptText ? ", transcript included" : "";
      const platformLabel =
        item.platform === "youtube"      ? "YouTube"
      : item.platform === "loom"          ? "Loom"
      : item.platform === "zoom-share"    ? "Zoom share"
      : item.platform === "google-drive"  ? (item.drivePendingCurator ? "Drive (pending curator)" : "Google Drive")
      : item.platform;
      onEvent(`VideoIndexed: "${item.title}" (${platformLabel} import${transcriptNote})`);
      createdIds.push(record.id());
      count++;
    }
    if (count > 0) {
      onImported({ ids: createdIds });
      setInput("");
      setItems([]);
      setSelected(new Set());
      setTosAccepted(false);
    }
  }

  const readyCount = items.filter(i => selected.has(i.id) && !i.fetchError).length;

  return (
    <div className="zoom-import">
      <div className="zoom-import-header">
        <h2>Import from URL</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end", flex: 1 }}>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={fetchAll}
            disabled={loading || !input.trim()}
          >
            {loading ? "Fetching…" : "Fetch"}
          </button>
        </div>
      </div>

      <HelpTip>
        Paste one or more URLs — YouTube, Loom, a public Zoom share (<code>zoom.us/rec/share/…</code>), or a Google Drive file (<code>drive.google.com/file/d/…</code>) — one per line. Supports{" "}
        <code>youtube.com/watch</code>, <code>youtube.com/live</code>, <code>youtu.be</code>,
        <code>loom.com/share</code>. Drive files must be shared publicly (or with the org runtime service account); private files land in a curator queue. Metadata is fetched automatically — review the
        previews, then import selected.
      </HelpTip>

      <label htmlFor="url-import-input" className="visually-hidden">Video URLs to import</label>
      <textarea
        id="url-import-input"
        value={input}
        onChange={e => { setInput(e.target.value); setItems([]); setGlobalError(null); }}
        onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) fetchAll(); }}
        placeholder={"https://www.youtube.com/live/jcipFgphFfI\nhttps://www.loom.com/share/abc123\nhttps://us06web.zoom.us/rec/share/…\nhttps://drive.google.com/file/d/…"}
        rows={3}
        aria-describedby="url-import-help"
        aria-invalid={!!globalError}
        style={{
          width: "100%",
          marginTop: 8,
          padding: "6px 8px",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          color: "var(--text)",
          fontSize: "0.8rem",
          fontFamily: "monospace",
          resize: "vertical",
          boxSizing: "border-box",
        }}
      />
      <span id="url-import-help" style={{ display: "block", marginTop: 4, fontSize: "0.72rem", color: "var(--text-muted)" }}>
        One URL per line. Press Ctrl+Enter or ⌘+Enter to fetch.
      </span>

      {globalError && <div className="zoom-import-error" role="alert">{globalError}</div>}

      {items.length > 0 && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map(item => (
            <div key={item.id} style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", opacity: item.fetchError ? 0.5 : 1 }}>
              <label style={{ display: "flex", gap: 10, padding: 10, cursor: item.fetchError ? "default" : "pointer", alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={selected.has(item.id) && !item.fetchError}
                  disabled={!!item.fetchError}
                  onChange={() => toggleSelect(item.id)}
                  style={{ marginTop: 2, flexShrink: 0 }}
                />
                {item.thumbnailUrl && (
                  <img src={item.thumbnailUrl} alt="" style={{ width: 100, height: 56, objectFit: "cover", borderRadius: 4, flexShrink: 0 }} />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {item.fetchError ? (
                    <div style={{ fontSize: "0.8rem", color: "var(--red)" }} role="alert">{item.fetchError}</div>
                  ) : (
                    <>
                      <div style={{ fontWeight: 600, fontSize: "0.85rem", lineHeight: 1.3 }}>{item.title}</div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 2, display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ textTransform: "capitalize", color: item.platform === "youtube" ? "#ff4444" : "#6366f1" }}>
                          {item.platform === "google-drive" ? "Google Drive" : item.platform}
                        </span>
                        {item.channelOrAuthor && <span>{item.channelOrAuthor}</span>}
                        {item.durationSeconds > 0 && <span>{fmt(item.durationSeconds)}</span>}
                        {item.drivePendingCurator && (
                          <span
                            style={{
                              padding: "1px 6px", borderRadius: 4, fontSize: "0.65rem",
                              background: "var(--warning-soft, rgba(234,179,8,0.16))", color: "var(--yellow)",
                              border: "1px solid var(--warning-border, rgba(234,179,8,0.3))",
                            }}
                            title="This Drive file is not publicly readable. A curator with org Drive access will pull it from /maintain."
                          >
                            pending curator pull
                          </span>
                        )}
                      </div>
                    </>
                  )}
                  <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.raw}</div>
                </div>
              </label>
            </div>
          ))}

          {needsTosCheck && (
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: "0.78rem", color: "var(--text-muted)", cursor: "pointer", padding: "4px 2px" }}>
              <input type="checkbox" checked={tosAccepted} onChange={e => setTosAccepted(e.target.checked)} style={{ marginTop: 2, flexShrink: 0 }} />
              I confirm I have the rights to download and republish the selected YouTube video(s),
              in compliance with YouTube&apos;s Terms of Service and applicable copyright law.
            </label>
          )}

          {readyCount > 0 && (
            <button
              className="btn btn-primary"
              onClick={importSelected}
              disabled={needsTosCheck && !tosAccepted}
            >
              Import {readyCount} video{readyCount !== 1 ? "s" : ""}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
