"use client";

import { useState, useMemo } from "react";
import { videoStore } from "../lib/store";
import { WasmVideoRecord } from "../lib/wasm";
import type { VideoRecordJSON } from "../lib/wasm";
import { useCurrentActor, actorCommand } from "../lib/useCurrentActor";
import { findOrphanClips, repairOneOrphanClip } from "../lib/orphanClipsRepair";

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
  const publishingRows = shorts.filter((v) => v.status === "Publishing");
  // Published — most-recent first, so a fresh upload lands at the
  // top of its section and the operator sees it acknowledged.
  const published = shorts
    .filter((v) => v.status === "Published")
    .sort((a, b) =>
      new Date(b.published_at ?? b.indexed_at).getTime() -
      new Date(a.published_at ?? a.indexed_at).getTime(),
    );
  const failed = shorts.filter((v) => v.status === "Failed" || v.status === "ToRetry");
  const rejected = shorts.filter((v) => v.status === "Abandoned");

  // Look up parent title (and YouTube ID) for every clip so the row
  // can show "clipped from …". Parents may be Zoom, YouTube, etc.
  const parentByClipId = useMemo(() => {
    const byId = new Map<string, VideoRecordJSON>();
    for (const v of videos) byId.set(v.id, v);
    const out = new Map<string, VideoRecordJSON>();
    for (const c of shorts) {
      const link = (c.upstream_links ?? []).find(l => l.relation === "ClipOf" && l.video_id);
      const pid = link?.video_id
        ?? (c.metadata_extra as { parent_video_id?: string } | null)?.parent_video_id
        ?? null;
      const p = pid ? byId.get(pid) : undefined;
      if (p) out.set(c.id, p);
    }
    return out;
  }, [videos, shorts]);

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

    // Build description with provenance footer (ADR-022 + ADR-029 §6).
    // The URL sits on its own line at the very top with a leading
    // blank line — YouTube's auto-linkifier is happier with a URL
    // preceded by whitespace than one wrapped in emoji + text on the
    // same line, and the operator wants viewers to be able to tap
    // through to the full recording.
    const parentBlock = parentYtId
      ? `▶ Watch the full recording:\nhttps://youtu.be/${parentYtId}\n\n`
      : "";
    const footerParts = [
      `catalog:${clip.id}`,
      `source:OpusClip:${clip.source_id}`,
      clip.metadata_extra?.parent_source_id ? `parent:${clip.metadata_extra.parent_source_id}` : null,
    ].filter(Boolean);
    const provenanceFooter = `\n\n---\nvideo-sync | ${footerParts.join(" | ")}`;
    const description = `${parentBlock}${provenanceFooter}`.slice(0, 5000);

    // #Shorts on title triggers YouTube's Shorts shelf (ADR-029 §7).
    const shortTitle = clip.title.includes("#Shorts") ? clip.title : `${clip.title} #Shorts`;

    setPublishing(clip.id);
    try {
      // Move to Publishing state
      videoStore.mutate(clip.id, (r) =>
        r.request_publish(cmd())
      );
      onMutated();

      // NB: no trimStartSeconds — Opus already exported a trimmed
      // mp4. The upload route's trim trims the CLIP file, not the
      // parent; setting it here would truncate the short.
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

      const res = await fetch("/api/youtube/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        let errMsg = `Upload failed (${res.status})`;
        try { const d = await res.json(); errMsg = d.error ?? errMsg; } catch { /* ignore */ }
        throw new Error(errMsg);
      }
      if (!res.body) throw new Error("No response stream from upload endpoint");

      // /api/youtube/upload streams SSE (event: progress | complete | error).
      // Read the frames — the JSON-parse path used to error on the first
      // "event: progress" line and mark the record Failed even though the
      // upload was completing successfully upstream.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventType = "";
      let result: { videoId: string; videoUrl: string } | null = null;
      let lastPhase = "(none)";
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const payload = JSON.parse(line.slice(6)) as Record<string, string>;
            if (eventType === "progress" && payload.phase) {
              lastPhase = payload.phase;
            } else if (eventType === "complete") {
              result = { videoId: payload.videoId, videoUrl: payload.videoUrl };
              break outer;
            } else if (eventType === "error") {
              throw new Error(payload.message ?? "Upload failed");
            }
            eventType = "";
          }
        }
      }
      if (!result) throw new Error(`Upload stream ended without complete event (last phase: ${lastPhase})`);

      // Record YouTube destination location + mark Published
      videoStore.mutate(clip.id, (r) => {
        r.add_location(cmd({ platform: "YouTube",
          external_id: result!.videoId,
          external_url: result!.videoUrl,
          role: "Destination", }));
        return r.mark_published(cmd());
      });

      onEvent(`ShortPublished: "${clip.title}" → YouTube/${result.videoId}`, { video_id: clip.id });
      onMutated();

      // ADR-029 CTA autopost — best-effort. YouTube Data API v3
      // can insert a top-level comment as the channel owner, which
      // gets an ❤️ author badge and typically bubbles to the top.
      // The API does NOT expose pinning, so if the operator wants
      // it locked at position 1 they pin manually in Studio.
      if (parentYtId) {
        const ctaText = `▶ Watch the full recording: https://youtu.be/${parentYtId}`;
        try {
          const cRes = await fetch("/api/youtube/post-comment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              videoId: result.videoId,
              text: ctaText,
              refreshToken: ytCreds.refreshToken,
              clientId: ytCreds.clientId,
              clientSecret: ytCreds.clientSecret,
            }),
          });
          if (cRes.ok) {
            onEvent(`ShortCtaCommentPosted: "${clip.title}" — pin it in YouTube Studio to lock at top`, { video_id: clip.id });
          } else {
            const cData = await cRes.json().catch(() => ({} as { error?: string; missingScope?: boolean }));
            onEvent(`ShortCtaCommentSkipped: "${clip.title}" — ${cData.error ?? `HTTP ${cRes.status}`}`, { video_id: clip.id });
          }
        } catch (err) {
          onEvent(`ShortCtaCommentSkipped: "${clip.title}" — ${err instanceof Error ? err.message : String(err)}`, { video_id: clip.id });
        }
      }
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
    const opusEditUrl = extra.opus_edit_url as string | undefined;
    const duration = start !== undefined && end !== undefined ? formatDuration(start, end) : "";
    // ADR-058 follow-up — orphan clip = OpusClip source row without
    // a ClipOf upstream link. Surface a one-click repair here so the
    // operator can fix a single case without running the bulk
    // Maintain card.
    const hasClipOfLink = (clip.upstream_links ?? []).some(l => l.relation === "ClipOf");
    const hasParentPointer = !!extra.parent_video_id || !!extra.parent_source_id;
    const isOrphan = !hasClipOfLink && hasParentPointer;

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

        {/* Title + duration + parent */}
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontSize: "0.85rem", fontWeight: 500 }}>{clip.title}</div>
          {parentByClipId.get(clip.id) && (
            <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 1 }}>
              from <span style={{ color: "var(--text)" }}>{parentByClipId.get(clip.id)!.title}</span>
            </div>
          )}
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
            {opusEditUrl && (
              <a
                href={opusEditUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open this clip in the Opus Clip editor"
                style={{ color: "#a78bfa", textDecoration: "none" }}
              >
                ✂ edit in Opus
              </a>
            )}
            {isOrphan && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const orphans = findOrphanClips(videoStore.getAll());
                  const mine = orphans.find(o => o.clip.id === clip.id);
                  if (!mine) return;
                  const result = repairOneOrphanClip(mine, actorState);
                  if (result.ok) {
                    onEvent(`ShortsLinkRepaired: "${clip.title}" → parent ${mine.parent.id.slice(0, 8)}`, { video_id: clip.id });
                    onMutated();
                  } else {
                    onEvent(`ShortsLinkRepairFailed: "${clip.title}" — ${result.error}`, { video_id: clip.id });
                  }
                }}
                title="This clip is missing a ClipOf link to its parent — click to write it from metadata_extra breadcrumbs (ADR-058 repair)"
                style={{
                  fontSize: "0.7rem", padding: "0 6px", borderRadius: 4,
                  background: "rgba(20,184,166,0.12)", color: "#5eead4",
                  border: "1px solid rgba(20,184,166,0.28)", fontWeight: 600, cursor: "pointer",
                }}
              >
                🔗 repair link
              </button>
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

        {/* Currently uploading — keeps the row visible with a phase
            hint instead of the previous "vanishes without a trace"
            behaviour. */}
        {publishingRows.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Publishing ({publishingRows.length})
            </div>
            {publishingRows.map((clip) => renderClipRow(clip, <span style={{ fontSize: "0.72rem", color: "#a78bfa" }}>uploading…</span>))}
          </div>
        )}

        {/* Published — visible confirmation that a clip landed on
            YouTube, with a direct link to the live short. */}
        {published.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--green)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Published ({published.length})
            </div>
            {published.map((clip) => {
              const ytLoc = (clip.locations ?? []).find(l => l.platform === "YouTube" && l.role === "Destination");
              const publishedAt = clip.published_at
                ? new Date(clip.published_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                : null;
              return renderClipRow(
                clip,
                <>
                  {publishedAt && <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{publishedAt}</span>}
                  {ytLoc?.external_url && (
                    <a
                      href={ytLoc.external_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-sm"
                      style={{ background: "var(--green)", borderColor: "var(--green)", color: "#000", textDecoration: "none" }}
                    >
                      ▶ Watch on YouTube
                    </a>
                  )}
                </>,
              );
            })}
          </div>
        )}

        {/* Upload failed — retry action lives here rather than in
            the review queue, so the operator knows *which* stage
            broke. */}
        {failed.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--red)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Publish failed ({failed.length})
            </div>
            {failed.map((clip) => renderClipRow(
              clip,
              <button
                className="btn btn-sm btn-primary"
                onClick={() => publishShort(clip)}
                disabled={publishing === clip.id}
                title="Retry the YouTube upload for this clip"
              >
                {publishing === clip.id ? "Publishing…" : "Retry publish"}
              </button>,
            ))}
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
    opusClipId?: string | null;
    opusEditUrl?: string | null;
    keywords?: string[];
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
    if (clip.opusClipId) {
      metadataExtra.opus_clip_id = clip.opusClipId;
    }
    if (clip.opusEditUrl) {
      // Deep-link to Opus's single-clip editor. Rendered as an "Edit
      // in Opus" link on the clip card in ShortsPanel.
      metadataExtra.opus_edit_url = clip.opusEditUrl;
    }
    if (clip.keywords && clip.keywords.length > 0) {
      // Persist so the collapsible clips list on the parent VideoCard
      // has content to show without re-hitting Opus.
      metadataExtra.keywords = clip.keywords;
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
