"use client";

import { useState, useMemo } from "react";
import { videoStore } from "../lib/store";
import { WasmVideoRecord } from "../lib/wasm";
import type { VideoRecordJSON } from "../lib/wasm";
import { useCurrentActor, actorCommand } from "../lib/useCurrentActor";

interface Props {
  videos: VideoRecordJSON[];
  onMutated: () => void;
  onEvent: (event: string, fields?: { video_id?: string }) => void;
}

function formatScore(score: number): string {
  return score > 0 ? `${Math.round(score)}` : "—";
}

function formatDuration(start: number, end: number): string {
  const secs = Math.round(end - start);
  if (secs <= 0) return "";
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
}

export default function ShortsPanel({ videos, onMutated, onEvent }: Props) {
  const actorState = useCurrentActor();
  const cmd = (extra?: Record<string, unknown>) => actorCommand(actorState, extra);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<Record<string, string>>({});

  const shorts = useMemo(
    () => videos.filter((v) => v.source_platform === "OpusClip"),
    [videos],
  );

  const pending = shorts.filter((v) => v.status === "Discovered" || v.status === "InScope");
  const approved = shorts.filter((v) => v.status === "Approved");
  const rejected = shorts.filter((v) => v.status === "Abandoned");

  if (shorts.length === 0) return null;

  function approveclip(clip: VideoRecordJSON) {
    videoStore.mutate(clip.id, (r) =>
      r.approve(cmd())
    );
    onEvent(`ShortApproved: "${clip.title}"`);
    onMutated();
  }

  function rejectClip(clip: VideoRecordJSON) {
    videoStore.mutate(clip.id, (r) =>
      r.abandon(cmd())
    );
    onEvent(`ShortRejected: "${clip.title}"`);
    onMutated();
  }

  async function publishShort(clip: VideoRecordJSON) {
    setPublishError((prev) => ({ ...prev, [clip.id]: "" }));

    let connections: Record<string, { credentials?: Record<string, string> }> = {};
    try {
      const raw = localStorage.getItem("video-sync:connections");
      if (raw) connections = JSON.parse(raw);
    } catch { /* ignore */ }

    const ytCreds = connections["YouTube"]?.credentials;
    if (!ytCreds?.refreshToken || !ytCreds?.clientId || !ytCreds?.clientSecret) {
      setPublishError((prev) => ({ ...prev, [clip.id]: "YouTube not authorized" }));
      return;
    }

    const extra = clip.metadata_extra ?? {};
    const parentYtId = extra.parent_youtube_id as string | undefined;
    const startSecs = extra.clip_start_seconds as number | undefined;

    // Build description with provenance footer (ADR-022)
    const parentLink = parentYtId
      ? `📹 Full recording: https://www.youtube.com/watch?v=${parentYtId}`
      : "";
    const footerParts = [
      `catalog:${clip.id}`,
      `source:OpusClip:${clip.source_id}`,
      clip.metadata_extra?.parent_source_id ? `parent:${clip.metadata_extra.parent_source_id}` : null,
    ].filter(Boolean);
    const provenanceFooter = `\n\n---\nvideo-sync | ${footerParts.join(" | ")}`;
    const description = `${parentLink}${provenanceFooter}`.slice(0, 5000);

    // Append #Shorts to title to trigger YouTube Shorts shelf
    const shortTitle = clip.title.includes("#Shorts") ? clip.title : `${clip.title} #Shorts`;

    setPublishing(clip.id);
    try {
      // Move to Publishing state
      videoStore.mutate(clip.id, (r) =>
        r.request_publish(cmd())
      );
      onMutated();

      const body: Record<string, unknown> = {
        refreshToken: ytCreds.refreshToken,
        clientId: ytCreds.clientId,
        clientSecret: ytCreds.clientSecret,
        title: shortTitle,
        description,
        tags: [...(clip.tags ?? []), "Shorts"],
        downloadUrl: clip.download_url,
        privacyStatus: "public",
      };

      if (startSecs && startSecs > 0) body.trimStartSeconds = startSecs;

      const res = await fetch("/api/youtube/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json() as { videoId?: string; videoUrl?: string; error?: string };

      if (!res.ok) {
        throw new Error(data.error ?? `Upload failed (${res.status})`);
      }

      // Record YouTube destination location
      videoStore.mutate(clip.id, (r) => {
        r.add_location(cmd({ platform: "YouTube",
          external_id: data.videoId ?? "",
          external_url: data.videoUrl ?? null,
          role: "Destination", }));
        return r.mark_published(cmd());
      });

      onEvent(`ShortPublished: "${clip.title}" → YouTube/${data.videoId}`);
      onMutated();
    } catch (err) {
      videoStore.mutate(clip.id, (r) =>
        r.mark_failed(JSON.stringify({ error_message: String(err) }))
      );
      setPublishError((prev) => ({ ...prev, [clip.id]: String(err) }));
      onMutated();
    } finally {
      setPublishing(null);
    }
  }

  function renderClipRow(clip: VideoRecordJSON, actions: React.ReactNode) {
    const extra = clip.metadata_extra ?? {};
    const score = extra.virality_score as number | undefined;
    const start = extra.clip_start_seconds as number | undefined;
    const end = extra.clip_end_seconds as number | undefined;
    const parentYtId = extra.parent_youtube_id as string | undefined;
    const duration = start !== undefined && end !== undefined ? formatDuration(start, end) : "";

    return (
      <div
        key={clip.id}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 0",
          borderBottom: "1px solid var(--border)",
          flexWrap: "wrap",
        }}
      >
        {/* Virality score badge */}
        <span
          title="Virality score (Opus Clip)"
          style={{
            minWidth: 36,
            textAlign: "center",
            fontWeight: 700,
            fontSize: "0.8rem",
            color: score && score >= 70 ? "var(--green)" : score && score >= 40 ? "#f5a623" : "var(--text-muted)",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "1px 5px",
          }}
        >
          {formatScore(score ?? 0)}
        </span>

        {/* Title + duration */}
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontSize: "0.85rem", fontWeight: 500 }}>{clip.title}</div>
          <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", display: "flex", gap: 8, flexWrap: "wrap" }}>
            {duration && <span>{duration}</span>}
            {parentYtId && (
              <a
                href={`https://www.youtube.com/watch?v=${parentYtId}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "#e00", textDecoration: "none" }}
              >
                ▶ source
              </a>
            )}
            {clip.download_url.startsWith("http") && (
              <a
                href={clip.download_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--text-muted)", textDecoration: "none" }}
              >
                preview
              </a>
            )}
          </div>
        </div>

        {/* Status badge */}
        <span className={`status-badge status-${clip.status}`} style={{ fontSize: "0.7rem" }}>
          {clip.status}
        </span>

        {/* Actions */}
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {actions}
          {publishError[clip.id] && (
            <span style={{ fontSize: "0.7rem", color: "var(--red)" }}>{publishError[clip.id]}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 24 }}>
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "16px 20px",
        }}
      >
        <h2 style={{ margin: "0 0 4px 0", fontSize: "1rem" }}>
          Shorts Review Queue
          {pending.length > 0 && (
            <span
              style={{
                marginLeft: 8,
                background: "#f5a623",
                color: "#000",
                borderRadius: 10,
                padding: "1px 8px",
                fontSize: "0.75rem",
                fontWeight: 700,
              }}
            >
              {pending.length} pending
            </span>
          )}
        </h2>
        <p style={{ margin: "0 0 12px 0", fontSize: "0.8rem", color: "var(--text-muted)" }}>
          AI-generated short clips from Opus Clip. Review and approve before publishing to YouTube Shorts.
        </p>

        {/* Pending clips */}
        {pending.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Pending Review ({pending.length})
            </div>
            {pending.map((clip) =>
              renderClipRow(
                clip,
                <>
                  <button className="btn btn-sm btn-green" onClick={() => approveclip(clip)}>
                    Approve
                  </button>
                  <button className="btn btn-sm btn-red" onClick={() => rejectClip(clip)}>
                    Reject
                  </button>
                </>,
              )
            )}
          </div>
        )}

        {/* Approved clips (awaiting publish) */}
        {approved.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Approved — Ready to Publish ({approved.length})
            </div>
            {approved.map((clip) =>
              renderClipRow(
                clip,
                <>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => publishShort(clip)}
                    disabled={publishing === clip.id}
                  >
                    {publishing === clip.id ? "Publishing…" : "Publish to YouTube"}
                  </button>
                  <button className="btn btn-sm btn-red" onClick={() => rejectClip(clip)}>
                    Reject
                  </button>
                </>,
              )
            )}
          </div>
        )}

        {/* Rejected clips (collapsed) */}
        {rejected.length > 0 && (
          <details style={{ marginTop: 8 }}>
            <summary style={{ fontSize: "0.75rem", color: "var(--text-muted)", cursor: "pointer" }}>
              Rejected ({rejected.length})
            </summary>
            <div style={{ marginTop: 8 }}>
              {rejected.map((clip) => renderClipRow(clip, null))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

/** Index a set of Opus Clip results as VideoRecord child entries in the store. */
export function indexShortClips(params: {
  parentVideoId: string;
  parentSourceId: string;
  parentYouTubeId: string | null;
  jobId: string;
  clips: Array<{
    index: number;
    title: string;
    viralityScore: number;
    startSeconds: number;
    endSeconds: number;
    clipUrl: string;
    thumbnailUrl: string | null;
  }>;
  /** Present when called from a react component with actor context.
   *  When set, each clip gets a `ClipOf` upstream_link to the parent
   *  so the provenance graph knows the relationship — not just
   *  metadata_extra breadcrumbs. */
  actorState?: Parameters<typeof actorCommand>[0];
}): number {
  const { parentVideoId, parentSourceId, parentYouTubeId, jobId, clips, actorState } = params;
  let indexed = 0;

  // Look up the parent for its recorded_at + source_platform. Clips
  // are derivatives of the parent's event — sort them onto the same
  // date, not "now" (which was the previous behaviour and put them
  // in the wrong day when reviewed later).
  const parent = videoStore.getAll().find((v) => v.id === parentVideoId);
  const parentRecordedAt = parent?.recorded_at ?? parent?.indexed_at ?? new Date().toISOString();
  const parentSourcePlatform = parent?.source_platform ?? "YouTube";

  for (const clip of clips) {
    const sourceId = `shorts-${jobId}-${clip.index}`;

    // Skip if already indexed
    const existing = videoStore.getAll().find((v) => v.source_id === sourceId);
    if (existing) continue;

    const metadataExtra: Record<string, unknown> = {
      opus_clip_job_id: jobId,
      parent_source_id: parentSourceId,
      parent_video_id: parentVideoId,
      clip_start_seconds: clip.startSeconds,
      clip_end_seconds: clip.endSeconds,
      virality_score: clip.viralityScore,
    };
    if (parentYouTubeId) {
      metadataExtra.parent_youtube_id = parentYouTubeId;
    }

    const record = new WasmVideoRecord(
      JSON.stringify({
        source_id: sourceId,
        source_platform: "OpusClip",
        title: clip.title,
        description: parentYouTubeId
          ? `📹 Full recording: https://www.youtube.com/watch?v=${parentYouTubeId}`
          : null,
        duration_seconds: Math.max(0, clip.endSeconds - clip.startSeconds),
        participants: [],
        download_url: clip.clipUrl,
        thumbnail_url: clip.thumbnailUrl ?? undefined,
        tags: ["short", "opus-clip"],
        metadata_extra: metadataExtra,
        recorded_at: parentRecordedAt,
      }),
    );

    videoStore.add(record);

    // ADR-019 provenance graph — encode the clip→parent relationship
    // as a first-class ClipOf upstream_link so the provenance graph,
    // dashboard groupings, and any future collapse UI can find it
    // structurally (not just via metadata_extra breadcrumbs).
    if (actorState) {
      try {
        videoStore.mutate(record.id(), (r) =>
          r.link_upstream(actorCommand(actorState, {
            platform: parentSourcePlatform,
            external_id: parentSourceId,
            video_id: parentVideoId,
            relation: "ClipOf",
            linked_by: "Auto",
          })),
        );
      } catch {
        // Non-fatal — clip is still in catalog. The metadata_extra
        // breadcrumbs (parent_video_id etc.) still identify the
        // relationship. A future Catch-Up pass could reconstruct
        // the missing link.
      }
    }

    indexed++;
  }

  return indexed;
}
