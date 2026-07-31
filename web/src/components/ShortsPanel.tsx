"use client";

import { useState, useMemo, useEffect } from "react";
import { videoStore } from "../lib/store";
import { WasmVideoRecord } from "../lib/wasm";
import type { VideoRecordJSON } from "../lib/wasm";
import { useCurrentActor, actorCommand } from "../lib/useCurrentActor";
import { findOrphanClips, repairOneOrphanClip } from "../lib/orphanClipsRepair";
import { approveShort, rejectShort, publishShort as publishShortLib } from "../lib/shortsPublish";
import { refreshShortsFromOpus, refreshOneShortFromOpus } from "../lib/shortsRefresh";

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
  const [publishing, setPublishing] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<Record<string, string>>({});
  // Toggle-open inline players so the operator can watch a clip
  // straight from the queue without a round-trip to opus.pro. One
  // player mounted per open clip; collapsed players don't keep the
  // <video> element in memory.
  const [openPlayer, setOpenPlayer] = useState<Record<string, boolean>>({});

  const shorts = useMemo(
    () => videos.filter((v) => v.source_platform === "OpusClip"),
    [videos],
  );

  // ADR-061 — sort each band by virality descending (tie-break on
  // clip_start_seconds ascending) so the reviewer's eye lands on
  // the strongest proposals first. Rows without a score sink to
  // the bottom. Published stays most-recent-first because
  // ordering irrelevance turns into "did that just publish?"
  // once a clip is Live.
  function byVirality(a: VideoRecordJSON, b: VideoRecordJSON): number {
    const sa = ((a.metadata_extra as { virality_score?: number } | null)?.virality_score ?? 0);
    const sb = ((b.metadata_extra as { virality_score?: number } | null)?.virality_score ?? 0);
    if (sb !== sa) return sb - sa;
    const oa = ((a.metadata_extra as { clip_start_seconds?: number } | null)?.clip_start_seconds ?? 0);
    const ob = ((b.metadata_extra as { clip_start_seconds?: number } | null)?.clip_start_seconds ?? 0);
    return oa - ob;
  }
  const pending = shorts.filter((v) => v.status === "Discovered" || v.status === "InScope").sort(byVirality);
  const approved = shorts.filter((v) => v.status === "Approved").sort(byVirality);
  const publishingRows = shorts.filter((v) => v.status === "Publishing").sort(byVirality);
  const published = shorts
    .filter((v) => v.status === "Published")
    .sort((a, b) =>
      new Date(b.published_at ?? b.indexed_at).getTime() -
      new Date(a.published_at ?? a.indexed_at).getTime(),
    );
  const failed = shorts.filter((v) => v.status === "Failed" || v.status === "ToRetry").sort(byVirality);
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

  // Refresh Opus metadata (virality score, keywords, breakdown)
  // once on mount. Silent, best-effort; failures are ignored. This
  // is what surfaces newly-computed virality scores after Opus
  // reprocesses a clip project.
  useEffect(() => {
    if (shorts.length === 0) return;
    void refreshShortsFromOpus(shorts, { actorState, onEvent, onMutated });
    // Intentionally shorts.length in deps — a stable identity for
    // the batch so we don't refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shorts.length]);

  if (shorts.length === 0) return null;

  const actionCtx = {
    actorState,
    onEvent,
    onMutated,
    onPublishError: (id: string, err: string | null) => setPublishError(prev => ({ ...prev, [id]: err ?? "" })),
    onPublishingStart: (id: string) => setPublishing(id),
    onPublishingEnd: () => setPublishing(null),
  };

  function approveclip(clip: VideoRecordJSON) { approveShort(clip, actionCtx); }
  function rejectClip(clip: VideoRecordJSON) { rejectShort(clip, actionCtx); }

  async function publishShort(clip: VideoRecordJSON) {
    // Delegates to lib/shortsPublish so VideoCard's inline actions
    // can share the exact same flow. Local state (publishing +
    // publishError) is threaded via the shared action context.
    await publishShortLib(clip, actionCtx);
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
    const canPlayInline = clip.download_url.startsWith("http");
    const isPlayerOpen = !!openPlayer[clip.id];

    return (
      <div
        key={clip.id}
        style={{
          display: "flex",
          flexDirection: "column",
          padding: "6px 0",
          borderBottom: "1px solid var(--border)",
        }}
      >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        {/* ADR-061 — Virality score badge, promoted to a large,
            scannable "N/100" affordance. Zero-signal (score == 0
            or missing) renders "—/100" so the operator can tell
            "no signal" from "low signal". */}
        <span
          title={score ? `Opus Clip virality score: ${Math.round(score)}/100` : "Opus Clip virality score not returned for this clip (Opus v2 sometimes omits it — a re-Discover from Maintain can refetch)."}
          style={{
            minWidth: 58,
            textAlign: "center",
            fontWeight: 800,
            fontSize: "0.95rem",
            fontFamily: "monospace",
            color: score && score >= 70 ? "var(--green)" : score && score >= 40 ? "#f5a623" : "var(--text-muted)",
            background: "var(--bg)",
            border: `1px solid ${score && score >= 70 ? "var(--green)" : score && score >= 40 ? "#f5a623" : "var(--border)"}`,
            borderRadius: 6,
            padding: "3px 8px",
            lineHeight: 1.15,
          }}
        >
          {score ? Math.round(score) : "—"}
          <span style={{ fontSize: "0.65rem", opacity: 0.65, marginLeft: 2 }}>/100</span>
        </span>

        {/* Title + duration + parent */}
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontSize: "0.85rem", fontWeight: 500 }}>{clip.title}</div>
          {/* ADR-061 — Virality breakdown chips. When Opus returns
              per-axis grades (Hook / Emotion / Payoff / Clarity /
              Flow), each renders as a compact chip. Absent when
              Opus's payload has no breakdown — no empty scaffolding. */}
          {Array.isArray(extra.virality_breakdown) && extra.virality_breakdown.length > 0 && (
            <div style={{ marginTop: 3, display: "flex", flexWrap: "wrap", gap: 4 }}>
              {(extra.virality_breakdown as Array<{ axis?: string; grade?: string }>)
                .slice(0, 6)
                .filter(b => b && typeof b.axis === "string" && typeof b.grade === "string")
                .map((b, i) => (
                  <span
                    key={i}
                    style={{
                      fontSize: "0.62rem", fontWeight: 600,
                      padding: "0 5px", borderRadius: 3,
                      background: "rgba(99,102,241,0.10)",
                      color: "#a5b4fc",
                      border: "1px solid rgba(99,102,241,0.28)",
                    }}
                    title={`Opus virality dimension: ${b.axis}`}
                  >
                    {b.grade} {b.axis}
                  </span>
                ))}
            </div>
          )}
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
            {canPlayInline && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenPlayer(prev => {
                    const next = !prev[clip.id];
                    // On open, fire an Opus metadata refresh for
                    // just this clip so the virality / keywords
                    // shown next to the player are fresh.
                    if (next) void refreshOneShortFromOpus(clip, { actorState, onEvent, onMutated });
                    return { ...prev, [clip.id]: next };
                  });
                }}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  color: isPlayerOpen ? "#a78bfa" : "var(--text-muted)",
                  padding: 0, fontSize: "0.7rem", textDecoration: "underline",
                }}
                title={isPlayerOpen ? "Collapse the inline player" : "Play the clip directly here — no round-trip to opus.pro"}
              >
                {isPlayerOpen ? "▾ hide" : "▶ play"}
              </button>
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
      {isPlayerOpen && canPlayInline && (
        <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-start" }}>
          <video
            controls
            preload="metadata"
            src={clip.download_url}
            style={{
              maxWidth: 280, maxHeight: 500,
              width: "100%", height: "auto",
              background: "#000", borderRadius: 6,
            }}
          />
        </div>
      )}
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

        {/* Group clips by parent session — the operator wants to
            see the dated context each clip originates from, not a
            flat status-only list. Sessions sorted newest first;
            within a session, clips ordered by status priority
            then virality desc. */}
        {(() => {
          type SessionGroup = { parent: VideoRecordJSON | null; parentId: string; clips: VideoRecordJSON[] };
          const grouped = new Map<string, SessionGroup>();
          for (const c of shorts) {
            if (c.status === "Abandoned") continue; // rejected rendered separately at the bottom
            const parent = parentByClipId.get(c.id) ?? null;
            const key = parent?.id ?? "unknown";
            const g = grouped.get(key) ?? { parent, parentId: key, clips: [] };
            g.clips.push(c);
            grouped.set(key, g);
          }
          const sessions = [...grouped.values()].sort((a, b) => {
            const ta = new Date(a.parent?.recorded_at ?? a.parent?.indexed_at ?? 0).getTime();
            const tb = new Date(b.parent?.recorded_at ?? b.parent?.indexed_at ?? 0).getTime();
            return tb - ta;
          });
          const statusOrder: Record<string, number> = {
            "Discovered": 0, "InScope": 0,
            "Approved": 1,
            "Publishing": 2,
            "Published": 3,
            "Failed": 4, "ToRetry": 4,
          };
          for (const s of sessions) {
            s.clips.sort((a, b) => {
              const sa = statusOrder[a.status] ?? 99;
              const sb = statusOrder[b.status] ?? 99;
              if (sa !== sb) return sa - sb;
              return byVirality(a, b);
            });
          }
          const actionsFor = (clip: VideoRecordJSON): React.ReactNode => {
            if (clip.status === "Discovered" || clip.status === "InScope") {
              return (
                <>
                  <button className="btn btn-sm btn-green" onClick={() => approveclip(clip)}>Approve</button>
                  <button className="btn btn-sm btn-red" onClick={() => rejectClip(clip)}>Reject</button>
                </>
              );
            }
            if (clip.status === "Approved") {
              return (
                <>
                  <button className="btn btn-sm btn-primary" onClick={() => publishShort(clip)} disabled={publishing === clip.id}>
                    {publishing === clip.id ? "Publishing…" : "Publish to YouTube"}
                  </button>
                  <button className="btn btn-sm btn-red" onClick={() => rejectClip(clip)}>Reject</button>
                </>
              );
            }
            if (clip.status === "Publishing") {
              return <span style={{ fontSize: "0.72rem", color: "#a78bfa" }}>uploading…</span>;
            }
            if (clip.status === "Published") {
              const ytLoc = (clip.locations ?? []).find(l => l.platform === "YouTube" && l.role === "Destination");
              const publishedAt = clip.published_at
                ? new Date(clip.published_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                : null;
              return (
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
                      ▶ Watch
                    </a>
                  )}
                </>
              );
            }
            if (clip.status === "Failed" || clip.status === "ToRetry") {
              return (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => publishShort(clip)}
                  disabled={publishing === clip.id}
                  title="Retry the YouTube upload for this clip"
                >
                  {publishing === clip.id ? "Publishing…" : "Retry publish"}
                </button>
              );
            }
            return null;
          };
          return sessions.map((s) => {
            const dated = s.parent?.recorded_at
              ? new Date(s.parent.recorded_at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })
              : null;
            const pubCount = s.clips.filter(c => c.status === "Published").length;
            const pendingCount = s.clips.filter(c => c.status === "Discovered" || c.status === "InScope").length;
            const failedCount = s.clips.filter(c => c.status === "Failed" || c.status === "ToRetry").length;
            return (
              <div key={s.parentId} style={{ marginBottom: 20, paddingBottom: 12, borderBottom: "2px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                  <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>
                    {s.parent?.title ?? "Unknown parent"}
                  </div>
                  {dated && (
                    <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{dated}</div>
                  )}
                  <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginLeft: "auto", display: "flex", gap: 8 }}>
                    <span>{s.clips.length} clip{s.clips.length === 1 ? "" : "s"}</span>
                    {pendingCount > 0 && <span style={{ color: "#f5a623" }}>{pendingCount} pending</span>}
                    {pubCount > 0 && <span style={{ color: "var(--green)" }}>{pubCount} live</span>}
                    {failedCount > 0 && <span style={{ color: "var(--red)" }}>{failedCount} failed</span>}
                  </div>
                </div>
                {s.clips.map(c => renderClipRow(c, actionsFor(c)))}
              </div>
            );
          });
        })()}

        {/* Rejected clips (collapsed, global) */}
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
