"use client";

import { useState } from "react";
import { WasmVideoRecord } from "../lib/wasm";
import { videoStore } from "../lib/store";
import type { YouTubeVideoInfo } from "../app/api/youtube/video-info/route";
import HelpTip from "./HelpTip";

/** Parse a YouTube video ID from any common URL format. */
function parseYouTubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  // Plain 11-char ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  // youtu.be/VIDEO_ID
  let match = trimmed.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (match) return match[1];
  // youtube.com/watch?v=VIDEO_ID
  match = trimmed.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (match) return match[1];
  // youtube.com/live/VIDEO_ID  or  /embed/VIDEO_ID
  match = trimmed.match(/youtube\.com\/(?:live|embed)\/([a-zA-Z0-9_-]{11})/);
  if (match) return match[1];
  return null;
}

function fmtDuration(seconds: number): string {
  if (!seconds) return "unknown duration";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface Props {
  onImported: () => void;
  onEvent: (event: string, fields?: { video_id?: string }) => void;
}

export default function YouTubeImport({ onImported, onEvent }: Props) {
  const [urlInput, setUrlInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<YouTubeVideoInfo | null>(null);
  const [tosAccepted, setTosAccepted] = useState(false);

  async function fetchPreview(input: string) {
    const videoId = parseYouTubeVideoId(input);
    if (!videoId) {
      setError("Could not parse a YouTube video ID from that URL.");
      setPreview(null);
      return;
    }

    // Deduplication check before making an API call
    const existingId = `youtube-${videoId}`;
    const all = videoStore.getAll();
    if (all.some((v) => v.source_id === existingId)) {
      setError("This video is already in the catalogue.");
      setPreview(null);
      return;
    }

    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const res = await fetch(`/api/youtube/video-info?videoId=${encodeURIComponent(videoId)}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Request failed (${res.status})`);
        return;
      }
      setPreview(data as YouTubeVideoInfo);
      setTosAccepted(false);
    } catch (err) {
      setError(`Network error: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  function handleUrlChange(value: string) {
    setUrlInput(value);
    setPreview(null);
    setError(null);
    setTosAccepted(false);
  }

  function importVideo() {
    if (!preview || !tosAccepted) return;

    const sourceId = `youtube-${preview.videoId}`;
    const all = videoStore.getAll();
    if (all.some((v) => v.source_id === sourceId)) {
      setError("This video is already in the catalogue.");
      return;
    }

    const cmd: Record<string, unknown> = {
      source_id: sourceId,
      source_platform: "YouTube",
      title: preview.title,
      description: preview.description || undefined,
      duration_seconds: preview.durationSeconds,
      participants: [],
      download_url: `youtube://${preview.videoId}`,
      thumbnail_url: preview.thumbnailUrl || undefined,
      tags: ["youtube-import"],
      recorded_at: preview.publishedAt,
      metadata_extra: {
        channel: preview.channelTitle,
        privacy_status: preview.privacyStatus,
        live_broadcast_content: preview.liveBroadcastContent,
        youtube_url: `https://www.youtube.com/watch?v=${preview.videoId}`,
      },
    };

    const record = new WasmVideoRecord(JSON.stringify(cmd));
    videoStore.add(record);
    onEvent(`VideoIndexed: "${preview.title}" (YouTube import)`);
    onImported();

    // Reset
    setUrlInput("");
    setPreview(null);
    setTosAccepted(false);
    setError(null);
  }

  return (
    <div className="zoom-import">
      <div className="zoom-import-header">
        <h2>YouTube Import</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}>
          <input
            type="text"
            placeholder="Paste YouTube URL or video ID…"
            value={urlInput}
            onChange={(e) => handleUrlChange(e.target.value)}
            onBlur={() => urlInput && fetchPreview(urlInput)}
            onKeyDown={(e) => e.key === "Enter" && urlInput && fetchPreview(urlInput)}
            style={{
              flex: 1,
              padding: "4px 8px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              fontSize: "0.8rem",
            }}
          />
          <button
            className="btn btn-sm btn-primary"
            onClick={() => fetchPreview(urlInput)}
            disabled={loading || !urlInput.trim()}
          >
            {loading ? "Fetching…" : "Fetch"}
          </button>
        </div>
      </div>

      <HelpTip>
        Import a video already hosted on YouTube by pasting its URL. Supports{" "}
        <code>youtube.com/watch</code>, <code>youtube.com/live</code>, <code>youtu.be</code>, and{" "}
        <code>youtube.com/embed</code> formats. The video will be downloaded via{" "}
        <strong>yt-dlp</strong> at publish time — ensure you have the rights to reproduce the
        content before importing.
      </HelpTip>

      {error && <div className="zoom-import-error">{error}</div>}

      {preview && (
        <div style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
          {/* Thumbnail + metadata */}
          <div style={{ display: "flex", gap: 12, padding: 12 }}>
            {preview.thumbnailUrl && (
              <img
                src={preview.thumbnailUrl}
                alt="thumbnail"
                style={{ width: 140, height: 79, objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
              />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: 4, lineHeight: 1.3 }}>
                {preview.title}
              </div>
              <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: 2 }}>
                {preview.channelTitle}
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", display: "flex", gap: 10, flexWrap: "wrap" }}>
                <span>{fmtDuration(preview.durationSeconds)}</span>
                <span>{new Date(preview.publishedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</span>
                {preview.liveBroadcastContent !== "none" && (
                  <span style={{ color: "var(--red)" }}>● Live replay</span>
                )}
                <span style={{ color: preview.privacyStatus === "public" ? "var(--green)" : "var(--yellow)" }}>
                  {preview.privacyStatus}
                </span>
              </div>
              <div style={{ marginTop: 6 }}>
                <a
                  href={`https://www.youtube.com/watch?v=${preview.videoId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: "0.72rem", color: "var(--text-muted)", textDecoration: "underline" }}
                >
                  youtube.com/watch?v={preview.videoId}
                </a>
              </div>
            </div>
          </div>

          {/* ToS acknowledgement */}
          <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", background: "var(--bg-secondary, var(--bg))" }}>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer", fontSize: "0.78rem", color: "var(--text-muted)" }}>
              <input
                type="checkbox"
                checked={tosAccepted}
                onChange={(e) => setTosAccepted(e.target.checked)}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              I confirm I have the rights to download and republish this video, and that doing so
              complies with YouTube&apos;s Terms of Service and applicable copyright law.
            </label>
          </div>

          {/* Import button */}
          <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
            <button
              className="btn btn-primary"
              onClick={importVideo}
              disabled={!tosAccepted}
            >
              Import to catalogue
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
