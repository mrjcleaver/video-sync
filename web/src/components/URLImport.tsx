"use client";

import { useState } from "react";
import { WasmVideoRecord } from "../lib/wasm";
import { videoStore } from "../lib/store";
import type { YouTubeVideoInfo } from "../app/api/youtube/video-info/route";
import type { LoomMetadata } from "../app/api/loom/metadata/route";
import HelpTip from "./HelpTip";

type Platform = "youtube" | "loom" | "unknown";

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

interface Props {
  onImported: () => void;
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
          return { raw: line, platform: "unknown", id: line, title: line, description: null, thumbnailUrl: null, durationSeconds: 0, channelOrAuthor: "", publishedAt: "", needsTos: false, extra: {}, fetchError: "Unrecognised URL. Expected YouTube or Loom." };
        }
        const sourceId = `${platform}-${id}`;
        const alreadyIn = videoStore.getAll().some(v => v.source_id === sourceId);
        if (alreadyIn) {
          return { raw, platform, id, title: "", description: null, thumbnailUrl: null, durationSeconds: 0, channelOrAuthor: "", publishedAt: "", needsTos: false, extra: {}, fetchError: "Already in catalogue" };
        }
        try {
          return platform === "youtube" ? await fetchYouTube(id) : await fetchLoom(id, raw);
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
    for (const item of items) {
      if (!selected.has(item.id) || item.fetchError) continue;
      const cmd: Record<string, unknown> = {
        source_id: `${item.platform}-${item.id}`,
        source_platform: item.platform === "youtube" ? "YouTube" : "Loom",
        title: item.title,
        description: item.description || undefined,
        // Loom's oEmbed returns fractional seconds (e.g. 7495.15) but the
        // WASM record's duration_seconds is u32. Round to nearest integer.
        duration_seconds: Math.max(0, Math.round(Number(item.durationSeconds) || 0)),
        participants: item.participants ?? [],
        download_url: item.platform === "youtube" ? `youtube://${item.id}` : item.raw,
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
      const transcriptNote = item.transcriptText ? ", transcript included" : "";
      onEvent(`VideoIndexed: "${item.title}" (${item.platform === "youtube" ? "YouTube" : "Loom"} import${transcriptNote})`);
      count++;
    }
    if (count > 0) {
      onImported();
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
        Paste one or more YouTube or Loom URLs, one per line. Supports{" "}
        <code>youtube.com/watch</code>, <code>youtube.com/live</code>, <code>youtu.be</code>,
        and <code>loom.com/share</code>. Metadata is fetched automatically. Review the
        previews, then import selected.
      </HelpTip>

      <div className="form-field url-import-field">
        <label htmlFor="url-import-input">Video URLs</label>
        <textarea
          id="url-import-input"
          value={input}
          onChange={e => { setInput(e.target.value); setItems([]); setGlobalError(null); }}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) fetchAll(); }}
          placeholder={"https://www.youtube.com/live/jcipFgphFfI\nhttps://www.loom.com/share/abc123"}
          rows={4}
          aria-describedby="url-import-help"
          aria-invalid={!!globalError}
        />
        <span id="url-import-help" className="field-help">
          One URL per line. Press Ctrl+Enter or Command+Enter to fetch.
        </span>
      </div>

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
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 2, display: "flex", gap: 8 }}>
                        <span style={{ textTransform: "capitalize", color: item.platform === "youtube" ? "#ff4444" : "#6366f1" }}>
                          {item.platform}
                        </span>
                        {item.channelOrAuthor && <span>{item.channelOrAuthor}</span>}
                        {item.durationSeconds > 0 && <span>{fmt(item.durationSeconds)}</span>}
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
