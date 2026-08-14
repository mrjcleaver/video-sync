"use client";

import { useState, useMemo, useEffect } from "react";
import type { VideoRecordJSON, PlatformLocationJSON, UpstreamLinkJSON } from "../lib/wasm";
import type { LoomMetadata } from "../app/api/loom/metadata/route";
import { videoStore, bootStore } from "../lib/store";
import { addExclusion } from "../lib/rules";
import {
  loadProcessingRules,
  loadPostProcessingRules,
  applyProcessingRules,
  firePostProcessingRules,
  requestLlmSummary,
  type PublishAttributes,
} from "../lib/processingRules";
import type { ShortsStatusResponse } from "../app/api/shorts/status/route";
import { derivationLabel, linkOriginLabel } from "../lib/provenanceLinker";
import { SummaryLozenge } from "./SummaryLozenge";
import { TranscriptLozenge } from "./TranscriptLozenge";
import { resolveExternalUrl } from "../lib/urlResolver";
import { loadClientLog, type LogRecord } from "../lib/logger";
import { setPrivacy, normalisePrivacy } from "../lib/youtubePrivacyCache";
import { fetchChannelUploads, rankCandidates, getCachedUploads, type MatchCandidate } from "../lib/youtubeUploadsCache";
import {
  rejectYouTubeMatch,
  isYouTubeMatchRejected,
  rejectSiblingMatch,
  isSiblingMatchRejected,
} from "../lib/suggestionRejections";
import { rankSiblingCandidates, type SiblingCandidate } from "../lib/siblingMatcher";
import { useCurrentActor, actorCommand } from "../lib/useCurrentActor";
import { ingestYouTubeSourceRow } from "../lib/youtubeIngest";
import { resolveTranscriptForOperation } from "../lib/transcriptProvenance";
import { resolveAlignedTitle, resolveAlignedTitleForced, resolveDiscordChannel } from "../lib/youtubeTitleAlign";
import { getSeriesRegistry, getSeriesRegistryCached } from "../lib/seriesRegistryClient";
import { sliceTranscriptFromSeconds, sliceTranscriptToSeconds } from "../lib/transcriptSlice";
import { getDescriptionConfigCached } from "../lib/descriptionConfig";
import { showNotesToDescription } from "../lib/showNotesToDescription";
import { formatDateHover } from "../lib/dateHover";
import { resolveContributingAccount } from "../lib/contributingAccount";
import { resolveDestinations, destinationLabel, isAutomatedDestination } from "../lib/destinationResolver";
import type { ResolvedDestinations } from "../lib/destinationResolver";
import { useRouter } from "next/navigation";
import { approveShort, rejectShort, publishShort as publishShortLib } from "../lib/shortsPublish";
import { refreshOneShortFromOpus } from "../lib/shortsRefresh";
import ConfirmDialog from "./ConfirmDialog";

const PLATFORMS = ["Zoom", "Loom", "Fireflies", "YouTube", "Kaltura", "Veedio"] as const;
const ROLES = ["Origin", "Intermediate", "Destination"] as const;

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Short date tag for event log disambiguation — e.g. "(15 Mar)" */
function dateTag(recorded_at: string | null): string {
  if (!recorded_at) return "";
  const d = new Date(recorded_at);
  return ` (${d.getDate()} ${d.toLocaleString("en-US", { month: "short" })})`;
}

/**
 * Emit a "YouTube not authorised" prompt that offers to jump straight
 * to the Connections panel in Config. Replaces bare alert()s which
 * gave no navigation path and were reported as confusing.
 */
function promptYoutubeAuth(context: string) {
  const yes = typeof window !== "undefined" && window.confirm(
    `${context}\n\nOpen Connections to authorise YouTube now?`,
  );
  if (yes) window.location.href = "/config#connections";
}

interface Props {
  video: VideoRecordJSON;
  /** Full catalog — used for cross-source sibling suggestions (ADR-033). */
  allVideos?: VideoRecordJSON[];
  /** ADR-049 — index of BroadcastedFrom upstream links. Tells the card
   *  whether it's the canonical (upstream) of a hidden broadcast
   *  destination, and what that destination is (YouTube video id, etc.). */
  broadcastPairs?: import("../lib/broadcastPairs").BroadcastPairsIndex;
  onMutated: () => void;
  onEvent: (event: string, fields?: { video_id?: string }) => void;
  /** Switch filter (if needed) and scroll the card into view. Used on publish transitions. */
  onNavigateToVideo?: (id: string, intent?: "publish") => void;
}

export default function VideoCard({ video, allVideos, broadcastPairs, onMutated, onEvent, onNavigateToVideo }: Props) {
  const router = useRouter();
  // ADR-036: derive actor from IAP JWT via /api/auth/me. Falls back to the
  // synthetic admin during boot or in dev mode (ALLOW_NO_IAP=1) so single-
  // user behaviour is preserved until IAP is configured. Throws on auth
  // error (state.error) so the click handler surfaces via ErrorBoundary
  // rather than silently mutating as the synthetic admin.
  const actorState = useCurrentActor();
  const cmd = (extra?: Record<string, unknown>) => actorCommand(actorState, extra);
  const [noteText, setNoteText] = useState("");
  const [showNotes, setShowNotes] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [showLocationForm, setShowLocationForm] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPhase, setUploadPhase] = useState("");
  const [publishAttrs, setPublishAttrs] = useState<PublishAttributes | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [locPlatform, setLocPlatform] = useState<string>("Loom");
  const [locExternalId, setLocExternalId] = useState("");
  const [locExternalUrl, setLocExternalUrl] = useState("");
  const [locRole, setLocRole] = useState<string>("Intermediate");
  const [checkingStatus, setCheckingStatus] = useState<string | null>(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [generatingDescription, setGeneratingDescription] = useState(false);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [fetchingYtTranscript, setFetchingYtTranscript] = useState(false);
  const [ytTranscriptError, setYtTranscriptError] = useState<string | null>(null);
  const [showAttrsPreview, setShowAttrsPreview] = useState(false);
  const [attrsPreview, setAttrsPreview] = useState<PublishAttributes | null>(null);
  const [destinationsPreview, setDestinationsPreview] = useState<ResolvedDestinations | null>(null);
  const [showProvenance, setShowProvenance] = useState(false);
  const [showTranscriptPreview, setShowTranscriptPreview] = useState(false);
  const [loomInfo, setLoomInfo] = useState<LoomMetadata | null>(null);
  const [loomFetching, setLoomFetching] = useState(false);
  const [loomError, setLoomError] = useState<string | null>(null);
  const [linkPlatform, setLinkPlatform] = useState("Zoom");
  const [linkExternalId, setLinkExternalId] = useState("");
  const [linkRelation, setLinkRelation] = useState("SameEvent");
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [showShortsModal, setShowShortsModal] = useState(false);
  // Collapsed by default — a video can have 20+ OpusClip children,
  // and the operator asked for a compact nested list instead of the
  // flood of standalone VideoCards it used to be.
  const [showClips, setShowClips] = useState(false);
  const [realigning, setRealigning] = useState(false);
  const [pushingYt, setPushingYt] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  // ADR-072-follow-up — inline edit of recorded_at. Kaltura (and
  // occasionally Zoom-share) imports land with a defaulted-to-now
  // date when the source didn't expose a real timestamp; operators
  // need to correct it without re-importing.
  const [editingRecordedAt, setEditingRecordedAt] = useState(false);
  const [recordedAtDraft, setRecordedAtDraft] = useState("");
  const [savingRecordedAt, setSavingRecordedAt] = useState(false);
  // Per-series Discord webhook — resolved once against the record's
  // current title. Null when the record's series has no webhook set
  // (or the record doesn't match any registered series).
  const [discordChannel, setDiscordChannel] = useState<string | null>(null);
  const [pushingDiscord, setPushingDiscord] = useState<null | "summary" | string>(null);
  // Per-clip preview toggle — keyed by clip.id. Mounts a <video>
  // controls element under the row when the operator clicks
  // "▶ preview" so they can watch without opening a new tab.
  const [openClipPreview, setOpenClipPreview] = useState<Record<string, boolean>>({});
  const [clipActionBusy, setClipActionBusy] = useState<string | null>(null);
  const shortsActionCtx = useMemo(() => ({
    actorState,
    onEvent,
    onMutated,
    onPublishingStart: (id: string) => setClipActionBusy(id),
    onPublishingEnd: () => setClipActionBusy(null),
    onPublishError: (id: string, err: string | null) => {
      if (err) onEvent(`ShortPublishError: ${err}`, { video_id: id });
    },
  }), [actorState, onEvent, onMutated]);
  useEffect(() => {
    let cancelled = false;
    getSeriesRegistry().then((registry) => {
      if (cancelled) return;
      const rawTitle = (video.metadata_extra as { youtube_original_title?: string; zoom_original_title?: string; fireflies_original_title?: string; kaltura_original_title?: string } | null) ?? {};
      const titles = [video.title, rawTitle.youtube_original_title, rawTitle.zoom_original_title, rawTitle.fireflies_original_title, rawTitle.kaltura_original_title].filter((t): t is string => typeof t === "string" && t.length > 0);
      for (const t of titles) {
        const ch = resolveDiscordChannel(t, registry);
        if (ch) { setDiscordChannel(ch); return; }
      }
      setDiscordChannel(null);
    });
    return () => { cancelled = true; };
  }, [video.id, video.title, video.metadata_extra]);

  async function pushToDiscord(kind: "summary" | "clip", args: { clipId?: string; content: string }) {
    if (!discordChannel) return;
    setPushingDiscord(kind === "summary" ? "summary" : (args.clipId ?? "clip"));
    try {
      const res = await fetch("/api/discord/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhook_url: discordChannel, content: args.content }),
      });
      if (res.ok) {
        onEvent(`DiscordPushed${kind === "summary" ? "Summary" : "Clip"}: "${video.title}"${dateTag(video.recorded_at)}`, { video_id: video.id });
      } else {
        const data = await res.json().catch(() => ({}));
        onEvent(`DiscordPushFailed: ${(data as { error?: string }).error ?? `HTTP ${res.status}`}`, { video_id: video.id });
      }
    } catch (err) {
      onEvent(`DiscordPushErrored: ${err instanceof Error ? err.message : String(err)}`, { video_id: video.id });
    } finally {
      setPushingDiscord(null);
    }
  }
  const [shortsCaption, setShortsCaption] = useState(true);
  const [shortsPrompt, setShortsPrompt] = useState("");
  const [shortsLoading, setShortsLoading] = useState(false);
  const [shortsError, setShortsError] = useState<string | null>(null);
  const [shortsPhase, setShortsPhase] = useState("");
  // ADR-062 — default to the summary-highlights + main-show
  // stitched source when a current summary exists. Falls back to
  // the full YouTube URL when disabled.
  const [shortsUseStitched, setShortsUseStitched] = useState(true);
  const [stitchPreview, setStitchPreview] = useState<{ regions: number; totalSec: number; highlights: number } | null>(null);
  // ADR-046 — summary generation state.
  const [summarising, setSummarising] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [logTick, setLogTick] = useState(0);
  const [showParticipants, setShowParticipants] = useState(false);
  const [rejectionTick, setRejectionTick] = useState(0);
  const [showRecover, setShowRecover] = useState(false);
  const [recoverInput, setRecoverInput] = useState("");
  const [recovering, setRecovering] = useState(false);
  const [recoverError, setRecoverError] = useState<string | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupCandidates, setLookupCandidates] = useState<import("../lib/youtubeUploadsCache").MatchCandidate[] | null>(null);

  const videoLog = useMemo<LogRecord[]>(() => {
    if (!showLog) return [];
    return loadClientLog().filter(r => r.video_id === video.id);
    // logTick bumps the memo when events occur
  }, [showLog, video.id, logTick]);

  const isLoomSource = /loom\.com\/(?:share|v)\//i.test(video.download_url);

  async function generateShorts() {
    setShortsError(null);
    setShortsLoading(true);

    let connections: Record<string, { credentials?: Record<string, string> }> = {};
    try {
      const raw = localStorage.getItem("video-sync:connections");
      if (raw) connections = JSON.parse(raw);
    } catch { /* ignore */ }

    const opusApiKey = connections["OpusClip"]?.credentials?.apiKey;
    if (!opusApiKey) {
      setShortsError("OpusClip API key not configured. Add it in Connections.");
      setShortsLoading(false);
      return;
    }

    // Prefer the public YouTube URL. Two shapes count as "on YouTube":
    //   - a Destination YouTube location (we published there), OR
    //   - an Origin YouTube location (born-on-YouTube record per
    //     ADR-051 — the Origin IS the public URL for these).
    // Order matters: Destination first for pair cases where we pushed
    // a Zoom recording to YouTube; the destination is authoritative.
    const ytLocs = (video.locations ?? []).filter((l) => l.platform === "YouTube" && l.external_url);
    const ytLoc = ytLocs.find((l) => l.role === "Destination") ?? ytLocs.find((l) => l.role === "Origin");
    let parentYouTubeUrl = ytLoc?.external_url ?? null;
    let parentYouTubeId = ytLoc?.external_id ?? null;

    // Fallback: metadata_extra.youtube_url (populated by
    // YouTubeLiveImport for channel-poll imports) — covers cases
    // where the Origin location's external_url wasn't written but
    // the metadata knows the video id.
    if (!parentYouTubeUrl) {
      const meYtUrl = (video.metadata_extra as { youtube_url?: string } | null)?.youtube_url;
      if (meYtUrl) {
        parentYouTubeUrl = meYtUrl;
        const idMatch = meYtUrl.match(/[?&]v=([A-Za-z0-9_-]{11})|youtu\.be\/([A-Za-z0-9_-]{11})/);
        parentYouTubeId = idMatch ? (idMatch[1] ?? idMatch[2]) : null;
      }
    }

    if (!parentYouTubeUrl) {
      setShortsError("No public YouTube URL found. Publish to YouTube first, or ensure the video is public.");
      setShortsLoading(false);
      return;
    }

    // The Origin location for born-on-YouTube records sometimes carries
    // the internal `youtube://<id>` scheme URL instead of the real
    // watch URL. Opus rejects that as "Unsupported video link". Rewrite
    // in-flight so the request is always a proper https:// URL.
    if (parentYouTubeUrl.startsWith("youtube://")) {
      const id = parentYouTubeUrl.slice("youtube://".length);
      parentYouTubeUrl = `https://www.youtube.com/watch?v=${id}`;
      if (!parentYouTubeId) parentYouTubeId = id;
    }

    try {
      setShortsPhase("Submitting to Opus Clip…");
      // ADR-060 — main-show trim window used by both curationPref.range
      // (Opus candidate selection) and, when enabled, the ADR-062
      // stitched-source builder.
      const opusRuleAttrs = publishAttrs ?? applyProcessingRules(loadProcessingRules(), video);
      const clipTrimStart = Math.max(0, Math.floor(opusRuleAttrs.trim_start_seconds ?? 0));
      const clipTrimEnd = Math.max(0, Math.floor((opusRuleAttrs as { trim_end_seconds?: number }).trim_end_seconds ?? 0));
      const clipRangeEndSec = clipTrimEnd > 0 && video.duration_seconds > clipTrimEnd
        ? video.duration_seconds - clipTrimEnd
        : (clipTrimStart > 0 && video.duration_seconds > clipTrimStart ? video.duration_seconds : null);
      const clipRangeStartSec = clipTrimStart > 0 ? clipTrimStart : (clipRangeEndSec != null ? 0 : null);
      const rangeSuffix = (clipRangeStartSec != null && clipRangeEndSec != null && clipRangeEndSec > clipRangeStartSec)
        ? ` [${Math.round(clipRangeStartSec)}s→${Math.round(clipRangeEndSec)}s = ${Math.round((clipRangeEndSec - clipRangeStartSec) / 60)}m window]`
        : "";

      // ADR-062 — if the operator opted into the stitched source
      // AND we have a summary, build the stitched mp4 first and
      // hand Opus THAT URL. This is the only path that actually
      // reduces credit spend (Opus bills by source duration).
      let useStitchedUrl: string | null = null;
      if (shortsUseStitched && video.summary_doc_id) {
        setShortsPhase("Stitching main-show + summary highlights…");
        onEvent(`ShortsStitchStart: "${video.title}"${dateTag(video.recorded_at)} — building main-show + highlights source for Opus`, { video_id: video.id });
        try {
          let connections: Record<string, { credentials?: Record<string, string> }> = {};
          try {
            const raw = localStorage.getItem("video-sync:connections");
            if (raw) connections = JSON.parse(raw);
          } catch { /* ignore */ }
          const stitchRes = await fetch("/api/shorts/build-stitched-source", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              record_id: video.id,
              download_url: video.download_url,
              summary_doc_id: video.summary_doc_id,
              source_duration_sec: video.duration_seconds,
              main_show_start_sec: clipRangeStartSec ?? undefined,
              main_show_end_sec: clipRangeEndSec ?? undefined,
              // Pass creds inline so the server doesn't have to
              // resolve them for the download step — same pattern
              // /api/youtube/upload uses.
              zoom_creds: connections["Zoom"]?.credentials ? {
                accountId: connections["Zoom"].credentials.accountId,
                clientId: connections["Zoom"].credentials.clientId,
                clientSecret: connections["Zoom"].credentials.clientSecret,
              } : undefined,
              fireflies_api_key: connections["Fireflies"]?.credentials?.apiKey,
              kaltura_creds: connections["Kaltura"]?.credentials ? {
                partnerId: connections["Kaltura"].credentials.partnerId,
                adminSecret: connections["Kaltura"].credentials.adminSecret,
              } : undefined,
              yt_cookies: connections["YouTube"]?.credentials?.ytCookies,
            }),
          });
          if (!stitchRes.ok) {
            const d = await stitchRes.json().catch(() => ({} as { error?: string }));
            const err = (d as { error?: string }).error ?? `HTTP ${stitchRes.status}`;
            onEvent(`ShortsStitchFailed: "${video.title}"${dateTag(video.recorded_at)} — ${err}. Falling back to full-source URL.`, { video_id: video.id });
          } else {
            const stitchData = await stitchRes.json() as { opus_video_url: string; total_stitched_sec: number; extracted_highlights: number; region_manifest?: unknown };
            useStitchedUrl = stitchData.opus_video_url;
            onEvent(`ShortsStitchReady: "${video.title}"${dateTag(video.recorded_at)} — ${stitchData.extracted_highlights} highlights + main show = ${Math.round(stitchData.total_stitched_sec / 60)}m stitched (vs ${Math.round(video.duration_seconds / 60)}m source). URL: ${stitchData.opus_video_url}`, { video_id: video.id });
          }
        } catch (err) {
          onEvent(`ShortsStitchErrored: ${err instanceof Error ? err.message : String(err)}. Falling back to full-source URL.`, { video_id: video.id });
        }
      }

      const opusVideoUrl = useStitchedUrl ?? parentYouTubeUrl;
      // Surface the outgoing URL in the client event log so a 4xx from
      // Opus can be diagnosed from the dashboard without opening Cloud
      // Logging. Paired with the ShortsError line on failure.
      onEvent(`ShortsRequested: "${video.title}"${dateTag(video.recorded_at)} → ${parentYouTubeUrl}${shortsPrompt ? ` (prompt: ${shortsPrompt.slice(0, 40)}${shortsPrompt.length > 40 ? "…" : ""})` : ""}${rangeSuffix}`, { video_id: video.id });
      // ADR-060 §4 — Opus bills by source duration, not by
      // curationPref.range. Warn the operator when they've asked
      // for a window narrower than the source so credit spend
      // isn't a surprise. The pre-trim pipeline (ffmpeg-cut mp4
      // in a temp GCS bucket, then feed Opus that URL) is
      // deferred; document it here for reviewer visibility.
      if (clipRangeStartSec != null && clipRangeEndSec != null && video.duration_seconds > 0) {
        const windowSec = clipRangeEndSec - clipRangeStartSec;
        const untrimmedSec = video.duration_seconds - windowSec;
        if (untrimmedSec > 60) {
          onEvent(
            `ShortsCreditWarning: Opus bills by full source duration (${Math.round(video.duration_seconds / 60)}m). ` +
            `Your main-show window is ${Math.round(windowSec / 60)}m; you'll still be billed for the ~${Math.round(untrimmedSec / 60)}m of pre/post-show that Opus ingests but ignores. ` +
            `Pre-trim pipeline is ADR-060 §4 follow-up.`,
            { video_id: video.id },
          );
        }
      }
      const genRes = await fetch("/api/shorts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // If we built a stitched source, hand Opus that Drive URL
          // instead of the raw YouTube URL. Opus fetches directly.
          parentYouTubeUrl: opusVideoUrl,
          videoTitle: video.title,
          captions: shortsCaption,
          prompt: shortsPrompt || undefined,
          apiKey: opusApiKey,
          // curationPref.range only applies to the raw-YouTube path
          // — a stitched source's regions ARE the range, so we skip
          // range constraints when we've already stitched.
          ...(useStitchedUrl == null && clipRangeStartSec != null && clipRangeEndSec != null && clipRangeEndSec > clipRangeStartSec
            ? { clipRangeStartSec, clipRangeEndSec }
            : {}),
        }),
      });

      const genData = await genRes.json() as { jobId?: string; opusProjectUrl?: string; error?: string };
      if (!genRes.ok) throw new Error(genData.error ?? `Submission failed (${genRes.status})`);
      const jobId = genData.jobId!;
      const opusProjectUrl = genData.opusProjectUrl ?? null;

      // Persist the Opus dashboard URL on the parent record so it
      // survives page reloads and can be surfaced from the ShortsPanel
      // + card long after the modal closes.
      if (opusProjectUrl) {
        try {
          videoStore.mutate(video.id, (r) => r.update_metadata(actorCommand(actorState, {
            edits: {
              metadata_extra: {
                ...(video.metadata_extra ?? {}),
                opus_clip_job_id: jobId,
                opus_project_url: opusProjectUrl,
              },
            },
          })));
        } catch { /* metadata_extra not supported by update_metadata on this WASM build — non-fatal */ }
      }

      onEvent(`ShortsJobSubmitted: "${video.title}"${dateTag(video.recorded_at)} → Opus Clip job ${jobId}${opusProjectUrl ? ` — dashboard: ${opusProjectUrl}` : ""}`, { video_id: video.id });
      setShowShortsModal(false);

      // Track stage across poll iterations so we can emit per-transition
      // events (import finished, clipping finished, etc.) into the
      // per-video event log — the operator asked to see these
      // milestones without watching the Opus dashboard.
      let lastStage: string | null = null;

      // Poll for completion (max 10 min, every 15 s)
      const maxPolls = 40;
      for (let i = 0; i < maxPolls; i++) {
        await new Promise((r) => setTimeout(r, 15_000));
        setShortsPhase(`Processing… (poll ${i + 1}/${maxPolls})`);
        const statusRes = await fetch(
          `/api/shorts/status?jobId=${encodeURIComponent(jobId)}&apiKey=${encodeURIComponent(opusApiKey)}`,
        );
        const statusData = await statusRes.json() as ShortsStatusResponse;

        // Emit a per-video event whenever Opus's stage changes.
        // Two are singled out per operator ask: "import finished"
        // (IMPORT → next stage) and "clipping finished" (→ COMPLETE).
        const nextStage = statusData.stage ?? null;
        if (nextStage && nextStage !== lastStage) {
          if (lastStage === "IMPORT" && nextStage !== "IMPORT") {
            onEvent(`ShortsImportFinished: "${video.title}"${dateTag(video.recorded_at)} — job ${jobId} advanced to ${nextStage}`, { video_id: video.id });
          }
          if (nextStage === "COMPLETE") {
            onEvent(`ShortsClippingFinished: "${video.title}"${dateTag(video.recorded_at)} — Opus finished clipping${opusProjectUrl ? ` — ${opusProjectUrl}` : ""}`, { video_id: video.id });
          }
          onEvent(`ShortsStage: "${video.title}"${dateTag(video.recorded_at)} — ${lastStage ?? "start"} → ${nextStage}`, { video_id: video.id });
          lastStage = nextStage;
        }

        if (statusData.status === "failed") throw new Error(statusData.error ?? "Opus Clip job failed");
        if (statusData.status === "completed") {
          const { indexShortClips: indexFn } = await import("./ShortsPanel");
          const count = indexFn({
            parentVideoId: video.id,
            parentSourceId: video.source_id,
            parentYouTubeId,
            jobId,
            clips: statusData.clips,
            actorState,
          });
          onEvent(`ShortsIndexed: ${count} clip(s) from "${video.title}"${dateTag(video.recorded_at)} — added to catalog with ClipOf provenance link — review in Shorts panel`, { video_id: video.id });
          onMutated();
          break;
        }
      }
    } catch (err) {
      setShortsError(String(err));
      onEvent(`ShortsError: "${video.title}"${dateTag(video.recorded_at)} [${parentYouTubeUrl}] — ${String(err)}`, { video_id: video.id });
    } finally {
      setShortsLoading(false);
      setShortsPhase("");
    }
  }

  /**
   * ADR-046 slice 2 — single-record summary generation.
   * Calls the server, which fetches transcript+chat from Drive, calls
   * OpenRouter, writes the Drive Doc, and returns metadata. The result
   * is then stamped onto the WASM record via set_summary_metadata so
   * subsequent renders (and Overview lozenge — slice 3) can pick it up.
   */
  async function generateSummary() {
    setSummaryError(null);
    setSummarising(true);
    onEvent(`SummaryRequested: "${video.title}"${dateTag(video.recorded_at)}`, { video_id: video.id });
    try {
      // ADR-053 — resolve the best transcript usable for this record.
      // Own transcript when present; otherwise borrow from a paired
      // record via safe-relations (TranscribedFrom Fireflies / Zoom
      // sibling / etc). Without this, a record whose transcript only
      // lives in the client-side cache (not on Drive) silently fails
      // the per-record Summarise button with "No transcript on Drive."
      const resolved = resolveTranscriptForOperation(video, allVideos ?? [video]);
      const isBorrowed = resolved?.source.kind === "borrowed";
      // ADR-059 — reuse the ADR-014 publish trim for the transcript
      // slice. The processing-rule-derived value is authoritative;
      // if the operator has overridden it in the publish preview
      // (publishAttrs state), prefer that override.
      const ruleAttrs = publishAttrs ?? applyProcessingRules(loadProcessingRules(), video, getSeriesRegistryCached());
      const trimStartSeconds = Math.max(0, Math.floor(ruleAttrs.trim_start_seconds ?? 0));
      const trimEndSeconds = Math.max(0, Math.floor(ruleAttrs.trim_end_seconds ?? 0));
      const res = await fetch("/api/summary/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          record_id: video.id,
          title: video.title,
          source_platform: video.source_platform,
          source_id: video.source_id,
          recorded_at: video.recorded_at ?? video.indexed_at,
          duration_seconds: video.duration_seconds,
          ...(trimStartSeconds > 0 ? { trim_start_seconds: trimStartSeconds } : {}),
          ...(trimEndSeconds > 0 ? { trim_end_seconds: trimEndSeconds } : {}),
          // Pass the resolved transcript inline whenever we have one
          // client-side. For own-transcript records this is redundant
          // with the Drive read but harmless; for borrowed-transcript
          // records this is the only path that works since the donor's
          // text is on the donor's Drive, not this record's.
          ...(resolved && resolved.text.length >= 200 ? {
            transcript_override: resolved.text,
            ...(isBorrowed ? { transcript_source_record_id: resolved.source.donor_record_id } : {}),
          } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Summary generation failed (${res.status})`);
      }
      const data = await res.json() as {
        doc_id: string;
        doc_url?: string;
        prompt_version: number;
        counts: { m: number; l: number; t: number; c: number };
        model: string;
        generated_at: string;
      };

      // Stamp the result onto the WASM record so the catalog tracks it.
      videoStore.mutate(video.id, (r) =>
        r.set_summary_metadata(actorCommand(actorState, {
          doc_id: data.doc_id,
          prompt_version: data.prompt_version,
          counts: data.counts,
          generated_at: data.generated_at,
        })),
      );
      onEvent(
        `SummaryGenerated: "${video.title}"${dateTag(video.recorded_at)} — prompt v${data.prompt_version} · M:${data.counts.m} L:${data.counts.l} T:${data.counts.t} C:${data.counts.c}${data.doc_url ? ` → ${data.doc_url}` : ""}`,
        { video_id: video.id },
      );
      onMutated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSummaryError(msg);
      onEvent(`SummaryFailed: "${video.title}"${dateTag(video.recorded_at)} — ${msg}`, { video_id: video.id });
    } finally {
      setSummarising(false);
    }
  }

  /**
   * ADR-046 slice 5 — toggle summary_locked. Locked records are skipped
   * by the bulk-regen flow so an operator's hand edits in the Drive
   * Doc survive subsequent prompt bumps. Emits SummaryLocked events
   * via the WASM aggregate (visible in catalog history; surfaced to
   * the EventLog via the onEvent string below).
   */
  function toggleSummaryLock() {
    const willLock = !video.summary_locked;
    try {
      videoStore.mutate(video.id, (r) =>
        willLock
          ? r.lock_summary(actorCommand(actorState))
          : r.unlock_summary(actorCommand(actorState)),
      );
      onEvent(
        willLock
          ? `SummaryLocked: "${video.title}"${dateTag(video.recorded_at)} — bulk-regen will skip this record`
          : `SummaryUnlocked: "${video.title}"${dateTag(video.recorded_at)} — bulk-regen will rewrite on next prompt bump`,
        { video_id: video.id },
      );
      onMutated();
    } catch (err) {
      onEvent(`Summary lock toggle failed: ${err instanceof Error ? err.message : String(err)}`, { video_id: video.id });
    }
  }

  async function fetchLoomMetadata() {
    setLoomFetching(true);
    setLoomError(null);
    try {
      const res = await fetch(
        `/api/loom/metadata?url=${encodeURIComponent(video.download_url)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setLoomInfo(data as LoomMetadata);
      onEvent(`LoomMetadataFetched: "${data.title}" by ${data.authorName}`, { video_id: video.id });
    } catch (err) {
      setLoomError(String(err));
    } finally {
      setLoomFetching(false);
    }
  }

  function applyLoomMetadata() {
    if (!loomInfo) return;
    const edits: Record<string, unknown> = {};
    if (loomInfo.title) edits.title = loomInfo.title;
    if (loomInfo.description) edits.description = loomInfo.description;
    videoStore.mutate(video.id, (r) =>
      r.update_metadata(
        cmd({ edits, }),
      ),
    );
    onEvent(`MetadataApplied: "${video.title}"${dateTag(video.recorded_at)} ← Loom${loomInfo.description ? " (with description)" : ""}`, { video_id: video.id });
    onMutated();
  }

  function approve() {
    videoStore.mutate(video.id, (r) => r.approve(cmd()));
    onEvent(`VideoApproved: "${video.title}"${dateTag(video.recorded_at)}`, { video_id: video.id });
    onMutated();
  }

  function markInScope() {
    videoStore.mutate(video.id, (r) =>
      r.mark_in_scope(
        cmd({ rule_id: null })
      )
    );
    onEvent(`VideoScoped: "${video.title}"${dateTag(video.recorded_at)}`, { video_id: video.id });
    onMutated();
  }

  function skip() {
    videoStore.mutate(video.id, (r) =>
      r.skip(
        cmd({ reason: "Skipped from dashboard", })
      )
    );
    onEvent(`VideoSkipped: "${video.title}"${dateTag(video.recorded_at)}`, { video_id: video.id });
    onMutated();
  }

  /**
   * "Exclude" = add to rules-based exclusions (so future imports skip
   * this source) + move the record itself out of the active flow.
   *
   * Operator intent is "stop dealing with this", which makes sense
   * from any non-terminal status — not just Discovered/InScope. The
   * underlying WASM transitions have different allowed-from sets
   * (skip: {Discovered,InScope}; abandon: {Failed,InScope,Discovered,
   * Skipped,Published}; mark_failed: {Publishing,Published}), so we
   * chain transitions to reach a terminal state per current status.
   *
   * Approved / ToRetry have no clean state-machine path to a terminal
   * state and remain gated — operator can move them via the publish
   * flow first.
   */
  function exclude() {
    addExclusion(video.source_platform, video.source_id, "Manual exclusion");
    const s = video.status;
    try {
      if (s === "Discovered" || s === "InScope") {
        videoStore.mutate(video.id, (r) => r.skip(cmd({ reason: "Excluded from ingestion" })));
      } else if (s === "Publishing") {
        // Publishing has no direct skip/abandon path — mark_failed first.
        videoStore.mutate(video.id, (r) => r.mark_failed(JSON.stringify({ error_message: "Excluded from ingestion (was Publishing)" })));
        videoStore.mutate(video.id, (r) => r.abandon(cmd({ reason: "Excluded from ingestion" })));
      } else if (s === "Failed" || s === "Published") {
        videoStore.mutate(video.id, (r) => r.abandon(cmd({ reason: "Excluded from ingestion" })));
      } else if (s === "Skipped") {
        // Already terminal — exclusion rule is the only new effect.
      } else {
        // Approved / ToRetry / Abandoned — no transition; exclusion rule still applies.
      }
      onEvent(`VideoExcluded: "${video.title}"${dateTag(video.recorded_at)} (from ${s})`, { video_id: video.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent(`VideoExcludePartial: "${video.title}"${dateTag(video.recorded_at)} — rule added but transition failed (${msg})`, { video_id: video.id });
    }
    onMutated();
  }

  function requestPublish() {
    videoStore.mutate(video.id, (r) =>
      r.request_publish(cmd())
    );
    onEvent(`StatusChanged: "${video.title}"${dateTag(video.recorded_at)} -> Publishing`, { video_id: video.id });
    onMutated();
    onNavigateToVideo?.(video.id, "publish");
  }

  async function preparePublish() {
    const rules = loadProcessingRules();
    let attrs = applyProcessingRules(rules, video, getSeriesRegistryCached());

    // ADR-064 — if the operator has already put a description on the
    // record (Copy from Show Notes, manual edit, or ingest), that IS
    // the truth. Don't let a rule-driven transform overwrite it in
    // the publish preview. Rules still fire for records with empty
    // descriptions.
    const hasCurated = (video.description ?? "").trim().length > 0;
    if (hasCurated) {
      attrs.description = video.description ?? "";
    }

    // Only run the transcript LLM path when both (a) a rule needs it
    // AND (b) the record has no description yet. Otherwise we'd burn
    // an LLM call on every Preview open just to throw the result
    // away when hasCurated=true.
    const needsLlm = !hasCurated && rules.some(
      (r) =>
        r.enabled &&
        (r.transforms.title?.mode === "transcript_llm" ||
          r.transforms.description?.mode === "transcript_llm"),
    );
    if (needsLlm && video.transcript_text) {
      try {
        setUploadPhase("Summarising transcript…");
        const summary = await requestLlmSummary(video.transcript_text);
        // Re-apply with summary injected as description fallback
        const enriched = { ...video, description: summary.summary };
        attrs = applyProcessingRules(rules, enriched, getSeriesRegistryCached());
      } catch (err) {
        onEvent(`LlmSummarizeFailed: "${video.title}"${dateTag(video.recorded_at)} — ${String(err)}`, { video_id: video.id });
        // Fall through with non-LLM attrs
      } finally {
        setUploadPhase("");
      }
    }

    setPublishAttrs(attrs);
    setShowPreview(true);
  }

  /**
   * ADR-049/050 C3 — after a successful YouTube publish, ingest the
   * resulting video as a fresh YouTube source row in the catalog with
   * the right upstream link. Without this, publishing keeps creating
   * Destination locations on host records but no YouTube source row,
   * so ADR-049's pair-aware UI never lights up for the freshly-published
   * video. Fire-and-forget — the publish itself has already succeeded;
   * an ingest failure shouldn't break the operator's flow.
   */
  async function ingestYouTubeRowAfterPublish(ytVideoId: string) {
    try {
      const result = await ingestYouTubeSourceRow(ytVideoId, video, { actor: actorState.actor });
      if (!result.ok) {
        onEvent(`YouTubeSourceRowIngestSkipped: ${ytVideoId} — ${result.error}`, { video_id: video.id });
        return;
      }
      if (!result.created) return;
      const linkMsg = result.upstreamLinked
        ? `, BroadcastedFrom → ${result.upstreamLinked.canonicalPlatform}:${result.upstreamLinked.canonicalExternalId}`
        : "";
      onEvent(`YouTubeSourceRowIngested: ${ytVideoId}${linkMsg}`, { video_id: result.recordId });
      onMutated();
    } catch (err) {
      onEvent(`YouTubeSourceRowIngestFailed: ${ytVideoId} — ${err instanceof Error ? err.message : String(err)}`, { video_id: video.id });
    }
  }

  async function publishToYouTube() {
    const attrs = publishAttrs ?? applyProcessingRules(loadProcessingRules(), video);

    let connections: Record<string, { credentials?: Record<string, string> }> = {};
    try {
      const raw = localStorage.getItem("video-sync:connections");
      if (raw) connections = JSON.parse(raw);
    } catch { /* ignore */ }

    const ytCreds = connections["YouTube"]?.credentials;
    if (!ytCreds?.refreshToken || !ytCreds?.clientId || !ytCreds?.clientSecret) {
      promptYoutubeAuth("YouTube not authorised. Configure Client ID, Client Secret, and complete the Authorise step in Connections first.");
      return;
    }

    setShowPreview(false);
    setUploading(true);
    const isZoomSource = video.download_url.startsWith("zoom://");
    const isLoomSource = /loom\.com\/(?:share|v)\//i.test(video.download_url);
    const isFirefliesSource = video.download_url.startsWith("fireflies://");
    const isYouTubeSource = video.download_url.startsWith("youtube://");
    setUploadPhase(isZoomSource ? "Downloading from Zoom..." : isLoomSource ? "Downloading from Loom..." : isFirefliesSource ? "Downloading from Fireflies..." : "Uploading to YouTube...");

    try {
      const zoomCreds = connections["Zoom"]?.credentials;
      const ffCreds = connections["Fireflies"]?.credentials;
      // Build provenance footer (ADR-022) — appended to description so the
      // YouTube video itself records its catalog origin, independent of local store.
      const footerParts = [
        `catalog:${video.id}`,
        `source:${video.source_platform}:${video.source_id}`,
      ];
      for (const link of video.upstream_links ?? []) {
        footerParts.push(`upstream:${link.platform}:${link.external_id}`);
      }
      const provenanceFooter = `\n\n---\nvideo-sync | ${footerParts.join(" | ")}`;
      const descriptionWithFooter = `${attrs.description ?? ""}${provenanceFooter}`.slice(0, 5000);

      const uploadBody: Record<string, unknown> = {
        refreshToken: ytCreds.refreshToken,
        clientId: ytCreds.clientId,
        clientSecret: ytCreds.clientSecret,
        title: attrs.title,
        description: descriptionWithFooter,
        tags: attrs.tags,
        downloadUrl: video.download_url,
        privacyStatus: attrs.privacy_status,
        recordedAt: video.recorded_at || undefined,
      };

      if (attrs.trim_start_seconds > 0) {
        uploadBody.trimStartSeconds = attrs.trim_start_seconds;
        onEvent(`TrimApplied: "${video.title}"${dateTag(video.recorded_at)} — ${attrs.trim_start_seconds}s from start`, { video_id: video.id });
      }

      if (isZoomSource && zoomCreds) {
        uploadBody.zoomAccountId = zoomCreds.accountId;
        uploadBody.zoomClientId = zoomCreds.clientId;
        uploadBody.zoomClientSecret = zoomCreds.clientSecret;
      }

      if (isFirefliesSource && ffCreds?.apiKey) {
        uploadBody.firefliesApiKey = ffCreds.apiKey;
      }

      if (isYouTubeSource && connections["YouTube"]?.credentials?.ytCookies) {
        uploadBody.ytCookies = connections["YouTube"].credentials.ytCookies;
      }

      // SSE streaming — single persistent connection, no cross-instance job lookup
      const res = await fetch("/api/youtube/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(uploadBody),
      });

      if (!res.ok) {
        let errMsg = `Upload failed (${res.status})`;
        try { const d = await res.json(); errMsg = d.error ?? errMsg; } catch { /* ignore */ }
        throw new Error(errMsg);
      }

      if (!res.body) throw new Error("No response stream from upload endpoint");

      type UploadResult = { videoId: string; videoUrl: string };
      let result: UploadResult | null = null;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventType = "";
      // Track the last `progress` phase so we can name it in the
      // error message when the stream ends mid-flight (typically a
      // Cloud Run SIGKILL/OOM that cuts the SSE connection without
      // emitting an `error` event).
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
              setUploadPhase(payload.phase);
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

      if (!result) {
        // Stream closed cleanly but never delivered `complete` —
        // server-side process died mid-flight. Most common cause is
        // Cloud Run OOM-killing the container during an ffmpeg trim
        // of a multi-GB recording (the source MP4 + trimmed output
        // both live in /tmp which is RAM-backed). Surface the last
        // phase + a targeted hint when we recognise the pattern.
        const trimmed = /^Trimming /i.test(lastPhase);
        const hint = trimmed
          ? ` Likely Cloud Run OOM during ffmpeg trim — the recording is too large for the 4 GiB tmpfs + working set. Try publishing with trim=0 (no trim) or ask Ops to bump Cloud Run memory.`
          : ` Server-side process exited before completing — check Cloud Run logs (filter component="ext:youtube-upload") around this time.`;
        throw new Error(`Upload stream ended without a result. Last phase: "${lastPhase}".${hint}`);
      }

      videoStore.mutate(video.id, (r) =>
        r.mark_published(
          JSON.stringify({
            destination_id: result!.videoId,
            destination_url: result!.videoUrl,
          })
        )
      );
      // Cache privacy now — we know what we asked for, no need for a round-trip.
      // A later Check Status will refresh it if YouTube's privacy differs.
      setPrivacy(result.videoId, normalisePrivacy(attrs.privacy_status));
      onEvent(`VideoPublished: "${video.title}"${dateTag(video.recorded_at)} -> ${result.videoUrl}`, { video_id: video.id });
      onMutated();
      void ingestYouTubeRowAfterPublish(result.videoId);
      firePostProcessingRules(loadPostProcessingRules(), true, video, result.videoUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      videoStore.mutate(video.id, (r) =>
        r.mark_failed(JSON.stringify({ error_message: msg }))
      );
      onEvent(`VideoPublishFailed: "${video.title}"${dateTag(video.recorded_at)} — ${msg}`, { video_id: video.id });
      onMutated();
      firePostProcessingRules(loadPostProcessingRules(), false, video, undefined, msg);
    } finally {
      setUploading(false);
      setUploadPhase("");
    }
  }

  /**
   * Pick the best source URL to feed Kaltura's media-fetch step.
   *
   * Platforms are tiered by download reliability:
   *   1. Fireflies  — GraphQL returns mp4 URL directly
   *   2. Zoom       — S2S OAuth, well-behaved if the recording exists
   *   3. Loom       — yt-dlp via Apollo state
   *   4. YouTube    — yt-dlp, anti-bot risk
   *
   * Among candidates of the same tier:
   *   a. Primary `download_url` beats upstream links (primary's identifier
   *      is the one of THIS catalog record, not a sibling — most reliable).
   *   b. Manual-linked upstream beats auto-linked (Auto comes from sibling
   *      matching and may point to siblings that don't have a recording).
   *
   * Returns the chosen URL + platform + whether the picker overrode the
   * primary download_url so the caller can surface that in the status line.
   */
  function pickDownloadUrlForKaltura(): { url: string; platform: string; chosenOverPrimary: boolean } {
    const PLATFORM_TIER: Record<string, number> = { Fireflies: 1, Zoom: 2, Loom: 3, YouTube: 4 };
    const tierFor = (p: string) => PLATFORM_TIER[p] ?? 5;

    type Candidate = { url: string; platform: string; tier: number; isPrimary: boolean; isManualLink: boolean };
    const candidates: Candidate[] = [];

    const primary = video.download_url ?? "";
    if (primary) {
      let platform = video.source_platform;
      if (primary.startsWith("youtube://") || /youtube\.com|youtu\.be/i.test(primary)) platform = "YouTube";
      else if (primary.startsWith("fireflies://")) platform = "Fireflies";
      else if (primary.startsWith("zoom://")) platform = "Zoom";
      else if (/loom\.com/i.test(primary)) platform = "Loom";
      candidates.push({ url: primary, platform, tier: tierFor(platform), isPrimary: true, isManualLink: false });
    }

    for (const link of video.upstream_links ?? []) {
      const p = link.platform;
      const ext = link.external_id?.trim();
      if (!ext) continue;
      const isManual = link.linked_by === "Manual";
      let url: string | null = null;
      // Strip the video-sync "<platform>-" prefix that source_id uses
      // for catalog uniqueness — Zoom's recordings API expects a bare UUID.
      if (p === "Fireflies") url = `fireflies://${ext.replace(/^fireflies-/, "")}`;
      else if (p === "Zoom") url = `zoom://recording/${ext.replace(/^zoom-/, "")}`;
      else if (p === "Loom") url = `https://www.loom.com/share/${ext.replace(/^loom-/, "")}`;
      else if (p === "YouTube") url = `youtube://${ext.replace(/^youtube-/, "")}`;
      if (!url) continue;
      candidates.push({ url, platform: p, tier: tierFor(p), isPrimary: false, isManualLink: isManual });
    }

    candidates.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      if (a.isManualLink !== b.isManualLink) return a.isManualLink ? -1 : 1;
      return 0;
    });

    const chosen = candidates[0] ?? { url: primary, platform: video.source_platform, isPrimary: true };
    return { url: chosen.url, platform: chosen.platform, chosenOverPrimary: !chosen.isPrimary };
  }

  /**
   * Phase 1: single-destination publish. Multi-destination (publish to both
   * YouTube and Kaltura at once) is Phase 2 in ADR-037 — it requires
   * decoupling the upload step from the mark_published transition.
   */
  async function publishToKaltura() {
    const attrs = publishAttrs ?? applyProcessingRules(loadProcessingRules(), video);

    let connections: Record<string, { credentials?: Record<string, string> }> = {};
    try {
      const raw = localStorage.getItem("video-sync:connections");
      if (raw) connections = JSON.parse(raw);
    } catch { /* ignore */ }

    // ADR-042: Kaltura is shared-only by default; the server's resolver
    // will fall through to the Admin-managed Secret Manager entry if the
    // operator has no local override. Legacy localStorage stored the
    // secret under `apiKey`; current Phase-2 UI uses `adminSecret`. Accept
    // either when forwarding the override.
    const kaltura = connections["Kaltura"]?.credentials;
    const localAdminSecret = kaltura?.adminSecret || kaltura?.apiKey;

    setShowPreview(false);
    setUploading(true);

    // Pick the best source for Kaltura's fetch step — prefer non-YouTube
    // upstreams so we don't trip YouTube's anti-bot every time.
    const picked = pickDownloadUrlForKaltura();
    const phaseSuffix = picked.chosenOverPrimary
      ? ` (via ${picked.platform} upstream)`
      : "";
    setUploadPhase(`Uploading to Kaltura${phaseSuffix}…`);

    try {
      // ADR-022 provenance footer — mirrors publishToYouTube. The Kaltura
      // entry's own description should self-document its catalog origin so
      // anyone looking at the entry on Kaltura can trace it back, and so
      // ADR-044's footer-fallback presence match works when referenceId
      // gets cleared (operators can edit referenceId in Kaltura's UI).
      const footerParts = [
        `catalog:${video.id}`,
        `source:${video.source_platform}:${video.source_id}`,
      ];
      for (const link of video.upstream_links ?? []) {
        footerParts.push(`upstream:${link.platform}:${link.external_id}`);
      }
      const provenanceFooter = `\n\n---\nvideo-sync | ${footerParts.join(" | ")}`;
      const rawDescription = attrs.description ?? video.description ?? "";
      const descriptionWithFooter = `${rawDescription}${provenanceFooter}`.slice(0, 5000);

      const body: Record<string, unknown> = {
        title: attrs.title ?? video.title,
        description: descriptionWithFooter,
        tags: attrs.tags ?? video.tags ?? [],
        downloadUrl: picked.url,
        // ADR-044: stamp the catalog UUID as the Kaltura entry's referenceId
        // so future presence-batch sweeps can find this entry by referenceId
        // alone, without depending on description footers (which operators
        // may edit in Kaltura's UI).
        referenceId: video.id,
      };
      if (kaltura?.partnerId && localAdminSecret) {
        body.partnerId = kaltura.partnerId;
        body.adminSecret = localAdminSecret;
      }
      // Forward credentials matching the PICKED source (not the primary
      // download_url) so an upstream Fireflies override gets Fireflies
      // creds even when the catalog record's source is YouTube.
      if (picked.url.startsWith("zoom://")) {
        const z = connections["Zoom"]?.credentials ?? {};
        body.zoomAccountId = z.accountId;
        body.zoomClientId = z.clientId;
        body.zoomClientSecret = z.clientSecret;
      }
      if (picked.url.startsWith("fireflies://")) {
        body.firefliesApiKey = connections["Fireflies"]?.credentials?.apiKey;
      }
      if (picked.url.startsWith("youtube://") || /youtube\.com|youtu\.be/i.test(picked.url)) {
        const yt = connections["YouTube"]?.credentials ?? {};
        if (yt.cookies) body.ytCookies = yt.cookies;
      }

      const res = await fetch("/api/kaltura/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Kaltura upload failed (${res.status})`);
      }
      const { entryId, playerUrl } = await res.json() as { entryId: string; playerUrl: string };

      // mark_published is only valid from Publishing (WASM aggregate). The
      // preview-dialog flow goes through requestPublish first so the record
      // is in Publishing — use mark_published there. Any other entry point
      // (side-publish button on a Published or Approved-with-YouTube record)
      // means we're appending a peer destination, not driving the
      // status state machine — use add_location and leave status alone.
      if (video.status === "Publishing") {
        videoStore.mutate(video.id, (r) =>
          r.mark_published(JSON.stringify({
            destination_id: entryId,
            destination_url: playerUrl,
            destination_platform: "Kaltura",
          })),
        );
        onEvent(`VideoPublished: "${video.title}"${dateTag(video.recorded_at)} -> Kaltura ${playerUrl}${picked.chosenOverPrimary ? ` (sourced from ${picked.platform})` : ""}`, { video_id: video.id });
      } else {
        videoStore.mutate(video.id, (r) =>
          r.add_location(cmd({
            platform: "Kaltura",
            external_id: entryId,
            external_url: playerUrl,
            role: "Destination",
          })),
        );
        onEvent(`Kaltura destination added: "${video.title}"${dateTag(video.recorded_at)} -> ${playerUrl}${picked.chosenOverPrimary ? ` (sourced from ${picked.platform})` : ""}`, { video_id: video.id });
      }
      onMutated();
      firePostProcessingRules(loadPostProcessingRules(), true, video, playerUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only call mark_failed if the WASM aggregate can accept it — i.e.,
      // the record was in Publishing when the upload started. From the
      // side-publish path the record is Approved/Published and mark_failed
      // would throw "Invalid status transition", masking the real error.
      if (video.status === "Publishing") {
        videoStore.mutate(video.id, (r) =>
          r.mark_failed(JSON.stringify({ error_message: msg })),
        );
      }
      onEvent(`VideoPublishFailed: "${video.title}"${dateTag(video.recorded_at)} — Kaltura: ${msg}`, { video_id: video.id });
      onMutated();
      firePostProcessingRules(loadPostProcessingRules(), false, video, undefined, msg);
    } finally {
      setUploading(false);
      setUploadPhase("");
    }
  }

  /**
   * Approved + already has a YouTube destination location (e.g. attached
   * via the auto-association banner or the Recover flow without the
   * status chain finishing) → transition through Publishing → Published
   * using the existing location data. Moves the record out of Active so
   * the dashboard's "Approved" bucket only holds work that still needs
   * an upload.
   */
  function markAsAlreadyPublished() {
    // First-choice source: an existing YouTube Destination on this
    // record. Fallback (ADR-049 slice 4): a paired BroadcastedFrom
    // broadcast destination — the YouTube id lives on the paired
    // record, not this one, but the catalog effect is the same.
    const ytLoc = (video.locations ?? []).find(
      (l) => l.role === "Destination" && l.platform === "YouTube",
    );
    let destinationId: string | undefined;
    let destUrl: string | undefined;
    if (ytLoc) {
      destinationId = ytLoc.external_id;
      destUrl = ytLoc.external_url
        ?? (ytLoc.external_id ? `https://www.youtube.com/watch?v=${ytLoc.external_id}` : undefined);
    } else {
      // Only a broadcast destination counts as "already on YouTube" —
      // transcript pairs don't make the record published.
      const paired = (broadcastPairs?.destinationsFor.get(video.id) ?? [])
        .find(p => p.kind === "broadcast");
      if (!paired) return;
      destinationId = paired.external_id;
      destUrl = `https://www.youtube.com/watch?v=${paired.external_id}`;
    }
    if (!destinationId) return;
    try {
      videoStore.mutate(video.id, (r) => r.request_publish(cmd()));
      videoStore.mutate(video.id, (r) =>
        r.mark_published(cmd({
          destination_id: destinationId,
          destination_url: destUrl,
          destination_platform: "YouTube",
        })),
      );
      onEvent(`VideoMarkedPublished: "${video.title}"${dateTag(video.recorded_at)} — already on YouTube${ytLoc ? "" : " (via broadcast pair)"}`, { video_id: video.id });
      onMutated();
      void ingestYouTubeRowAfterPublish(destinationId);
    } catch (err) {
      onEvent(`Mark Published failed: "${video.title}"${dateTag(video.recorded_at)} — ${err instanceof Error ? err.message : String(err)}`, { video_id: video.id });
    }
  }

  function abandonVideo() {
    videoStore.mutate(video.id, (r) =>
      r.abandon(cmd({ reason: "Abandoned from dashboard" }))
    );
    onEvent(`VideoAbandoned: "${video.title}"${dateTag(video.recorded_at)}`, { video_id: video.id });
    onMutated();
  }

  function markToRetry() {
    videoStore.mutate(video.id, (r) =>
      r.mark_to_retry(cmd({ reason: "Retry requested from dashboard" }))
    );
    onEvent(`VideoMarkedToRetry: "${video.title}"${dateTag(video.recorded_at)}`, { video_id: video.id });
    onMutated();
  }

  /** Parse a YouTube video ID from a watch URL, short URL, Studio URL, or raw ID. */
  function parseYouTubeId(input: string): string | null {
    const trimmed = input.trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
    const watch = trimmed.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (watch) return watch[1];
    const short = trimmed.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
    if (short) return short[1];
    const studio = trimmed.match(/studio\.youtube\.com\/video\/([A-Za-z0-9_-]{11})/);
    if (studio) return studio[1];
    return null;
  }

  /**
   * Auto-lookup on the connected YouTube channel. Fetches (or reuses cached)
   * channel uploads, ranks by fuzzy title + recorded-date proximity.
   * Populates `lookupCandidates` for operator to pick from.
   */
  async function lookupOnYouTube(force = false) {
    setRecoverError(null);
    setLookupLoading(true);
    try {
      const { uploads } = await fetchChannelUploads(force);
      const titleForMatch = getDisplayTitleOrRaw();
      const candidates = rankCandidates(uploads, titleForMatch, video.recorded_at, 5);
      setLookupCandidates(candidates);
      if (candidates.length === 0) {
        setRecoverError("No matching video found on the connected YouTube channel.");
      }
    } catch (err) {
      setRecoverError(err instanceof Error ? err.message : String(err));
    } finally {
      setLookupLoading(false);
    }
  }

  function getDisplayTitleOrRaw(): string {
    try {
      const rules = loadProcessingRules();
      if (rules.length === 0) return video.title;
      return applyProcessingRules(rules, video).title || video.title;
    } catch {
      return video.title;
    }
  }

  async function recoverFromYouTube(raw: string) {
    setRecoverError(null);
    const ytId = parseYouTubeId(raw);
    if (!ytId) {
      setRecoverError("Could not parse a YouTube video ID from that input.");
      return;
    }

    let connections: Record<string, { credentials?: Record<string, string> }> = {};
    try {
      const rawStored = localStorage.getItem("video-sync:connections");
      if (rawStored) connections = JSON.parse(rawStored);
    } catch { /* ignore */ }
    const ytCreds = connections["YouTube"]?.credentials;
    if (!ytCreds?.refreshToken || !ytCreds.clientId || !ytCreds.clientSecret) {
      setRecoverError("YouTube not authorised. Open /config#connections to configure.");
      return;
    }

    setRecovering(true);
    try {
      // 1. Verify via YouTube status API
      const statusRes = await fetch(
        `/api/youtube/status?videoId=${encodeURIComponent(ytId)}`,
        {
          headers: {
            "x-youtube-refresh-token": ytCreds.refreshToken,
            "x-youtube-client-id": ytCreds.clientId,
            "x-youtube-client-secret": ytCreds.clientSecret,
          },
        },
      );
      const statusData = await statusRes.json();
      if (!statusRes.ok) {
        throw new Error(statusData.error ?? `Status check failed (${statusRes.status})`);
      }

      // Cache privacy immediately
      if (statusData.privacyStatus) {
        setPrivacy(ytId, normalisePrivacy(statusData.privacyStatus));
      }

      const videoUrl = `https://www.youtube.com/watch?v=${ytId}`;

      // 2. Chain transitions from current status → Published
      // Path: any-non-terminal → approve → request_publish → mark_published
      if (status !== "Approved" && status !== "Publishing" && status !== "Published") {
        videoStore.mutate(video.id, r =>
          r.approve(cmd()),
        );
      }
      const rec = videoStore.get(video.id);
      if (rec) {
        const cur = JSON.parse(rec.to_json()).status;
        if (cur === "Approved") {
          videoStore.mutate(video.id, r =>
            r.request_publish(cmd()),
          );
        }
      }
      videoStore.mutate(video.id, r =>
        r.mark_published(cmd({ destination_id: ytId,
          destination_url: videoUrl,
          destination_platform: "YouTube", })),
      );

      onEvent(`VideoRecovered: "${video.title}"${dateTag(video.recorded_at)} -> ${videoUrl}`, { video_id: video.id });
      onMutated();
      void ingestYouTubeRowAfterPublish(ytId);
      setShowRecover(false);
      setRecoverInput("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRecoverError(msg);
      onEvent(`VideoRecoverFailed: "${video.title}"${dateTag(video.recorded_at)} — ${msg}`, { video_id: video.id });
    } finally {
      setRecovering(false);
    }
  }

  async function loadZoomTranscript() {
    // Guard: if the store lost this record (e.g. after WASM HMR swap), re-hydrate
    if (!videoStore.get(video.id)) {
      await bootStore();
      if (!videoStore.get(video.id)) {
        setTranscriptError("Record not in store — please reload the page (Ctrl+R).");
        return;
      }
    }

    // Pick up any operator override from localStorage, but don't gate
    // on it — per ADR-042 Zoom is shared-default with operator-override.
    // The server route (/api/zoom/transcript) already resolves shared
    // creds via getSharedCredential("zoom") when the body is empty, so
    // operators without a local override (e.g. agent@agentics.org) can
    // still load transcripts as long as the shared creds are configured.
    let zoomCreds: { accountId?: string; clientId?: string; clientSecret?: string } = {};
    try {
      const raw = localStorage.getItem("video-sync:connections");
      const connections: Record<string, { credentials?: Record<string, string> }> = raw ? JSON.parse(raw) : {};
      zoomCreds = connections["Zoom"]?.credentials ?? {};
    } catch { /* ignore */ }

    // Extract the Zoom meeting UUID from source_id (format: "zoom-<uuid>")
    const meetingUuid = video.source_id.replace(/^zoom-/, "");

    setLoadingTranscript(true);
    setTranscriptError(null);
    try {
      const body: Record<string, unknown> = { meetingUuid };
      if (zoomCreds.accountId && zoomCreds.clientId && zoomCreds.clientSecret) {
        body.accountId = zoomCreds.accountId;
        body.clientId = zoomCreds.clientId;
        body.clientSecret = zoomCreds.clientSecret;
      }
      const res = await fetch("/api/zoom/transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let errMsg = `Transcript fetch failed (${res.status})`;
        try { const d = await res.json(); errMsg = d.error || errMsg; } catch { /* non-JSON error body */ }
        setTranscriptError(errMsg);
        return;
      }
      const data = await res.json();

      videoStore.setTranscript(video.id, data.transcript);
      onEvent(`TranscriptLoaded: "${video.title}"${dateTag(video.recorded_at)} (${data.chars} chars)`, { video_id: video.id });
      onMutated();
    } catch (err) {
      setTranscriptError(`Error: ${String(err)}`);
    } finally {
      setLoadingTranscript(false);
    }
  }

  /**
   * Generate a short prose description from the transcript via the
   * legacy /api/process/summarize endpoint (3-5 sentence summary,
   * suitable for the YouTube/Kaltura description field). Distinct
   * from ADR-046's chapter-oriented Drive Doc — this is the
   * one-paragraph blurb that populates VideoRecord.description.
   * Surfaces when the record has a transcript but no description.
   */
  /**
   * Progressive-reach YouTube transcript fetch. Used when a record
   * has a YouTube location but no local transcript (own or
   * borrowed). Calls /api/youtube/transcript which tries the
   * official captions API first (needs OAuth + video ownership),
   * then falls back through public timedtext scrape and yt-dlp.
   * Result is stamped onto the record via update_metadata so
   * subsequent Show Notes / Description flows see it.
   */
  async function fetchTranscriptFromYouTube() {
    const ytLoc = (video.locations ?? []).find(l => l.platform === "YouTube" && l.external_id);
    if (!ytLoc) {
      setYtTranscriptError("No YouTube location on this record.");
      return;
    }
    setFetchingYtTranscript(true);
    setYtTranscriptError(null);
    setStatusMessage("Fetching transcript from YouTube…");
    try {
      let connections: Record<string, { credentials?: Record<string, string> }> = {};
      try {
        const raw = localStorage.getItem("video-sync:connections");
        if (raw) connections = JSON.parse(raw);
      } catch { /* ignore */ }
      const ytCreds = connections["YouTube"]?.credentials;
      const headers: Record<string, string> = {};
      if (ytCreds?.refreshToken) headers["x-youtube-refresh-token"] = ytCreds.refreshToken;
      if (ytCreds?.clientId) headers["x-youtube-client-id"] = ytCreds.clientId;
      if (ytCreds?.clientSecret) headers["x-youtube-client-secret"] = ytCreds.clientSecret;

      // Strip the "youtube-" source-id convention prefix. Locations
      // for YouTube-origin records inherit the record's source_id
      // wholesale (e.g. "youtube-H75x9DKqkOM") while YouTube-destination
      // rows have the bare video id. Send only the bare id — YouTube's
      // API/InnerTube/yt-dlp all reject the prefixed form.
      const rawId = ytLoc.external_id;
      const bareVideoId = rawId.startsWith("youtube-") ? rawId.slice("youtube-".length) : rawId;
      const res = await fetch(`/api/youtube/transcript?videoId=${encodeURIComponent(bareVideoId)}`, { headers });
      const data = await res.json();
      if (!res.ok) {
        const tried = Array.isArray(data.tried) ? data.tried.map((t: { step: string; reason?: string }) => `${t.step}: ${t.reason ?? "ok"}`).join(" · ") : "";
        throw new Error(`${data.error || `Fetch failed (${res.status})`}${tried ? ` — tried: ${tried}` : ""}`);
      }
      const text = String(data.text ?? "");
      if (text.length < 200) throw new Error(`Transcript too short (${text.length} chars)`);
      // Persist via the dedicated transcript cache map — NOT via
      // update_metadata. Transcripts routinely exceed 100KB and
      // stamping them into the WASM record blob quickly blows the
      // ~5MB localStorage quota that holds ALL records. The store's
      // setTranscript() keeps them in a separate key with graceful
      // overflow (session-only) and overlays back onto the record's
      // transcript_text in getAll() so all consumers see it.
      videoStore.setTranscript(video.id, text);
      onEvent(`TranscriptFetchedFromYouTube: "${video.title}"${dateTag(video.recorded_at)} — via ${data.source} (${text.length} chars)`, { video_id: video.id });
      setStatusMessage(`Transcript fetched (${text.length} characters, source: ${data.source}).`);
      onMutated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setYtTranscriptError(msg);
      setStatusMessage(`Transcript fetch failed: ${msg}`);
      // Emit the full reason to the event log so operators can copy-
      // paste the yt-dlp stderr / InnerTube playability status without
      // hovering. The hover text still shows the same message; this
      // just adds a durable, selectable copy.
      onEvent(
        `TranscriptFetchFromYouTubeFailed: "${video.title}"${dateTag(video.recorded_at)} — YT ${ytLoc.external_id} — ${msg}`,
        { video_id: video.id },
      );
    } finally {
      setFetchingYtTranscript(false);
    }
  }

  async function generateDescriptionFromTranscript() {
    setGeneratingDescription(true);
    setDescriptionError(null);
    setStatusMessage("Regenerating description…");
    try {
      const cfg = getDescriptionConfigCached();
      const hasShowNotes = !!video.summary_doc_id;

      // Mode "copy_show_notes" + Show Notes exists → LLM-rewrite the
      // Show Notes markdown into a YouTube-facing description using
      // the admin-configured `show_notes_prompt` (marketing hook +
      // chapter cues + optional highlights, ≤ 4800 chars). Falls back
      // to the deterministic showNotesToDescription() converter if
      // the LLM call fails.
      if (cfg.mode === "copy_show_notes" && hasShowNotes) {
        const readRes = await fetch(`/api/summary/read?docId=${encodeURIComponent(video.summary_doc_id!)}`);
        if (!readRes.ok) throw new Error(`Show Notes read failed (${readRes.status})`);
        const md = await readRes.text();
        let description = "";
        let source: "llm" | "deterministic_fallback" = "llm";
        try {
          const llmRes = await fetch("/api/description/from-show-notes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ show_notes: md }),
          });
          const llmData = await llmRes.json().catch(() => ({}));
          if (!llmRes.ok) throw new Error((llmData as { error?: string }).error ?? `LLM call failed (${llmRes.status})`);
          description = (llmData as { text?: string }).text?.trim() ?? "";
          if (!description || description.length < 20) throw new Error("LLM returned empty description");
        } catch (err) {
          onEvent(`DescriptionCopiedFallback: "${video.title}"${dateTag(video.recorded_at)} — LLM path failed (${err instanceof Error ? err.message : String(err)}); using deterministic converter`, { video_id: video.id });
          description = showNotesToDescription(md);
          source = "deterministic_fallback";
          if (!description || description.length < 20) throw new Error("Both LLM and deterministic conversion failed");
        }
        videoStore.mutate(video.id, (r) =>
          r.update_metadata(cmd({ edits: { description } })),
        );
        onEvent(`DescriptionCopied: "${video.title}"${dateTag(video.recorded_at)} (${description.length} chars) — from Show Notes via ${source}`, { video_id: video.id });
        setStatusMessage(`Description copied from Show Notes (${description.length} characters).`);
        onMutated();
        return;
      }

      // Mode "generate", or "copy_show_notes" fallback when Show
      // Notes are missing. Same LLM path as before with the ADR-060
      // trim applied first; prompt comes from server config.
      if (!video.transcript_text || video.transcript_text.length < 200) {
        setDescriptionError(cfg.mode === "copy_show_notes"
          ? "No Show Notes on Drive and no transcript to fall back on."
          : "Transcript is too short or missing.");
        return;
      }
      const rules = loadProcessingRules();
      const attrs = applyProcessingRules(rules, video, getSeriesRegistryCached());
      const trimStart = Math.max(0, Math.floor(attrs.trim_start_seconds ?? 0));
      const trimEnd = Math.max(0, Math.floor(attrs.trim_end_seconds ?? 0));
      const duration = video.duration_seconds || 0;
      let transcript = video.transcript_text;
      if (trimStart > 0) transcript = sliceTranscriptFromSeconds(transcript, trimStart);
      if (trimEnd > 0 && duration > trimEnd) {
        transcript = sliceTranscriptToSeconds(transcript, duration - trimEnd);
      }
      const finalTranscript = transcript.length >= 200 ? transcript : video.transcript_text;
      const result = await requestLlmSummary(finalTranscript);
      const description = result.summary?.trim();
      if (!description) throw new Error("LLM returned no summary text");
      videoStore.mutate(video.id, (r) =>
        r.update_metadata(cmd({ edits: { description } })),
      );
      onEvent(`DescriptionGenerated: "${video.title}"${dateTag(video.recorded_at)} (${description.length} chars) — from transcript${cfg.mode === "copy_show_notes" ? " (Show Notes fallback)" : ""}`, { video_id: video.id });
      setStatusMessage(`Description regenerated (${description.length} characters).`);
      onMutated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDescriptionError(msg);
      setStatusMessage(`Description regen failed: ${msg}`);
    } finally {
      setGeneratingDescription(false);
    }
  }

  async function checkYouTubeStatus(loc: PlatformLocationJSON) {
    let connections: Record<string, { credentials?: Record<string, string> }> = {};
    try {
      const raw = localStorage.getItem("video-sync:connections");
      if (raw) connections = JSON.parse(raw);
    } catch { /* ignore */ }

    const ytCreds = connections["YouTube"]?.credentials;
    if (!ytCreds?.refreshToken || !ytCreds?.clientId || !ytCreds?.clientSecret) {
      promptYoutubeAuth("YouTube not authorised. Configure Client ID, Client Secret, and complete the Authorise step in Connections first.");
      return;
    }

    setCheckingStatus(loc.external_id);
    try {
      const res = await fetch(
        `/api/youtube/status?videoId=${encodeURIComponent(loc.external_id)}`,
        {
          headers: {
            "x-youtube-refresh-token": ytCreds.refreshToken,
            "x-youtube-client-id": ytCreds.clientId,
            "x-youtube-client-secret": ytCreds.clientSecret,
          },
        }
      );
      const data = await res.json();
      // Cache privacy status regardless of upload status (as long as we got a response)
      if (res.ok && data.privacyStatus) {
        setPrivacy(loc.external_id, normalisePrivacy(data.privacyStatus));
      }
      if (!res.ok) {
        // Video not found or API error — mark as failed
        if (res.status === 404) {
          try {
            videoStore.mutate(video.id, (r) =>
              r.mark_failed(JSON.stringify({ error_message: "YouTube video not found" }))
            );
            onEvent(`VideoFailed: "${video.title}"${dateTag(video.recorded_at)} — YouTube video not found`, { video_id: video.id });
            onMutated();
          } catch { /* ignore if status transition not allowed */ }
          return;
        }
        throw new Error(data.error || `Status check failed (${res.status})`);
      }

      // If YouTube reports processing failed or removed, mark video as failed
      const failedStatuses = ["ProcessingFailed", "Removed"];
      if (failedStatuses.includes(data.status)) {
        try {
          videoStore.mutate(video.id, (r) =>
            r.update_location_status(
              cmd({ platform: "YouTube",
                external_id: loc.external_id,
                status: data.status, })
            )
          );
        } catch { /* ignore */ }
        try {
          videoStore.mutate(video.id, (r) =>
            r.mark_failed(JSON.stringify({ error_message: `YouTube status: ${data.status}` }))
          );
        } catch { /* ignore if transition not allowed */ }
        onEvent(`VideoFailed: "${video.title}"${dateTag(video.recorded_at)} — YouTube ${data.status}`, { video_id: video.id });
        onMutated();
        return;
      }

      try {
        videoStore.mutate(video.id, (r) =>
          r.update_location_status(
            cmd({ platform: "YouTube",
              external_id: loc.external_id,
              status: data.status, })
          )
        );
      } catch (wasmErr) {
        onEvent(`LocationStatusUpdated (display only): YouTube/${loc.external_id} -> ${data.status}`, { video_id: video.id });
        onMutated();
        return;
      }
      onEvent(`LocationStatusUpdated: "${video.title}"${dateTag(video.recorded_at)} YouTube/${loc.external_id} -> ${data.status}`, { video_id: video.id });
      onMutated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent(`YouTubeStatusCheckFailed: "${video.title}"${dateTag(video.recorded_at)} — ${msg}`, { video_id: video.id });
      alert(`YouTube status check failed: ${msg}`);
    } finally {
      setCheckingStatus(null);
    }
  }

  function markFailed() {
    videoStore.mutate(video.id, (r) =>
      r.mark_failed(JSON.stringify({ error_message: "Manual failure from dashboard" }))
    );
    onEvent(`StatusChanged: "${video.title}"${dateTag(video.recorded_at)} -> Failed`, { video_id: video.id });
    onMutated();
  }

  function addLocation() {
    if (!locExternalId.trim()) return;
    videoStore.mutate(video.id, (r) =>
      r.add_location(
        cmd({ platform: locPlatform,
          external_id: locExternalId.trim(),
          external_url: locExternalUrl.trim() || null,
          role: locRole, })
      )
    );
    onEvent(`LocationAdded: "${video.title}"${dateTag(video.recorded_at)} — ${locPlatform}/${locExternalId}`, { video_id: video.id });
    setLocExternalId("");
    setLocExternalUrl("");
    setShowLocationForm(false);
    onMutated();
  }

  function removeLocation(loc: PlatformLocationJSON) {
    videoStore.mutate(video.id, (r) =>
      r.remove_location(
        cmd({ platform: loc.platform,
          external_id: loc.external_id, })
      )
    );
    onEvent(`LocationRemoved: "${video.title}"${dateTag(video.recorded_at)} — ${loc.platform}/${loc.external_id}`, { video_id: video.id });
    onMutated();
  }

  function addNote() {
    if (!noteText.trim()) return;
    videoStore.mutate(video.id, (r) =>
      r.add_note(
        cmd({ text: noteText.trim(), })
      )
    );
    onEvent(`NoteAdded: "${video.title}"${dateTag(video.recorded_at)} — "${noteText.trim()}"`, { video_id: video.id });
    setNoteText("");
    onMutated();
  }

  function addUpstreamLink() {
    if (!linkExternalId.trim()) return;
    videoStore.mutate(video.id, (r) =>
      r.link_upstream(
        cmd({ platform: linkPlatform,
          external_id: linkExternalId.trim(),
          relation: linkRelation,
          linked_by: "Manual", })
      )
    );
    onEvent(`UpstreamLinked: "${video.title}"${dateTag(video.recorded_at)} <- ${linkPlatform}/${linkExternalId.trim()}`, { video_id: video.id });
    setLinkExternalId("");
    setShowLinkForm(false);
    onMutated();
  }

  function removeUpstreamLink(link: UpstreamLinkJSON, reject = false) {
    videoStore.mutate(video.id, (r) =>
      r.unlink_upstream(
        cmd({ platform: link.platform,
          external_id: link.external_id,
          reject, })
      )
    );
    onEvent(`UpstreamUnlinked: "${video.title}"${dateTag(video.recorded_at)} <- ${link.platform}/${link.external_id}${reject ? " (rejected)" : ""}`, { video_id: video.id });
    onMutated();
  }

  function toggleAttrsPreview() {
    if (showAttrsPreview) {
      setShowAttrsPreview(false);
      return;
    }
    const registry = getSeriesRegistryCached();
    const rules = loadProcessingRules();
    const attrs = applyProcessingRules(rules, video, registry);
    // Same operator-intent rule as preparePublish: a curated
    // description on the record beats a rule-driven transform in
    // the small Preview panel too.
    if ((video.description ?? "").trim().length > 0) {
      attrs.description = video.description ?? "";
    }
    setAttrsPreview(attrs);
    // ADR-075 Phase 2 — resolve destinations against the series
    // registry. Profile arg is null here: this preview is per-record
    // interactive, not driven by a specific batch profile. The
    // resolver's global default fires when no series matches.
    setDestinationsPreview(resolveDestinations(video, registry, rules, null));
    setShowAttrsPreview(true);
  }

  // Compute processed title from rules (sync — LLM mode falls back to original)
  const previewTitle = useMemo(() => {
    const rules = loadProcessingRules();
    if (rules.length === 0) return null;
    const processed = applyProcessingRules(rules, video).title;
    return processed !== video.title ? processed : null;
  }, [video]);

  /**
   * If the YouTube uploads cache contains a confident match for this video
   * AND this video isn't already linked to a YouTube destination, surface a
   * one-click "Link existing YouTube video" suggestion.
   */
  const autoSuggestion = useMemo<MatchCandidate | null>(() => {
    if (video.status === "Published" || video.status === "Publishing" || video.status === "Abandoned") return null;
    const alreadyHasYT = (video.locations ?? []).some(l => l.platform === "YouTube" && l.role === "Destination");
    if (alreadyHasYT) return null;
    const cached = getCachedUploads();
    if (!cached) return null;
    const title = previewTitle ?? video.title;
    const ranked = rankCandidates(cached.uploads, title, video.recorded_at, 5);
    // Only surface high-confidence matches to avoid bad auto-suggestions
    const best = ranked.find(c => c.score >= 0.7 && !isYouTubeMatchRejected(video.id, c.upload.id));
    return best ?? null;
  }, [video.id, video.status, video.locations, video.title, video.recorded_at, previewTitle, rejectionTick]);

  /**
   * Cross-source sibling suggestion (ADR-033 dedupe).
   * Suggest the best non-YouTube, different-source match above threshold
   * that isn't already linked as an upstream (SameEvent) to this record.
   */
  const siblingSuggestion = useMemo<SiblingCandidate | null>(() => {
    if (!allVideos || allVideos.length < 2) return null;
    if (video.status === "Abandoned") return null;
    const existingLinks = new Set((video.upstream_links ?? []).map(l => `${l.platform}:${l.external_id}`));
    const candidates = rankSiblingCandidates(video, allVideos, 5);
    const best = candidates.find(c => {
      if (c.score < 0.55) return false;
      if (isSiblingMatchRejected(video.id, c.video.id)) return false;
      // Already linked as upstream? skip
      if (existingLinks.has(`${c.video.source_platform}:${c.video.source_id}`)) return false;
      return true;
    });
    return best ?? null;
  }, [video.id, video.status, video.upstream_links, allVideos, rejectionTick]);

  function acceptSibling(cand: SiblingCandidate) {
    // Link the sibling as an upstream SameEvent on THIS record.
    // (The two records represent parallel captures of the same event.)
    try {
      videoStore.mutate(video.id, (r) =>
        r.link_upstream(cmd({ platform: cand.video.source_platform,
          external_id: cand.video.source_id,
          relation: "SameEvent",
          linked_by: "Auto", })),
      );
      onEvent(`SameEventLinked: "${video.title}"${dateTag(video.recorded_at)} <- ${cand.video.source_platform}/${cand.video.source_id}`, { video_id: video.id });
      onMutated();
    } catch (err) {
      onEvent(`SameEventLinkFailed: "${video.title}"${dateTag(video.recorded_at)} — ${String(err)}`, { video_id: video.id });
    }
  }

  // OpusClip children of this video — resolved via ClipOf upstream
  // link (preferred), falling back to metadata_extra.parent_video_id
  // for any legacy rows written before ADR-055's link addition.
  const childClips = useMemo<VideoRecordJSON[]>(() => {
    if (!allVideos || video.source_platform === "OpusClip") return [];
    const out: VideoRecordJSON[] = [];
    for (const r of allVideos) {
      if (r.source_platform !== "OpusClip") continue;
      const viaLink = (r.upstream_links ?? []).some(l => l.relation === "ClipOf" && l.video_id === video.id);
      const viaMeta = (r.metadata_extra as { parent_video_id?: string } | null)?.parent_video_id === video.id;
      if (viaLink || viaMeta) out.push(r);
    }
    // Sort by start-of-clip so the collapsible list reads left-to-
    // right through the recording timeline.
    out.sort((a, b) => {
      const sa = (a.metadata_extra as { clip_start_seconds?: number } | null)?.clip_start_seconds ?? 0;
      const sb = (b.metadata_extra as { clip_start_seconds?: number } | null)?.clip_start_seconds ?? 0;
      return sa - sb;
    });
    return out;
  }, [allVideos, video.id, video.source_platform]);

  /**
   * Per-card title realignment.
   * Tries three sources of truth in order:
   *   1. resolveAlignedTitle on the current record — fires for
   *      undated titles when a pair or registry entry matches.
   *   2. resolveTitleFromRegistry on metadata_extra.<platform>_original_title
   *      — handles the alias case: title is already dated but the
   *      operator has just added a canonical name they'd rather see.
   *   3. Nothing — nothing changed, inform the operator.
   * Optionally pushes to YouTube if we can resolve a YouTube video
   * ID (Destination location > Origin > youtube-<id> source_id).
   */
  async function realignTitle(pushToYouTube: boolean) {
    setRealigning(true);
    try {
      const registry = await getSeriesRegistry();
      const all = videoStore.getAll();
      // Per-record realign uses the "forced" resolver: after the
      // usual paired-canonical + registry pass, ALSO re-run the
      // registry against the current title (even when already
      // dated) so newly-added aliases can retitle records that
      // were previously dated under an older canonical name.
      // See resolveAlignedTitleForced.
      const alignment = resolveAlignedTitleForced(video, all, registry);

      // The title we'll ultimately push to YouTube.
      // Priority: newly-computed alignment > current local title.
      // If we're in push-only mode (already aligned), the current
      // local title IS the source of truth we want mirrored upstream.
      let finalTitle = alignment?.new_title ?? video.title;

      if (alignment && alignment.new_title !== video.title) {
        try {
          videoStore.mutate(video.id, (r) =>
            r.update_metadata(actorCommand(actorState, { edits: { title: alignment!.new_title } })),
          );
        } catch (err) {
          onEvent(`RealignTitleFailed: "${video.title}"${dateTag(video.recorded_at)} — ${err instanceof Error ? err.message : String(err)}`, { video_id: video.id });
          return;
        }
        onEvent(`RealignTitle: "${video.title}"${dateTag(video.recorded_at)} → "${alignment.new_title}" (via ${alignment.source})`, { video_id: video.id });
        onMutated();
      } else if (!pushToYouTube) {
        // Realign-only clicked but nothing to change locally.
        onEvent(
          alignment
            ? `RealignTitle: "${video.title}"${dateTag(video.recorded_at)} — already aligned`
            : `RealignTitle: "${video.title}"${dateTag(video.recorded_at)} — no rewrite (no matching pair, no registry pattern)`,
          { video_id: video.id },
        );
        return;
      } else {
        // Realign + push clicked; local is already correct. Fall
        // through to the YouTube-push block below so YouTube gets
        // synced to the current local title even when nothing
        // changed locally. This is the "I already realigned, now
        // sync to YouTube" flow the operator hit.
        finalTitle = video.title;
      }

      if (pushToYouTube) {
        // At this point finalTitle is the local-authoritative title
        // we want live on YouTube. May equal the current YouTube
        // title — /api/youtube/update-title returns updated:false
        // in that case and we log accordingly.
        // Resolve a YouTube video ID: Destination > Origin > youtube-<id>.
        const ytLoc = (video.locations ?? []).find(l => l.platform === "YouTube" && l.role === "Destination" && l.external_id)
                   ?? (video.locations ?? []).find(l => l.platform === "YouTube" && l.role === "Origin" && l.external_id);
        const ytId = ytLoc?.external_id
                  ?? (video.source_platform === "YouTube" ? video.source_id.replace(/^youtube-/, "") : null);
        if (!ytId) {
          onEvent(`RealignTitle push skipped: "${finalTitle}" — no YouTube video ID on record`, { video_id: video.id });
          return;
        }
        let connections: Record<string, { credentials?: Record<string, string> }> = {};
        try {
          const raw = localStorage.getItem("video-sync:connections");
          if (raw) connections = JSON.parse(raw);
        } catch { /* ignore */ }
        const yt = connections["YouTube"]?.credentials;
        if (!yt?.refreshToken || !yt?.clientId || !yt?.clientSecret) {
          onEvent(`RealignTitle push skipped: "${finalTitle}" — YouTube not authorised`, { video_id: video.id });
          return;
        }
        try {
          const res = await fetch("/api/youtube/update-title", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              videoId: ytId.replace(/^youtube-/, ""),
              title: finalTitle,
              refreshToken: yt.refreshToken,
              clientId: yt.clientId,
              clientSecret: yt.clientSecret,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            const d = data as { updated?: boolean };
            onEvent(
              d.updated
                ? `RealignTitle pushed to YouTube/${ytId}: "${finalTitle}"`
                : `RealignTitle YouTube already matched YouTube/${ytId}: "${finalTitle}"`,
              { video_id: video.id },
            );
          } else {
            const err = (data as { error?: string }).error ?? `HTTP ${res.status}`;
            onEvent(`RealignTitle push failed for YouTube/${ytId}: ${err}`, { video_id: video.id });
          }
        } catch (err) {
          onEvent(`RealignTitle push errored: ${err instanceof Error ? err.message : String(err)}`, { video_id: video.id });
        }
      }
    } finally {
      setRealigning(false);
    }
  }

  /**
   * Push the local title AND description to the YouTube video via
   * videos.update. Separate from realignTitle — no title mutation is
   * attempted; the record's current title + description are sent
   * verbatim. The endpoint is idempotent (returns updated:false
   * when both already match). Falls through when the record has
   * no YouTube video ID or YouTube isn't authorised, logging the
   * reason to the event stream.
   */
  async function pushTitleAndDescriptionToYouTube() {
    setPushingYt(true);
    setStatusMessage("Pushing title + description to YouTube…");
    try {
      const ytLoc = (video.locations ?? []).find(l => l.platform === "YouTube" && l.role === "Destination" && l.external_id)
                 ?? (video.locations ?? []).find(l => l.platform === "YouTube" && l.role === "Origin" && l.external_id);
      const ytId = ytLoc?.external_id
                ?? (video.source_platform === "YouTube" ? video.source_id.replace(/^youtube-/, "") : null);
      if (!ytId) {
        onEvent(`YouTubePush skipped: "${video.title}"${dateTag(video.recorded_at)} — no YouTube video ID on record`, { video_id: video.id });
        return;
      }
      let connections: Record<string, { credentials?: Record<string, string> }> = {};
      try {
        const raw = localStorage.getItem("video-sync:connections");
        if (raw) connections = JSON.parse(raw);
      } catch { /* ignore */ }
      const yt = connections["YouTube"]?.credentials;
      if (!yt?.refreshToken || !yt?.clientId || !yt?.clientSecret) {
        onEvent(`YouTubePush skipped: "${video.title}"${dateTag(video.recorded_at)} — YouTube not authorised`, { video_id: video.id });
        return;
      }
      const bareId = ytId.replace(/^youtube-/, "");
      const description = video.description ?? "";
      try {
        const res = await fetch("/api/youtube/update-title", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoId: bareId,
            title: video.title,
            description,
            refreshToken: yt.refreshToken,
            clientId: yt.clientId,
            clientSecret: yt.clientSecret,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          const d = data as { updated?: boolean; titleChanged?: boolean; descriptionChanged?: boolean };
          if (d.updated) {
            const parts: string[] = [];
            if (d.titleChanged) parts.push(`title→"${video.title}"`);
            if (d.descriptionChanged) parts.push(`desc→${description.length}ch`);
            onEvent(`YouTubePush ok YouTube/${bareId}: ${parts.join(", ")}`, { video_id: video.id });
            setStatusMessage(`Pushed to YouTube: ${parts.join(", ")}.`);
          } else {
            onEvent(`YouTubePush no-op YouTube/${bareId}: title + description already match`, { video_id: video.id });
            setStatusMessage("YouTube already matches — no push needed.");
          }
        } else {
          const err = (data as { error?: string }).error ?? `HTTP ${res.status}`;
          onEvent(`YouTubePush failed YouTube/${bareId}: ${err}`, { video_id: video.id });
          setStatusMessage(`Push to YouTube failed: ${err}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent(`YouTubePush errored YouTube/${bareId}: ${msg}`, { video_id: video.id });
        setStatusMessage(`Push to YouTube errored: ${msg}`);
      }
    } finally {
      setPushingYt(false);
    }
  }

  /**
   * Manual title override. Persists via update_metadata; optionally
   * also PUTs the new title to YouTube via videos.update. Falls
   * through silently on YouTube auth failure (event log records
   * the reason) — the local rename always wins.
   */
  async function saveTitleEdit(pushToYouTube: boolean) {
    const draft = titleDraft.trim();
    if (!draft || draft === video.title) {
      setEditingTitle(false);
      return;
    }
    setSavingTitle(true);
    const oldTitle = video.title;
    try {
      videoStore.mutate(video.id, (r) =>
        r.update_metadata(actorCommand(actorState, { edits: { title: draft } })),
      );
    } catch (err) {
      onEvent(`TitleEditFailed: "${oldTitle}"${dateTag(video.recorded_at)} — ${err instanceof Error ? err.message : String(err)}`, { video_id: video.id });
      setSavingTitle(false);
      return;
    }
    onEvent(`TitleEdited: "${oldTitle}"${dateTag(video.recorded_at)} → "${draft}"`, { video_id: video.id });
    onMutated();
    setEditingTitle(false);
  }

  /**
   * Manual recorded_at override. Accepts either an ISO datetime or a
   * bare `YYYY-MM-DD` from the date input; normalises to noon UTC on
   * the given day when only a date was picked (an operator picking a
   * date rarely means midnight in some timezone — noon UTC is the
   * safest default that renders the same day in every viewer TZ).
   * Clearing the field sets recorded_at back to null.
   */
  async function saveRecordedAtEdit() {
    const draft = recordedAtDraft.trim();
    setSavingRecordedAt(true);
    let normalised: string | null = null;
    if (draft) {
      // <input type="datetime-local"> gives "YYYY-MM-DDTHH:MM"; type="date" gives "YYYY-MM-DD"
      const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(draft);
      normalised = bareDate ? `${draft}T12:00:00Z` : new Date(draft).toISOString();
    }
    const previous = video.recorded_at ?? "unset";
    try {
      videoStore.mutate(video.id, (r) =>
        r.update_metadata(actorCommand(actorState, { edits: { recorded_at: normalised } })),
      );
    } catch (err) {
      onEvent(`RecordedAtEditFailed: "${video.title}" — ${err instanceof Error ? err.message : String(err)}`, { video_id: video.id });
      setSavingRecordedAt(false);
      return;
    }
    onEvent(`RecordedAtEdited: "${video.title}" ${previous} → ${normalised ?? "unset"}`, { video_id: video.id });
    onMutated();
    setEditingRecordedAt(false);
    setSavingRecordedAt(false);

    if (pushToYouTube) {
      const ytLoc = (video.locations ?? []).find(l => l.platform === "YouTube" && l.role === "Destination" && l.external_id)
                 ?? (video.locations ?? []).find(l => l.platform === "YouTube" && l.role === "Origin" && l.external_id);
      const ytId = ytLoc?.external_id
                ?? (video.source_platform === "YouTube" ? video.source_id.replace(/^youtube-/, "") : null);
      if (!ytId) {
        onEvent(`TitleEdit push skipped: no YouTube video ID on record`, { video_id: video.id });
        setSavingTitle(false);
        return;
      }
      let connections: Record<string, { credentials?: Record<string, string> }> = {};
      try {
        const raw = localStorage.getItem("video-sync:connections");
        if (raw) connections = JSON.parse(raw);
      } catch { /* ignore */ }
      const yt = connections["YouTube"]?.credentials;
      if (!yt?.refreshToken || !yt?.clientId || !yt?.clientSecret) {
        onEvent(`TitleEdit push skipped: YouTube not authorised`, { video_id: video.id });
        setSavingTitle(false);
        return;
      }
      try {
        const res = await fetch("/api/youtube/update-title", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoId: ytId.replace(/^youtube-/, ""),
            title: draft,
            refreshToken: yt.refreshToken,
            clientId: yt.clientId,
            clientSecret: yt.clientSecret,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          const d = data as { updated?: boolean };
          onEvent(
            d.updated
              ? `TitleEdit pushed to YouTube/${ytId}: "${draft}"`
              : `TitleEdit YouTube already matched YouTube/${ytId}: "${draft}"`,
            { video_id: video.id },
          );
        } else {
          const err = (data as { error?: string }).error ?? `HTTP ${res.status}`;
          onEvent(`TitleEdit push failed for YouTube/${ytId}: ${err}`, { video_id: video.id });
        }
      } catch (err) {
        onEvent(`TitleEdit push errored: ${err instanceof Error ? err.message : String(err)}`, { video_id: video.id });
      }
    }
    setSavingTitle(false);
  }

  const status = video.status;
  const canApprove = status === "Discovered" || status === "InScope" || status === "Failed" || status === "ToRetry";
  const canSkip = status === "Discovered" || status === "InScope";
  const canAbandon = status === "Failed" || status === "InScope" || status === "Discovered" || status === "Skipped" || status === "Published";
  // Exclude widened beyond canSkip — operator's intent is "never deal
  // with this source again", which is valid from any status whose
  // record we can actually retire (skip / abandon / mark_failed→abandon).
  // Approved + ToRetry stay gated because the WASM state machine has
  // no clean retirement path for them; Abandoned is already terminal.
  const canExclude =
    status === "Discovered" || status === "InScope" ||
    status === "Publishing" || status === "Failed" ||
    status === "Published" || status === "Skipped";
  const canRetry = status === "Failed" || status === "Published";
  // Recover is useful for any non-Published video that's already live on YouTube
  // (SSE-dropped uploads, out-of-band publishes, imports of existing YT content).
  const canRecover = status !== "Published" && status !== "Publishing" && status !== "Abandoned";
  const canScope = status === "Discovered";
  const canPublish = status === "Approved";
  const isPublishing = status === "Publishing";
  const canGenerateShorts = (status === "Published" || status === "Approved") && video.source_platform !== "OpusClip";
  const alreadyPublishedLocation = (video.locations ?? []).some(
    (l) => l.role === "Destination" && l.platform === "YouTube"
  );
  // ADR-049 slice 4: a canonical record (Zoom etc.) is "already on
  // YouTube" if a paired YouTube-Live broadcast destination points at
  // it — even though no YouTube Destination location lives on THIS
  // record. The publish flow short-circuits the same way.
  const pairedDownstreams = broadcastPairs?.destinationsFor.get(video.id) ?? [];
  const pairedBroadcasts = pairedDownstreams.filter(p => p.kind === "broadcast");
  const pairedTranscripts = pairedDownstreams.filter(p => p.kind === "transcript");
  // Only BroadcastedFrom counts as "already on YouTube" — TranscribedFrom
  // pairs are transcription bots (Fireflies), they don't make the canonical
  // record published anywhere.
  const hasPairedBroadcast = pairedBroadcasts.length > 0;
  const alreadyPublished = alreadyPublishedLocation || hasPairedBroadcast;
  const alreadyOnKaltura = (video.locations ?? []).some(
    (l) => l.role === "Destination" && l.platform === "Kaltura"
  );
  // The Kaltura side-publish button is offered when the catalog already
  // shows a YouTube destination (or is post-Published) but Kaltura is
  // missing. Kaltura must be configured in Connections.
  const canSidePublishKaltura = !alreadyOnKaltura
    && (status === "Published" || (status === "Approved" && alreadyPublished));

  return (
    <div className="video-card" id={`video-card-${video.id}`}>
      <div className="video-card-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          {editingTitle ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void saveTitleEdit(false); }
                  else if (e.key === "Escape") { e.preventDefault(); setEditingTitle(false); }
                }}
                disabled={savingTitle}
                style={{
                  width: "100%", padding: "4px 6px",
                  background: "var(--bg)", border: "1px solid var(--border)",
                  borderRadius: 4, color: "var(--text)",
                  fontSize: "1rem", fontWeight: 600,
                }}
              />
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => saveTitleEdit(false)}
                  disabled={savingTitle || !titleDraft.trim() || titleDraft.trim() === video.title}
                >
                  {savingTitle ? "Saving…" : "Save"}
                </button>
                {(video.locations ?? []).some(l => l.platform === "YouTube" && l.external_id) && (
                  <button
                    className="btn btn-sm"
                    onClick={() => saveTitleEdit(true)}
                    disabled={savingTitle || !titleDraft.trim() || titleDraft.trim() === video.title}
                    title="Save the new title locally AND push it to the actual YouTube video via videos.update"
                  >
                    {savingTitle ? "Saving…" : "Save + push to YouTube"}
                  </button>
                )}
                <button
                  className="btn btn-sm"
                  onClick={() => setEditingTitle(false)}
                  disabled={savingTitle}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <h3 style={{ margin: 0, flex: 1, minWidth: 0 }}>{previewTitle ?? video.title}</h3>
              <button
                onClick={() => { setTitleDraft(video.title); setEditingTitle(true); }}
                title="Edit title"
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  color: "var(--text-muted)", padding: "0 4px", fontSize: "0.9rem",
                }}
              >
                ✏️
              </button>
            </div>
          )}
          {previewTitle && !editingTitle && (
            <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: 2, fontStyle: "italic" }}>
              {video.title}
            </div>
          )}
        </div>
        <button
          onClick={() => router.push(`/catalog?just=${video.id}`)}
          title="Focus this card — filter the catalog to just this record. Click 'Show all' on the banner to return."
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--text-muted)", padding: "0 4px", fontSize: "1rem",
          }}
        >
          ⛶
        </button>
        <span className={`status-badge status-${status}`}>{status}</span>
      </div>

      {/* Auto-suggestion: this record looks like it's already on YouTube */}
      {autoSuggestion && (
        <div style={{
          marginTop: 6, padding: "6px 10px",
          background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.25)", borderRadius: 6,
          display: "flex", alignItems: "center", gap: 8, fontSize: "0.78rem",
        }}>
          <span>
            <span style={{ color: "#38bdf8", fontWeight: 600 }}>Possible YouTube match:</span>{" "}
            <span style={{ color: "var(--text-muted)" }}>
              {autoSuggestion.upload.title}
              {autoSuggestion.upload.publishedAt && ` · ${autoSuggestion.upload.publishedAt.slice(0, 10)}`}
              {" · "}{Math.round(autoSuggestion.score * 100)}% match
            </span>
          </span>
          <button
            className="btn btn-sm btn-primary"
            style={{ marginLeft: "auto", fontSize: "0.7rem" }}
            onClick={() => recoverFromYouTube(autoSuggestion.upload.id)}
            disabled={recovering}
          >
            {recovering ? "Linking…" : "Link & mark Published"}
          </button>
          <button
            className="btn btn-sm"
            style={{ fontSize: "0.7rem", color: "var(--red)" }}
            onClick={() => {
              rejectYouTubeMatch(video.id, autoSuggestion.upload.id);
              setRejectionTick(t => t + 1);
              onEvent(`MatchRejected: "${video.title}"${dateTag(video.recorded_at)} ≠ YouTube ${autoSuggestion.upload.id}`, { video_id: video.id });
            }}
            disabled={recovering}
            title="Dismiss this suggestion — the same pair won't be suggested again."
          >
            Not a match
          </button>
          <a
            href={`https://www.youtube.com/watch?v=${autoSuggestion.upload.id}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: "0.7rem", color: "var(--text-muted)", textDecoration: "underline" }}
          >
            preview
          </a>
        </div>
      )}

      {/* Cross-source sibling suggestion (ADR-033) */}
      {siblingSuggestion && (
        <div style={{
          marginTop: 6, padding: "6px 10px",
          background: "var(--purple-soft)", border: "1px solid var(--purple-border)", borderRadius: 6,
          display: "flex", alignItems: "center", gap: 8, fontSize: "0.78rem",
        }}>
          <span>
            <span style={{ color: "#a78bfa", fontWeight: 600 }}>Possibly same event:</span>{" "}
            <span style={{ color: "var(--text-muted)" }}>
              {siblingSuggestion.video.source_platform}: {siblingSuggestion.video.title}
              {siblingSuggestion.video.recorded_at && ` · ${siblingSuggestion.video.recorded_at.slice(0, 10)}`}
              {" · "}
              <span title={`Participants: ${Math.round(siblingSuggestion.reasons.participant_overlap * 100)}% · Title: ${Math.round(siblingSuggestion.reasons.title_overlap * 100)}%${siblingSuggestion.reasons.time_delta_minutes != null ? ` · Δt ${Math.round(siblingSuggestion.reasons.time_delta_minutes)}min` : ""}`}>
                {Math.round(siblingSuggestion.score * 100)}% match
              </span>
            </span>
          </span>
          <button
            className="btn btn-sm btn-primary"
            style={{ marginLeft: "auto", fontSize: "0.7rem" }}
            onClick={() => acceptSibling(siblingSuggestion)}
          >
            Link as same event
          </button>
          <button
            className="btn btn-sm"
            style={{ fontSize: "0.7rem", color: "var(--red)" }}
            onClick={() => {
              rejectSiblingMatch(video.id, siblingSuggestion.video.id);
              setRejectionTick(t => t + 1);
              onEvent(`SiblingMatchRejected: "${video.title}"${dateTag(video.recorded_at)} ≠ ${siblingSuggestion.video.source_platform}/${siblingSuggestion.video.source_id}`, { video_id: video.id });
            }}
            title="Dismiss this suggestion — the same pair won't be suggested again."
          >
            Not a match
          </button>
          <button
            className="btn btn-sm"
            style={{ fontSize: "0.7rem", color: "var(--text-muted)", textDecoration: "underline", background: "transparent", border: "none", padding: 0, cursor: "pointer" }}
            onClick={() => onNavigateToVideo?.(siblingSuggestion.video.id)}
            title="Scroll to the suggested sibling record"
          >
            view
          </button>
        </div>
      )}

      <div className="video-card-meta">
        {/* Origin platform — clickable when the download_url resolves to
            a real web URL (Zoom recording, Fireflies view, YouTube watch,
            Loom share, Kaltura entry). Title carries source_id for hover
            disclosure without crowding the row. */}
        {(() => {
          const originHref = resolveExternalUrl(video.download_url);
          const tooltip = `${video.source_platform} · ${video.source_id}`;
          return originHref ? (
            <a
              href={originHref}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open on ${tooltip}`}
              style={{ color: "var(--primary, #6366f1)", textDecoration: "none" }}
            >
              {video.source_platform}
            </a>
          ) : (
            <span title={tooltip}>{video.source_platform}</span>
          );
        })()}
        {/* ADR-075/§Follow-up — contributing-account chip. Shows which
            platform account owns the source (YouTube channel, Zoom host
            email, Fireflies organizer, Loom owner, Drive file owner,
            /contribute contributor). Nothing rendered when the account
            can't be resolved from metadata_extra. */}
        {(() => {
          const acct = resolveContributingAccount(video);
          if (!acct) return null;
          return (
            <span
              title={acct.tooltip}
              style={{
                fontSize: "0.7rem",
                color: "var(--text-muted)",
                padding: "1px 8px",
                borderRadius: 10,
                background: "var(--bg-card, rgba(99,102,241,0.05))",
                border: "1px solid var(--border)",
                cursor: "help",
                maxWidth: "24ch",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              from {acct.label}
            </span>
          );
        })()}
        <span title={`${Math.floor(video.duration_seconds / 60)} min`}>{formatDuration(video.duration_seconds)}</span>
        {editingRecordedAt ? (
          <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <label htmlFor={`recorded-at-${video.id}`} className="visually-hidden">Recorded date</label>
            <input
              id={`recorded-at-${video.id}`}
              type="date"
              value={recordedAtDraft}
              onChange={(e) => setRecordedAtDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void saveRecordedAtEdit(); }
                else if (e.key === "Escape") { e.preventDefault(); setEditingRecordedAt(false); }
              }}
              disabled={savingRecordedAt}
              autoFocus
              style={{
                fontSize: "0.75rem", padding: "1px 4px",
                background: "var(--bg)", color: "var(--text)",
                border: "1px solid var(--border)", borderRadius: 4,
              }}
            />
            <button
              type="button" className="btn btn-sm" onClick={() => void saveRecordedAtEdit()}
              disabled={savingRecordedAt}
              title="Save"
              style={{ fontSize: "0.7rem", padding: "1px 6px" }}
            >
              {savingRecordedAt ? "…" : "✓"}
            </button>
            <button
              type="button" className="btn btn-sm" onClick={() => setEditingRecordedAt(false)}
              disabled={savingRecordedAt}
              title="Cancel"
              style={{ fontSize: "0.7rem", padding: "1px 6px" }}
            >
              ✕
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="meta-button"
            onClick={() => {
              setRecordedAtDraft(
                video.recorded_at
                  ? new Date(video.recorded_at).toISOString().slice(0, 10)
                  : "",
              );
              setEditingRecordedAt(true);
            }}
            title={`${formatDateHover(video.recorded_at || video.indexed_at)} · Click to edit recorded date`}
            style={{ fontSize: "inherit", color: "inherit" }}
          >
            {formatDate(video.recorded_at || video.indexed_at)}
            {!video.recorded_at && (
              <span
                style={{ marginLeft: 4, fontSize: "0.65rem", color: "var(--yellow)" }}
                title="No recorded_at set — showing indexed_at as a fallback"
              >
                ⚠
              </span>
            )}
          </button>
        )}
        {video.participants.length > 0 && (
          <span
            onClick={() => setShowParticipants(v => !v)}
            style={{ cursor: "pointer", userSelect: "none" }}
            title={showParticipants ? "Hide participants" : "Show participants"}
          >
            {video.participants.length} participant{video.participants.length === 1 ? "" : "s"} {showParticipants ? "▲" : "▼"}
          </span>
        )}
        {/* Drive folder link — opens the artifacts folder (transcript,
            description, summary, chat) for this record. */}
        <a
          href={`/api/artifacts/${encodeURIComponent(video.id)}/folder`}
          target="_blank"
          rel="noopener noreferrer"
          title="Open this record's Drive folder (transcript, description, summary, chat)"
          style={{
            fontSize: "0.7rem",
            padding: "1px 6px",
            borderRadius: 10,
            background: "rgba(56,189,248,0.06)",
            color: "#7dd3fc",
            border: "1px solid rgba(56,189,248,0.2)",
            textDecoration: "none",
          }}
        >
          Drive
        </a>
        {/* Transcript indicator — present/missing badge. For Kaltura-
            sourced records without a transcript, doubles as a "Fetch
            from Kaltura" button that pulls captions and persists them
            via videoStore (which PUTs to Drive). */}
        <TranscriptLozenge
          recordId={video.id}
          sourcePlatform={video.source_platform}
          sourceId={video.source_id}
          transcriptText={video.transcript_text}
          onEvent={onEvent}
          onUpdated={onMutated}
        />
        {/* ADR-046 — summary lozenge: same M:N L:N T:N C:N indicator
            shown in the Overview row, so operators see the current
            summary state without leaving the card. */}
        <SummaryLozenge
          docId={video.summary_doc_id}
          promptVersion={video.summary_prompt_version}
          locked={video.summary_locked ?? false}
          counts={video.summary_counts}
          stopRowClick={false}
        />
        {/* ADR-049 slice 3: paired downstream destinations
            (BroadcastedFrom → YouTube Live; TranscribedFrom →
            Fireflies). Hidden as separate cards by default; these
            badges are their representation on the canonical
            (upstream meeting source) card. */}
        {pairedBroadcasts.map(p => {
          const linked = (allVideos ?? []).find(v => v.id === p.destination_record_id);
          const badgeLabel = linked
            ? `${linked.title.slice(0, 40)}${linked.title.length > 40 ? "…" : ""}`
            : p.external_id;
          const dateHint = linked?.recorded_at
            ? ` · ${new Date(linked.recorded_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
            : "";
          return (
          <a
            key={p.destination_record_id}
            href={`https://www.youtube.com/watch?v=${p.external_id}`}
            target="_blank"
            rel="noopener noreferrer"
            title={
              linked
                ? `Broadcast destination on YouTube Live\nPaired record: ${linked.title}\nRecorded: ${linked.recorded_at ?? "?"}\nYouTube ID: ${p.external_id}\nCatalog ID: ${p.destination_record_id.slice(0, 8)}…\nClick to open on YouTube.`
                : `Broadcast destination on YouTube Live (paired record ${p.destination_record_id.slice(0, 8)}…). Click to open.`
            }
            style={{
              fontSize: "0.7rem",
              padding: "1px 6px",
              borderRadius: 10,
              background: "var(--danger-soft)",
              color: "#fb7185",
              border: "1px solid var(--danger-border)",
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            📺 YouTube Live · {badgeLabel}{dateHint}
          </a>
          );
        })}
        {pairedTranscripts.map(p => (
          <a
            key={p.destination_record_id}
            href={`https://app.fireflies.ai/view/${encodeURIComponent(p.external_id)}`}
            target="_blank"
            rel="noopener noreferrer"
            title={`Transcript captured by ${p.destination_platform} (paired record ${p.destination_record_id.slice(0, 8)}…). Click to open in Fireflies.`}
            style={{
              fontSize: "0.7rem",
              padding: "1px 6px",
              borderRadius: 10,
              background: "var(--warning-soft)",
              color: "#f59e0b",
              border: "1px solid var(--warning-border)",
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            📝 {p.destination_platform} · {p.external_id.slice(0, 12)}…
          </a>
        ))}
        {/* ADR-065 — community-contributor attribution chip. Only
            renders when the record was ingested by a Contributor (or a
            Publisher "on behalf of" a contributor). Chapter is optional
            and shows before the email when present. */}
        {video.contributor_email && (
          <span
            title={`Contributed by ${video.contributor_email}${video.contributor_chapter ? ` — ${video.contributor_chapter}` : ""}`}
            style={{
              fontSize: "0.7rem", padding: "1px 6px", borderRadius: 10,
              background: "rgba(139,92,246,0.12)", color: "#a78bfa",
              border: "1px solid rgba(139,92,246,0.35)",
              whiteSpace: "nowrap",
            }}
          >
            👤 {video.contributor_chapter ? `${video.contributor_chapter} — ` : ""}
            {video.contributor_email.split("@")[0]}
          </span>
        )}
        {/* Catalog UUID — clickable to copy. Useful when correlating with
            server logs, .meta.json files, or webhook payloads. */}
        <span
          onClick={() => {
            navigator.clipboard?.writeText(video.id).catch(() => {});
          }}
          title="Click to copy the catalog ID"
          style={{
            cursor: "pointer",
            fontFamily: "monospace",
            fontSize: "0.7rem",
            color: "var(--text-muted)",
            userSelect: "all",
          }}
        >
          {video.id.slice(0, 8)}…
        </span>
      </div>

      {/* ADR-046 slice 5 — "last regenerated" detail. Shown whenever a
          summary exists; the lozenge already encodes the counts + stale
          state, this line adds the human-readable timestamp + lock
          state so the operator can scan their bulk-regen results
          without hovering on the lozenge. */}
      {video.summary_doc_id && (
        <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: 8 }}>
          {video.summary_locked ? "🔒 " : ""}Show Notes: prompt v{video.summary_prompt_version ?? "?"}
          {video.summary_generated_at && (
            <> · last regenerated {new Date(video.summary_generated_at).toLocaleString(undefined, {
              year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
            })}</>
          )}
          {video.summary_locked && <> · locked — bulk-regen skipped</>}
        </div>
      )}

      {showParticipants && video.participants.length > 0 && (
        <div style={{
          marginBottom: 8, padding: "6px 10px",
          background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6,
          display: "flex", flexWrap: "wrap", gap: 4,
        }}>
          {video.participants.map((p, i) => (
            <span
              key={`${p}-${i}`}
              style={{
                fontSize: "0.72rem",
                padding: "2px 8px",
                borderRadius: 10,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                fontFamily: /\S+@\S+/.test(p) ? "monospace" : undefined,
              }}
            >
              {p}
            </span>
          ))}
        </div>
      )}

      {video.description ? (
        <div style={{ marginBottom: 8 }}>
          <div style={{
            fontSize: "0.62rem", fontWeight: 600, color: "var(--text-muted)",
            textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2,
            display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
          }}>
            <span title="video.description — short paragraph attached to the record at ingest (or generated from the transcript). Distinct from the chapter-oriented Show Notes (ADR-046).">
              Description
            </span>
            {!editingDescription && (
              <button
                className="btn btn-sm"
                style={{ padding: "0 6px", fontSize: "0.6rem", fontWeight: 500, textTransform: "none", letterSpacing: 0 }}
                onClick={() => {
                  setDescriptionDraft(video.description ?? "");
                  setEditingDescription(true);
                  setDescriptionError(null);
                }}
                title="Edit the description text in place. Saves to the record via update_metadata (event-sourced)."
              >
                ✏ Edit
              </button>
            )}
            {(() => {
              const cfg = getDescriptionConfigCached();
              const hasSN = !!video.summary_doc_id;
              const copyMode = cfg.mode === "copy_show_notes" && hasSN;
              const canGenerate = (video.transcript_text?.length ?? 0) >= 200;
              if (!copyMode && !canGenerate) return null;
              if (editingDescription) return null;
              const label = generatingDescription
                ? (copyMode ? "🪄 Rewriting…" : "✨ Regenerating…")
                : (copyMode ? "🪄 Rewrite from Show Notes" : "✨ Regenerate from transcript");
              const title = copyMode
                ? "LLM-rewrites the Show Notes markdown into a YouTube-facing description using the configured Show Notes prompt (marketing hook + chapter cues, ≤4800 chars). Falls back to a deterministic markdown-strip converter only if the LLM call fails."
                : "Regenerate the paragraph description from the current transcript. Uses ADR-060 scheduled-window trim (drops pre/post-show).";
              return (
                <button
                  className="btn btn-sm"
                  style={{ padding: "0 6px", fontSize: "0.6rem", fontWeight: 500, textTransform: "none", letterSpacing: 0 }}
                  onClick={generateDescriptionFromTranscript}
                  disabled={generatingDescription}
                  title={title}
                >
                  {label}
                </button>
              );
            })()}
            {descriptionError && (
              <span style={{ color: "var(--red)", textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>
                Error: {descriptionError.slice(0, 100)}
              </span>
            )}
          </div>
          {editingDescription ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <textarea
                value={descriptionDraft}
                onChange={(e) => setDescriptionDraft(e.target.value)}
                style={{
                  width: "100%", minHeight: 90, fontSize: "0.85rem",
                  color: "var(--text)", background: "var(--bg)",
                  border: "1px solid var(--border)", borderRadius: 4,
                  padding: "6px 8px", resize: "vertical",
                  fontFamily: "inherit", lineHeight: 1.4,
                }}
                autoFocus
              />
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  className="btn btn-sm btn-primary"
                  style={{ fontSize: "0.72rem" }}
                  onClick={() => {
                    try {
                      const next = descriptionDraft.trim();
                      videoStore.mutate(video.id, (r) =>
                        r.update_metadata(cmd({ edits: { description: next } })),
                      );
                      onEvent(`DescriptionEdited: "${video.title}"${dateTag(video.recorded_at)} (${next.length} chars)`, { video_id: video.id });
                      setEditingDescription(false);
                      onMutated();
                    } catch (err) {
                      setDescriptionError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                >
                  Save
                </button>
                <button
                  className="btn btn-sm"
                  style={{ fontSize: "0.72rem" }}
                  onClick={() => { setEditingDescription(false); setDescriptionError(null); }}
                >
                  Cancel
                </button>
                <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", alignSelf: "center", marginLeft: 4 }}>
                  {descriptionDraft.length} chars
                </span>
              </div>
            </div>
          ) : (
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: 0, whiteSpace: "pre-wrap" }}>
              {video.description}
            </p>
          )}
        </div>
      ) : (() => {
        const cfg = getDescriptionConfigCached();
        const hasSN = !!video.summary_doc_id;
        const copyMode = cfg.mode === "copy_show_notes" && hasSN;
        const canGenerate = (video.transcript_text?.length ?? 0) >= 200;
        if (!copyMode && !canGenerate) return null;
        const label = generatingDescription
          ? (copyMode ? "🪄 Rewriting…" : "Generating…")
          : (copyMode ? "🪄 Rewrite from Show Notes" : "✨ Generate from transcript");
        const title = copyMode
          ? "LLM-rewrites the Show Notes markdown into a YouTube-facing description via the configured Show Notes prompt (marketing hook + chapter cues). Falls back to a deterministic markdown-strip converter only if the LLM call fails."
          : "Generate a short paragraph description from the transcript via OpenRouter. Distinct from the chapter-oriented Show Notes.";
        return (
          <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: 8, fontStyle: "italic", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span>No description yet.</span>
            <button
              className="btn btn-sm"
              style={{ fontSize: "0.72rem" }}
              onClick={generateDescriptionFromTranscript}
              disabled={generatingDescription}
              title={title}
            >
              {label}
            </button>
            {descriptionError && (
              <span style={{ color: "var(--red)" }}>Error: {descriptionError.slice(0, 100)}</span>
            )}
          </div>
        );
      })()}

      {video.tags.length > 0 && (
        <div className="video-card-tags">
          {video.tags.map((tag) => (
            <span key={tag} className="tag">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Loom metadata fetch */}
      {isLoomSource && (
        <div style={{ fontSize: "0.75rem", marginBottom: 8 }}>
          {!loomInfo && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                className="btn btn-sm"
                style={{ padding: "1px 8px", fontSize: "0.7rem" }}
                onClick={fetchLoomMetadata}
                disabled={loomFetching}
              >
                {loomFetching ? "Fetching…" : "Fetch Loom info"}
              </button>
              {loomError && (
                <span style={{ color: "var(--red)", fontSize: "0.7rem" }}>{loomError}</span>
              )}
            </div>
          )}
          {loomInfo && (
            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                {loomInfo.thumbnailUrl && (
                  <img
                    src={loomInfo.thumbnailUrl}
                    alt="Loom thumbnail"
                    style={{ width: 120, height: 68, objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
                  />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: "0.8rem", marginBottom: 2 }}>{loomInfo.title}</div>
                  <div style={{ color: "var(--text-muted)", fontSize: "0.72rem", marginBottom: 2 }}>
                    by {loomInfo.authorName}
                    {loomInfo.durationSeconds != null && (
                      <span style={{ marginLeft: 8 }}>{formatDuration(loomInfo.durationSeconds)}</span>
                    )}
                    {loomInfo.width && loomInfo.height && (
                      <span style={{ marginLeft: 8 }}>{loomInfo.width}×{loomInfo.height}</span>
                    )}
                  </div>
                  {loomInfo.description && (
                    <div style={{
                      fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 4,
                      maxHeight: 80, overflowY: "auto", whiteSpace: "pre-wrap", lineHeight: 1.5,
                    }}>
                      {loomInfo.description}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                    <button
                      className="btn btn-sm btn-primary"
                      style={{ padding: "1px 8px", fontSize: "0.7rem" }}
                      onClick={applyLoomMetadata}
                    >
                      Apply to record
                    </button>
                    <button
                      className="btn btn-sm"
                      style={{ padding: "1px 6px", fontSize: "0.7rem" }}
                      onClick={() => setLoomInfo(null)}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Transcript */}
      {(video.source_platform === "Zoom" || video.source_platform === "Fireflies") && (
        <div style={{ fontSize: "0.75rem", marginBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {video.transcript_text ? (
              <>
                <span style={{ color: "var(--green)" }}>
                  Transcript ({Math.round(video.transcript_text.length / 5)} words est.)
                </span>
                <button
                  className="btn btn-sm"
                  style={{ padding: "1px 6px", fontSize: "0.65rem" }}
                  onClick={() => setShowTranscriptPreview((v) => !v)}
                >
                  {showTranscriptPreview ? "Hide" : "Preview"}
                </button>
              </>
            ) : video.source_platform === "Zoom" ? (
              <>
                <span style={{ color: "var(--text-muted)" }}>No transcript</span>
                <button
                  className="btn btn-sm"
                  style={{ padding: "1px 8px", fontSize: "0.7rem" }}
                  onClick={loadZoomTranscript}
                  disabled={loadingTranscript}
                >
                  {loadingTranscript ? "Loading…" : "Load Transcript"}
                </button>
              </>
            ) : null}
            {transcriptError && (
              <span style={{ color: "var(--red)", fontSize: "0.7rem" }}>{transcriptError}</span>
            )}
          </div>
          {showTranscriptPreview && video.transcript_text && (
            <div style={{
              marginTop: 6,
              padding: "6px 8px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-muted)",
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
              maxHeight: 160,
              overflowY: "auto",
              fontSize: "0.72rem",
            }}>
              {video.transcript_text.slice(0, 800)}{video.transcript_text.length > 800 ? "…" : ""}
            </div>
          )}
        </div>
      )}

      {/* Processing rules preview (pre-approve) */}
      {showAttrsPreview && attrsPreview && (
        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6, padding: "10px 12px", marginBottom: 8, fontSize: "0.78rem" }}>
          <div style={{ fontWeight: 600, color: "var(--accent)", marginBottom: 6, fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Processing rules preview
          </div>
          {attrsPreview.title !== video.title && (
            <div style={{ marginBottom: 6 }}>
              <span style={{ color: "var(--text-muted)", fontSize: "0.7rem" }}>Title → </span>
              <span style={{ fontWeight: 600 }}>{attrsPreview.title}</span>
            </div>
          )}
          {attrsPreview.description && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ color: "var(--text-muted)", fontSize: "0.7rem", marginBottom: 2 }}>Description</div>
              <div style={{ whiteSpace: "pre-wrap", color: "var(--text)", lineHeight: 1.5 }}>{attrsPreview.description}</div>
            </div>
          )}
          {attrsPreview.tags.length > 0 && (
            <div style={{ marginBottom: 4 }}>
              <span style={{ color: "var(--text-muted)", fontSize: "0.7rem" }}>Tags: </span>
              {attrsPreview.tags.map(t => (
                <span key={t} style={{ display: "inline-block", fontSize: "0.68rem", padding: "1px 6px", borderRadius: 10, background: "var(--bg)", border: "1px solid var(--border)", marginRight: 4 }}>{t}</span>
              ))}
            </div>
          )}
          <div>
            <span style={{ color: "var(--text-muted)", fontSize: "0.7rem" }}>Privacy (legacy field): </span>
            <span>{attrsPreview.privacy_status}</span>
          </div>
          {destinationsPreview && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed var(--border)" }}>
              <div style={{ color: "var(--text-muted)", fontSize: "0.7rem", marginBottom: 4 }}>
                Destinations (ADR-075 Phase 2) — resolved via{" "}
                {destinationsPreview.provenance.source === "series"
                  ? <>series <strong>{destinationsPreview.provenance.series_name}</strong></>
                  : destinationsPreview.provenance.source === "profile"
                    ? <>profile <strong>{destinationsPreview.provenance.profile_id}</strong></>
                    : <>global default</>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {destinationsPreview.destinations.map((d, i) => {
                  const automated = isAutomatedDestination(d);
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.78rem" }}>
                      <span style={{ minWidth: 90, color: automated ? "var(--text)" : "var(--text-muted)" }}>
                        {automated ? "✓" : "⚠"} {destinationLabel(d)}
                      </span>
                      {!automated && (
                        <span title="This destination is not wired to an automated push. Publish shows a checklist marker; the operator must action it by hand." style={{ fontSize: "0.68rem", color: "var(--yellow)" }}>
                          manual
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Clips derived from this recording — collapsible; a single
          recording can produce 20+ Opus shorts and rendering each as
          its own VideoCard flooded the catalog. */}
      {childClips.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button
            onClick={() => setShowClips(v => !v)}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              background: "none", border: "none", color: "rgb(94,234,212)",
              fontSize: "0.78rem", fontWeight: 600, cursor: "pointer",
              padding: "2px 0",
            }}
            title="Toggle the per-clip list"
          >
            <span style={{ display: "inline-block", width: 10 }}>{showClips ? "▾" : "▸"}</span>
            ✂️ {childClips.length} clip{childClips.length === 1 ? "" : "s"}
          </button>
          {showClips && (
            <div style={{
              marginTop: 4, paddingLeft: 14,
              borderLeft: "2px solid rgba(20,184,166,0.35)",
              display: "flex", flexDirection: "column", gap: 3,
            }}>
              {childClips.map(c => {
                const extra = (c.metadata_extra ?? {}) as Record<string, unknown>;
                const start = typeof extra.clip_start_seconds === "number" ? extra.clip_start_seconds : 0;
                const end = typeof extra.clip_end_seconds === "number" ? extra.clip_end_seconds : 0;
                const length = Math.max(0, end - start);
                const kw = Array.isArray(extra.keywords) ? (extra.keywords as string[]) : [];
                const editUrl = typeof extra.opus_edit_url === "string" ? extra.opus_edit_url : null;
                const score = typeof extra.virality_score === "number" ? extra.virality_score : 0;
                const isPublished = c.status === "Published";
                const isFailed = c.status === "Failed";
                const isApproved = c.status === "Approved";
                const isPending = c.status === "Discovered" || c.status === "InScope";
                const isPublishing = c.status === "Publishing";
                const ytLoc = (c.locations ?? []).find(l => l.platform === "YouTube" && l.role === "Destination" && l.external_url);
                const canPreview = c.download_url.startsWith("http");
                const previewOpen = !!openClipPreview[c.id];
                const clipPublishing = clipActionBusy === c.id;
                const fmt = (s: number) => {
                  const m = Math.floor(s / 60);
                  const sec = Math.floor(s % 60);
                  return `${m}:${String(sec).padStart(2, "0")}`;
                };
                return (
                  <div key={c.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div
                    style={{
                      display: "flex", gap: 8, alignItems: "center",
                      fontSize: "0.75rem", padding: "2px 4px",
                      borderRadius: 4, flexWrap: "wrap",
                    }}
                    title={c.title}
                  >
                    {/* ADR-061 — virality badge N/100 with colour bands. */}
                    <span
                      style={{
                        minWidth: 44, textAlign: "center", fontWeight: 700,
                        fontSize: "0.72rem", fontFamily: "monospace",
                        color: score >= 70 ? "var(--green)" : score >= 40 ? "#f5a623" : "var(--text-muted)",
                        background: "var(--bg)",
                        border: `1px solid ${score >= 70 ? "var(--green)" : score >= 40 ? "#f5a623" : "var(--border)"}`,
                        borderRadius: 4, padding: "1px 4px",
                      }}
                      title={score ? `Opus virality: ${Math.round(score)}/100` : "No score — Opus Clip's public v2 API doesn't expose the virality score field (dashboard-only). Confirmed against their OpenAPI 2026-07-27; the on-preview refresh can't retrieve what the API doesn't return."}
                    >
                      {score ? Math.round(score) : "—"}
                    </span>
                    <span style={{ fontFamily: "monospace", color: "var(--text-muted)", minWidth: 42 }}>@{fmt(start)}</span>
                    <span style={{ fontFamily: "monospace", color: "var(--text-muted)", minWidth: 34 }}>{fmt(length)}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
                      {kw.length > 0
                        ? kw.slice(0, 6).join(" · ")
                        : (c.title.length > 60 ? c.title.slice(0, 59) + "…" : c.title)}
                    </span>
                    {isPublished && ytLoc?.external_url ? (
                      <a
                        href={ytLoc.external_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          fontSize: "0.65rem", color: "#000",
                          background: "var(--green)",
                          borderRadius: 3, padding: "0 6px",
                          textDecoration: "none", fontWeight: 600,
                        }}
                        title="Watch the published short on YouTube"
                      >
                        ▶ live
                      </a>
                    ) : isPublished ? (
                      <span style={{ fontSize: "0.65rem", color: "var(--green)", fontWeight: 600 }}>✓ published</span>
                    ) : isFailed ? (
                      <span style={{ fontSize: "0.65rem", color: "var(--red)", fontWeight: 600 }}>× failed</span>
                    ) : (
                      <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>{c.status.toLowerCase()}</span>
                    )}
                    {isPending && (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); approveShort(c, shortsActionCtx); }}
                          disabled={clipPublishing}
                          title="Approve this clip so it moves to the publish queue"
                          style={{ fontSize: "0.62rem", padding: "0 6px", borderRadius: 3, background: "var(--green)", color: "#000", border: "1px solid var(--green)", fontWeight: 700, cursor: "pointer" }}
                        >Approve</button>
                        <button
                          onClick={(e) => { e.stopPropagation(); rejectShort(c, shortsActionCtx); }}
                          disabled={clipPublishing}
                          title="Reject this clip; retained in the catalog for audit but never published"
                          style={{ fontSize: "0.62rem", padding: "0 6px", borderRadius: 3, background: "var(--red)", color: "#fff", border: "1px solid var(--red)", fontWeight: 700, cursor: "pointer" }}
                        >Reject</button>
                      </>
                    )}
                    {(isApproved || isFailed) && (
                      <button
                        onClick={(e) => { e.stopPropagation(); void publishShortLib(c, shortsActionCtx); }}
                        disabled={clipPublishing}
                        title={isFailed ? "Retry the YouTube upload for this clip" : "Publish this Approved clip to YouTube Shorts"}
                        style={{ fontSize: "0.62rem", padding: "0 6px", borderRadius: 3, background: "var(--accent, #6366f1)", color: "#fff", border: "1px solid var(--accent, #6366f1)", fontWeight: 700, cursor: "pointer" }}
                      >{clipPublishing ? "…" : (isFailed ? "Retry" : "Publish")}</button>
                    )}
                    {isPublishing && (
                      <span style={{ fontSize: "0.62rem", color: "#a78bfa" }}>uploading…</span>
                    )}
                    {isPublished && ytLoc?.external_url && discordChannel && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void pushToDiscord("clip", {
                            clipId: c.id,
                            content: `**${c.title}** (short from **${video.title}**${dateTag(video.recorded_at)})\n▶ ${ytLoc.external_url}`,
                          });
                        }}
                        disabled={pushingDiscord === c.id}
                        title="Post this published short to the series Discord channel"
                        style={{
                          fontSize: "0.62rem", padding: "0 6px", borderRadius: 3,
                          background: "rgba(88,101,242,0.12)", color: "#a5b4fc",
                          border: "1px solid rgba(88,101,242,0.28)", fontWeight: 600, cursor: "pointer",
                        }}
                      >
                        {pushingDiscord === c.id ? "💬 …" : "💬 Discord"}
                      </button>
                    )}
                    {canPreview && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenClipPreview(prev => {
                            const next = !prev[c.id];
                            // On open, refresh Opus metadata for this
                            // clip so virality + keywords reflect any
                            // updates since the clip was indexed.
                            if (next) void refreshOneShortFromOpus(c, { actorState, onEvent, onMutated });
                            return { ...prev, [c.id]: next };
                          });
                        }}
                        style={{
                          background: "none", border: "none", cursor: "pointer",
                          color: previewOpen ? "#a78bfa" : "var(--text-muted)",
                          padding: 0, fontSize: "0.65rem", textDecoration: "underline",
                        }}
                        title={previewOpen ? "Collapse the inline player" : "Play the clip inline (no round-trip to opus.pro)"}
                      >
                        {previewOpen ? "▾ hide" : "▶ preview"}
                      </button>
                    )}
                    {editUrl && (
                      <a
                        href={editUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "#a78bfa", textDecoration: "none", fontSize: "0.7rem" }}
                        title="Open in Opus Clip editor"
                      >
                        ↗
                      </a>
                    )}
                  </div>
                  {previewOpen && canPreview && (
                    <div style={{ padding: "4px 4px 4px 0" }}>
                      <video
                        controls
                        preload="metadata"
                        src={c.download_url}
                        style={{
                          maxWidth: 260, maxHeight: 460,
                          width: "100%", height: "auto",
                          background: "#000", borderRadius: 6,
                        }}
                      />
                    </div>
                  )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Locations */}
      {video.locations && video.locations.length > 0 && (
        <div className="locations-section">
          {video.locations.map((loc) => {
            // Normalise the "youtube-" convention prefix on source_id
            // when matching a Location against catalog rows. YouTube
            // ingest stores source_id as "youtube-<id>" but Location
            // rows carry the bare "<id>". Without this, YouTube
            // Destinations always show as "not in catalog" even when
            // the target record exists.
            const stripYt = (s: string) => s.startsWith("youtube-") ? s.slice("youtube-".length) : s;
            const locBareId = stripYt(loc.external_id);
            const isSelf = loc.platform === video.source_platform
              && (loc.external_id === video.source_id || locBareId === stripYt(video.source_id));
            const linked = isSelf
              ? video
              : (allVideos ?? []).find(v =>
                  v.source_platform === loc.platform
                  && (v.source_id === loc.external_id || stripYt(v.source_id) === locBareId),
                );
            const fmtDur = (secs: number) => {
              if (!secs) return "—";
              const h = Math.floor(secs / 3600);
              const m = Math.floor((secs % 3600) / 60);
              const s = Math.floor(secs % 60);
              return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
            };
            const fmtTime = (iso: string | null | undefined) => {
              if (!iso) return "—";
              const d = new Date(iso);
              if (isNaN(d.getTime())) return "—";
              return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
            };
            return (
            <div key={`${loc.platform}-${loc.external_id}`} className="location-row" style={{ flexWrap: "wrap" }}>
              <span className="location-platform">{loc.platform}</span>
              {(() => {
                const href = resolveExternalUrl(loc.external_url);
                return href ? (
                  <a
                    className="location-link"
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {loc.external_id}
                  </a>
                ) : (
                  <span style={{ fontSize: "0.8rem" }}>{loc.external_id}</span>
                );
              })()}
              <span className={`location-role role-${loc.role}`}>{loc.role}</span>
              {loc.status && (
                <span className="location-status">{loc.status}</span>
              )}
              {linked && !isSelf ? (
                <button
                  onClick={() => onNavigateToVideo?.(linked.id)}
                  style={{
                    background: "none", border: "none", padding: 0, cursor: "pointer",
                    color: "var(--text)", fontSize: "0.75rem", textAlign: "left",
                    flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                    whiteSpace: "nowrap", textDecoration: "underline",
                  }}
                  title="Jump to the catalog record for this location"
                >
                  {linked.title}
                </button>
              ) : linked && isSelf ? (
                <span style={{
                  fontSize: "0.72rem", color: "var(--text-muted)", fontStyle: "italic",
                  flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }} title="This location is this record's own source">
                  (this record)
                </span>
              ) : (
                <span style={{
                  fontSize: "0.72rem", color: "var(--text-muted)", fontStyle: "italic",
                  flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }} title="No catalog record for this external id — publication-only endpoint">
                  (not in catalog)
                </span>
              )}
              {linked && (
                <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }} title={formatDateHover(linked.recorded_at || linked.indexed_at)}>
                  🕐 {fmtTime(linked.recorded_at || linked.indexed_at)}
                </span>
              )}
              {linked && (
                <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }} title="Duration">
                  ⏱ {fmtDur(linked.duration_seconds)}
                </span>
              )}
              {loc.platform === "YouTube" && loc.role === "Destination" && (
                <button
                  className="btn btn-sm"
                  style={{ padding: "1px 6px", fontSize: "0.7rem" }}
                  onClick={() => checkYouTubeStatus(loc)}
                  disabled={checkingStatus === loc.external_id}
                >
                  {checkingStatus === loc.external_id ? "..." : "Check Status"}
                </button>
              )}
              <button
                className="location-remove"
                onClick={() => removeLocation(loc)}
                title="Remove location"
              >
                x
              </button>
            </div>
            );
          })}
          {!showLocationForm && (
            <button
              className="btn btn-sm"
              style={{ marginTop: 6 }}
              onClick={() => setShowLocationForm(true)}
            >
              + Location
            </button>
          )}
          {showLocationForm && (
            <div className="location-add-form">
              <select value={locPlatform} onChange={(e) => setLocPlatform(e.target.value)}>
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <input
                placeholder="External ID"
                value={locExternalId}
                onChange={(e) => setLocExternalId(e.target.value)}
              />
              <input
                placeholder="URL (optional)"
                value={locExternalUrl}
                onChange={(e) => setLocExternalUrl(e.target.value)}
              />
              <select value={locRole} onChange={(e) => setLocRole(e.target.value)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              <button className="btn btn-sm btn-primary" onClick={addLocation}>Add</button>
              <button className="btn btn-sm" onClick={() => setShowLocationForm(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {/* Provenance */}
      {showProvenance && (
        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6, padding: "10px 12px", marginBottom: 8, fontSize: "0.78rem" }}>
          <div style={{ fontWeight: 600, color: "var(--accent)", marginBottom: 6, fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Upstream provenance
          </div>
          {(!video.upstream_links || video.upstream_links.length === 0) ? (
            <div style={{ color: "var(--text-muted)", fontSize: "0.72rem", marginBottom: 6, fontStyle: "italic" }}>
              None — this record is a source of truth (no upstream links).
              For where it lives + where it&apos;s been published, see the Locations panel below.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
              {video.upstream_links.map((link) => {
                // Resolve the linked record so we can show its
                // title, start-time, duration, and transcript
                // availability instead of just a platform/id pair.
                // Handles the YouTube "youtube-<id>" source_id
                // prefix on both sides (link.external_id can be bare
                // or prefixed depending on ingest path).
                const stripYt2 = (s: string) => s.startsWith("youtube-") ? s.slice("youtube-".length) : s;
                const linkBareId = stripYt2(link.external_id);
                const linked = (allVideos ?? []).find(v =>
                  (link.video_id && v.id === link.video_id)
                  || (v.source_platform === link.platform
                      && (v.source_id === link.external_id || stripYt2(v.source_id) === linkBareId)),
                );
                const fmtDur = (secs: number) => {
                  if (!secs) return "—";
                  const h = Math.floor(secs / 3600);
                  const m = Math.floor((secs % 3600) / 60);
                  const s = Math.floor(secs % 60);
                  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
                };
                const fmtTime = (iso: string | null | undefined) => {
                  if (!iso) return "—";
                  const d = new Date(iso);
                  if (isNaN(d.getTime())) return "—";
                  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
                };
                const hasOwnTranscript = linked && (linked.transcript_text?.length ?? 0) >= 200;
                const hasBorrowedTranscript = linked && !hasOwnTranscript
                  && !!resolveTranscriptForOperation(linked, allVideos ?? [linked]);
                return (
                <div
                  key={`${link.platform}-${link.external_id}`}
                  style={{
                    display: "flex", flexDirection: "column", gap: 3,
                    padding: "6px 8px", borderRadius: 4,
                    background: "var(--bg)", border: "1px solid var(--border)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{
                      fontSize: "0.62rem", padding: "1px 6px", borderRadius: 3,
                      background: "rgba(99,102,241,0.15)", color: "var(--accent)",
                      fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em",
                    }}>{derivationLabel(link.relation)}</span>
                    <span style={{ fontWeight: 600, fontSize: "0.75rem" }}>{link.platform}</span>
                    {linked ? (
                      <button
                        onClick={() => onNavigateToVideo?.(linked.id)}
                        style={{
                          background: "none", border: "none", padding: 0, cursor: "pointer",
                          color: "var(--text)", fontSize: "0.75rem", textAlign: "left",
                          flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                          whiteSpace: "nowrap", textDecoration: "underline",
                        }}
                        title="Jump to this record's card"
                      >
                        {linked.title}
                      </button>
                    ) : (
                      <span style={{ fontStyle: "italic", color: "var(--text-muted)", fontSize: "0.72rem", flex: 1 }}>
                        (not in catalog) <span style={{ fontFamily: "monospace" }}>{link.external_id}</span>
                      </span>
                    )}
                    <span style={{ color: "var(--text-muted)", fontSize: "0.62rem" }}>{linkOriginLabel(link.linked_by)}</span>
                    <button
                      className="btn btn-sm"
                      style={{ padding: "1px 6px", fontSize: "0.62rem" }}
                      onClick={() => removeUpstreamLink(link, false)}
                      title="Remove link"
                    >
                      Remove
                    </button>
                    <button
                      className="btn btn-sm btn-red"
                      style={{ padding: "1px 6px", fontSize: "0.62rem" }}
                      onClick={() => removeUpstreamLink(link, true)}
                      title="Reject — suppress future auto-suggestions"
                    >
                      Reject
                    </button>
                  </div>
                  {linked && (
                    <div style={{ display: "flex", gap: 12, fontSize: "0.7rem", color: "var(--text-muted)", flexWrap: "wrap" }}>
                      <span title={formatDateHover(linked.recorded_at || linked.indexed_at)}>
                        🕐 {fmtTime(linked.recorded_at || linked.indexed_at)}
                      </span>
                      <span title="Duration">⏱ {fmtDur(linked.duration_seconds)}</span>
                      <span title={
                        hasOwnTranscript ? `Own transcript (${Math.round((linked.transcript_text?.length ?? 0) / 5)} words est.)`
                        : hasBorrowedTranscript ? "Borrowed transcript via ADR-053 provenance"
                        : "No transcript"
                      }>
                        {hasOwnTranscript ? "📄 own"
                         : hasBorrowedTranscript ? "📄 borrowed"
                         : "✗ no transcript"}
                      </span>
                      {link.account_hint && <span>({link.account_hint})</span>}
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          )}
          {!showLinkForm ? (
            <button className="btn btn-sm" style={{ fontSize: "0.7rem" }} onClick={() => setShowLinkForm(true)}>
              + Link upstream
            </button>
          ) : (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
              <select value={linkPlatform} onChange={(e) => setLinkPlatform(e.target.value)} style={{ fontSize: "0.75rem" }}>
                {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <input
                placeholder="External ID"
                value={linkExternalId}
                onChange={(e) => setLinkExternalId(e.target.value)}
                style={{ fontSize: "0.75rem", flex: 1, minWidth: 120 }}
              />
              <select value={linkRelation} onChange={(e) => setLinkRelation(e.target.value)} style={{ fontSize: "0.75rem" }}>
                <option value="SameEvent">Same session</option>
                <option value="TranscribedFrom">Transcribed from</option>
                <option value="ScreenRecordingOf">Screen recording of</option>
                <option value="ClipOf">Clip of</option>
              </select>
              <button className="btn btn-sm btn-primary" style={{ fontSize: "0.7rem" }} onClick={addUpstreamLink}>Add</button>
              <button className="btn btn-sm" style={{ fontSize: "0.7rem" }} onClick={() => setShowLinkForm(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {/* Notes */}
      {(video.notes.length > 0 || showNotes) && (
        <div className="notes-section">
          {video.notes.map((note) => (
            <div key={note.id} className="note">
              {note.text}{" "}
              <span style={{ fontSize: "0.7rem" }}>— {formatDate(note.created_at)}</span>
            </div>
          ))}
          <div className="note-input">
            <input
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addNote()}
              placeholder="Add a note..."
            />
            <button className="btn btn-sm" onClick={addNote}>
              Add
            </button>
          </div>
        </div>
      )}

      {/* Fireflies publish warnings */}
      {showPreview && video.source_platform === "Fireflies" && (
        <>
          <div style={{ fontSize: "0.75rem", color: "#f5a623", background: "var(--bg-card)", border: "1px solid #f5a623", borderRadius: 6, padding: "6px 10px", marginBottom: 6 }}>
            Fireflies CDN URLs expire. Download the video file from Fireflies and upload manually, or use the original Zoom recording instead.
          </div>
          {(!video.upstream_links || video.upstream_links.length === 0) && (
            <div style={{ fontSize: "0.75rem", color: "#f5a623", background: "var(--bg-card)", border: "1px solid #f5a623", borderRadius: 6, padding: "6px 10px", marginBottom: 8 }}>
              No linked Zoom recording — Fireflies recordings start when the bot joins, which may be before the session goes live (e.g. pre-meeting coordination). Consider setting a trim offset or linking the Zoom source via Provenance.
            </div>
          )}
        </>
      )}

      {/* Publish preview — shown after preparePublish() */}
      {showPreview && publishAttrs && (
        <div className="rule-form" style={{ marginBottom: 8 }}>
          <div style={{ fontSize: "0.7rem", color: "var(--accent)", marginBottom: 6, fontWeight: 600 }}>
            Publish preview — confirm before uploading
          </div>
          <div className="form-field">
            <label>Title</label>
            <input
              value={publishAttrs.title}
              onChange={(e) => setPublishAttrs({ ...publishAttrs, title: e.target.value })}
            />
          </div>
          <div className="form-field">
            <label>Description</label>
            <textarea
              value={publishAttrs.description}
              onChange={(e) => setPublishAttrs({ ...publishAttrs, description: e.target.value })}
              rows={3}
              style={{ width: "100%", fontSize: "0.75rem", padding: "6px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", resize: "vertical" }}
            />
          </div>
          <div className="form-field">
            <label>Tags (comma-separated)</label>
            <input
              value={publishAttrs.tags.join(", ")}
              onChange={(e) =>
                setPublishAttrs({
                  ...publishAttrs,
                  tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean),
                })
              }
            />
          </div>
          <div className="form-field">
            <label>Privacy</label>
            <select
              value={publishAttrs.privacy_status}
              onChange={(e) => setPublishAttrs({ ...publishAttrs, privacy_status: e.target.value as PublishAttributes["privacy_status"] })}
              style={{ width: "100%", fontSize: "0.75rem", padding: "6px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)" }}
            >
              <option value="unlisted">Unlisted</option>
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </div>
          {/* Trim offset */}
          <div className="form-field">
            <label>Trim start (seconds)</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="number"
                min={0}
                value={publishAttrs.trim_start_seconds}
                onChange={(e) => setPublishAttrs({ ...publishAttrs, trim_start_seconds: Math.max(0, parseInt(e.target.value) || 0) })}
                style={{ width: 90 }}
              />
              {publishAttrs.trim_start_seconds > 0 && (
                <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                  {Math.floor(publishAttrs.trim_start_seconds / 60)}m {publishAttrs.trim_start_seconds % 60}s skipped from start
                </span>
              )}
              {publishAttrs.trim_start_seconds === 0 && (
                <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>no trim</span>
              )}
            </div>
            {publishAttrs.trim_start_seconds > 600 && (
              <div style={{ fontSize: "0.72rem", color: "#f5a623", marginTop: 4 }}>
                ⚠ Trimming {Math.round(publishAttrs.trim_start_seconds / 60)} minutes — confirm this is correct, or set to 0 to upload without trim.
              </div>
            )}
          </div>

          <div className="form-actions" style={{ flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginRight: 6 }}>Publish to:</span>
            <button className="btn btn-sm btn-green" onClick={publishToYouTube}>
              YouTube
            </button>
            <button className="btn btn-sm btn-green" onClick={publishToKaltura} title="Phase 1: single destination per Publish click. Run again to add Kaltura after YouTube.">
              Kaltura
            </button>
            <button className="btn btn-sm" onClick={() => { setShowPreview(false); setPublishAttrs(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Generate Shorts modal */}
      {showShortsModal && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "12px 14px", marginBottom: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: "0.9rem" }}>Generate Shorts via Opus Clip</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {/* ADR-062 — stitched source toggle. When on AND the
                record has a current summary, we build a mp4 of
                (main-show window + each summary highlight) and hand
                Opus THAT URL. Only this actually reduces credit
                spend — curationPref.range narrows candidates but
                Opus still bills by source duration. */}
            {video.summary_doc_id ? (
              <label
                style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: "0.85rem", padding: "6px 8px", background: "rgba(20,184,166,0.06)", border: "1px solid rgba(20,184,166,0.28)", borderRadius: 4 }}
                title="ADR-062: build a source that is (main-show window) + (summary highlights, ±30s / +90s each). Opus bills by source duration so this is the only way to cut credit spend without losing post-show gems."
              >
                <input type="checkbox" checked={shortsUseStitched} onChange={(e) => setShortsUseStitched(e.target.checked)} style={{ marginTop: 3 }} />
                <span>
                  <strong>✂️ Stitched source</strong> (main show + summary highlights)
                  {stitchPreview
                    ? <> · preview: {stitchPreview.regions} region{stitchPreview.regions === 1 ? "" : "s"} = {Math.round(stitchPreview.totalSec / 60)}m (vs source {Math.round(video.duration_seconds / 60)}m)</>
                    : <> · click "Preview regions" for the region count</>}
                  <button
                    type="button"
                    onClick={async () => {
                      const opusRule = publishAttrs ?? applyProcessingRules(loadProcessingRules(), video);
                      const trimS = Math.max(0, Math.floor(opusRule.trim_start_seconds ?? 0));
                      const trimE = Math.max(0, Math.floor((opusRule as { trim_end_seconds?: number }).trim_end_seconds ?? 0));
                      const msStart = trimS > 0 ? trimS : 0;
                      const msEnd = trimE > 0 && video.duration_seconds > trimE ? video.duration_seconds - trimE : video.duration_seconds;
                      const res = await fetch("/api/shorts/preview-regions", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          record_id: video.id,
                          summary_doc_id: video.summary_doc_id,
                          source_duration_sec: video.duration_seconds,
                          main_show_start_sec: msStart,
                          main_show_end_sec: msEnd,
                        }),
                      });
                      if (res.ok) {
                        const d = await res.json() as { regions: unknown[]; total_stitched_sec: number; extracted_highlights: number };
                        setStitchPreview({ regions: d.regions.length, totalSec: d.total_stitched_sec, highlights: d.extracted_highlights });
                      } else {
                        const d = await res.json().catch(() => ({} as { error?: string }));
                        onEvent(`StitchPreviewFailed: ${(d as { error?: string }).error ?? `HTTP ${res.status}`}`, { video_id: video.id });
                      }
                    }}
                    disabled={shortsLoading}
                    style={{ marginLeft: 8, background: "none", border: "none", color: "#a5b4fc", cursor: "pointer", padding: 0, textDecoration: "underline", fontSize: "0.72rem" }}
                  >
                    Preview regions
                  </button>
                </span>
              </label>
            ) : (
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", padding: "4px 0" }}>
                ✂️ Stitched source unavailable — generate a summary first to enable "main show + highlights" mode. (Falling back to full-source URL; Opus will bill for the entire {Math.round(video.duration_seconds / 60)}m recording.)
              </div>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.85rem" }}>
              <input type="checkbox" checked={shortsCaption} onChange={(e) => setShortsCaption(e.target.checked)} />
              Burn captions into clips
            </label>
            <div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 4 }}>
                Clip prompt (optional — e.g. "moments with audience questions")
              </div>
              <input
                type="text"
                value={shortsPrompt}
                onChange={(e) => setShortsPrompt(e.target.value)}
                placeholder="Leave blank for AI to decide"
                style={{ width: "100%", padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: "0.8rem" }}
              />
            </div>
            {shortsError && (
              <div style={{ fontSize: "0.8rem", color: "var(--red)" }}>{shortsError}</div>
            )}
            {shortsLoading && (
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{shortsPhase || "Working…"}</div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-sm btn-primary" onClick={generateShorts} disabled={shortsLoading}>
                {shortsLoading ? "Running…" : "Generate"}
              </button>
              <button className="btn btn-sm" onClick={() => { setShowShortsModal(false); setShortsError(null); }} disabled={shortsLoading}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showRecover && (
        <div style={{ marginTop: 10, padding: 10, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <div style={{ fontSize: "0.78rem", fontWeight: 600 }}>Recover from YouTube</div>
            <button
              className="btn btn-sm"
              style={{ fontSize: "0.7rem" }}
              onClick={() => lookupOnYouTube(false)}
              disabled={lookupLoading || recovering}
              title="Search the connected YouTube channel's uploads for a match by title and date"
            >
              {lookupLoading ? "Searching…" : (lookupCandidates ? "Re-search" : "Auto-lookup on YouTube")}
            </button>
          </div>

          {/* Candidate list from auto-lookup */}
          {lookupCandidates && lookupCandidates.length > 0 && (
            <div style={{ marginBottom: 10, display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 2 }}>
                {lookupCandidates.length === 1 ? "Suggested match:" : "Top matches:"}
              </div>
              {lookupCandidates.map((c: MatchCandidate) => (
                <div
                  key={c.upload.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto auto auto",
                    gap: 8,
                    padding: "6px 8px",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    alignItems: "center",
                  }}
                >
                  <a
                    href={`https://www.youtube.com/watch?v=${c.upload.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open this YouTube video in a new tab to verify before linking"
                    style={{
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.78rem",
                      color: "var(--text)", textDecoration: "none",
                      display: "flex", alignItems: "center", gap: 4,
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.upload.title}</span>
                    <span style={{ color: "var(--text-muted)", fontSize: "0.7rem", flexShrink: 0 }}>↗</span>
                  </a>
                  <div style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>
                    {c.upload.publishedAt ? c.upload.publishedAt.slice(0, 10) : ""}
                    {c.dateDeltaDays != null && c.dateDeltaDays <= 31 && <span style={{ color: "var(--green)", marginLeft: 4 }}>✓</span>}
                  </div>
                  <div style={{ fontSize: "0.68rem", color: "var(--text-muted)" }} title={`Score: ${c.score.toFixed(2)} (title ${c.titleScore.toFixed(2)})`}>
                    {Math.round(c.score * 100)}%
                  </div>
                  <button
                    className="btn btn-sm btn-primary"
                    style={{ fontSize: "0.68rem", padding: "2px 8px" }}
                    onClick={() => recoverFromYouTube(c.upload.id)}
                    disabled={recovering}
                  >
                    Use this
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Manual paste fallback */}
          <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: 6 }}>
            Or paste a watch URL / Studio URL / 11-char ID:
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              value={recoverInput}
              onChange={e => setRecoverInput(e.target.value)}
              placeholder="https://youtube.com/watch?v=... or yxOw48ZBM8I"
              style={{ flex: 1, padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: "0.8rem" }}
              disabled={recovering}
            />
            <button
              className="btn btn-sm btn-primary"
              onClick={() => recoverFromYouTube(recoverInput)}
              disabled={recovering || !recoverInput.trim()}
            >
              {recovering ? "Recovering…" : "Recover"}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => { setShowRecover(false); setRecoverInput(""); setRecoverError(null); setLookupCandidates(null); }}
              disabled={recovering}
            >
              Cancel
            </button>
          </div>
          {recoverError && (
            <div style={{ marginTop: 6, fontSize: "0.72rem", color: "var(--red)" }}>{recoverError}</div>
          )}
        </div>
      )}

      {showLog && (
        <div style={{ marginTop: 10, padding: 10, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6, maxHeight: 240, overflowY: "auto" }}>
          <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 6, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>
            Event Log — this video ({videoLog.length})
          </div>
          {videoLog.length === 0 ? (
            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontStyle: "italic" }}>
              No events yet for this video.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {[...videoLog].reverse().map((r, i) => (
                <div key={i} style={{ fontFamily: "monospace", fontSize: "0.7rem", display: "flex", gap: 6 }}>
                  <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{r.ts.slice(11, 19)}</span>
                  <span style={{ color: r.level === "error" ? "var(--red)" : r.level === "warn" ? "#fbbf24" : "var(--text-muted)", flexShrink: 0, width: 38 }}>
                    {r.level}
                  </span>
                  <span>{r.msg}</span>
                  {r.error && <span style={{ color: "var(--red)" }}>— {r.error}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="video-card-actions">
        {video.source_platform !== "OpusClip" && (
          <button
            className="btn btn-sm"
            onClick={() => realignTitle(false)}
            disabled={realigning}
            style={{ fontSize: "0.72rem" }}
            title="Re-run ADR-055 title alignment on this record (paired-canonical → series-registry → alias against the original title). No YouTube push."
          >
            {realigning ? "Realigning…" : "🏷 Realign title"}
          </button>
        )}
        {video.source_platform !== "OpusClip" && (video.locations ?? []).some(l => l.platform === "YouTube" && l.external_id) && (
          <button
            className="btn btn-sm"
            onClick={pushTitleAndDescriptionToYouTube}
            disabled={pushingYt}
            style={{ fontSize: "0.72rem" }}
            title="PUT this record's current local title AND description to the actual YouTube video via videos.update. Idempotent — no-op if both already match. Requires the youtube.force-ssl OAuth scope (reconnect YouTube in Connections if you see 'scope missing')."
          >
            {pushingYt ? "↗ Pushing…" : "↗ Push title + description to YouTube"}
          </button>
        )}
        {canApprove && (
          <button className="btn btn-sm btn-green" onClick={approve}>
            Approve
          </button>
        )}
        {canApprove && (
          <button className="btn btn-sm" onClick={toggleAttrsPreview} style={{ fontSize: "0.72rem" }}>
            {showAttrsPreview ? "Hide preview" : "Preview"}
          </button>
        )}
        {canScope && (
          <button className="btn btn-sm btn-primary" onClick={markInScope}>
            In Scope
          </button>
        )}
        {canSkip && (
          <button className="btn btn-sm" onClick={skip}>
            Skip
          </button>
        )}
        {canExclude && (
          <button className="btn btn-sm btn-red" onClick={exclude}>
            Exclude
          </button>
        )}
        {canPublish && !alreadyPublished && (
          <button className="btn btn-sm btn-primary" onClick={requestPublish}>
            Publish
          </button>
        )}
        {canPublish && alreadyPublished && (
          <button
            className="btn btn-sm btn-green"
            onClick={markAsAlreadyPublished}
            title="This record is Approved and already has a YouTube destination. Mark it Published so it leaves the Active list."
          >
            Already on YouTube — mark Published
          </button>
        )}
        {canSidePublishKaltura && (
          <button
            className="btn btn-sm btn-green"
            onClick={publishToKaltura}
            disabled={uploading}
            title="Add this video to Kaltura too — keeps the YouTube copy as-is"
          >
            {uploading ? "Uploading…" : "Publish to Kaltura"}
          </button>
        )}
        {canRetry && (
          <button className="btn btn-sm btn-yellow" onClick={markToRetry}>
            Retry
          </button>
        )}
        {canRecover && (
          <button
            className="btn btn-sm"
            onClick={() => { setShowRecover(v => !v); setRecoverError(null); }}
            title="Already uploaded to YouTube? Link the existing video and mark this Published."
          >
            Recover from YouTube
          </button>
        )}
        {canAbandon && (
          <button className="btn btn-sm" onClick={abandonVideo}>
            Abandon
          </button>
        )}
        {isPublishing && (
          <>
            {uploading ? (
              <span className="upload-progress">{uploadPhase}</span>
            ) : showPreview && publishAttrs ? (
              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                Preview ready ↓
              </span>
            ) : (
              <button className="btn btn-sm btn-primary" onClick={preparePublish}>
                Publish…
              </button>
            )}
            <button className="btn btn-sm btn-red" onClick={markFailed} disabled={uploading}>
              Mark Failed
            </button>
          </>
        )}
        {canGenerateShorts && (
          <button
            className="btn btn-sm"
            style={{ fontSize: "0.72rem" }}
            onClick={() => { setShowShortsModal((v) => !v); setShortsError(null); }}
          >
            ✂ Shorts
          </button>
        )}
        {(() => {
          const hasTranscript = !!video.transcript_text && video.transcript_text.length > 200;
          const disabled = summarising || !hasTranscript;
          const hasYouTubeLoc = (video.locations ?? []).some(l => l.platform === "YouTube" && l.external_id);
          // ADR-053 — if the record itself has no transcript, another
          // paired record (Fireflies via TranscribedFrom, or a Zoom
          // canonical via SameEvent) may have one. Surface a hint
          // instead of hiding the button so the operator can act.
          const noTranscriptHint = hasYouTubeLoc
            ? "This record has no transcript ≥200 chars. Try 📥 Fetch from YouTube (progressive-reach: official captions API → public timedtext → yt-dlp), link a SameEvent sibling with a transcript, or upload one manually."
            : "This record has no transcript ≥200 chars. Fix by: (1) hydrating a paired Fireflies/Kaltura record via Import, (2) linking a SameEvent sibling on this card's Provenance panel that has one, or (3) uploading a transcript manually (see docs).";
          return (
            <>
              <button
                className="btn btn-sm"
                style={{ fontSize: "0.72rem", ...(disabled && !summarising ? { opacity: 0.55 } : {}) }}
                onClick={generateSummary}
                disabled={disabled}
                title={hasTranscript
                  ? (video.summary_doc_id
                      ? `Regenerate Show Notes (current: prompt v${video.summary_prompt_version ?? "?"})`
                      : "Generate Show Notes (chapter-oriented Drive doc — ADR-046) — M:Moments, L:Learnings, T:Themes, C:Chat-Sparked")
                  : noTranscriptHint}
              >
                {summarising
                  ? "📄 Generating…"
                  : hasTranscript
                    ? (video.summary_doc_id ? "📄 Regenerate Show Notes" : "📄 Show Notes")
                    : "📄 Show Notes (no transcript — hover)"}
              </button>
              {!hasTranscript && hasYouTubeLoc && (
                <button
                  className="btn btn-sm"
                  style={{ fontSize: "0.72rem" }}
                  onClick={fetchTranscriptFromYouTube}
                  disabled={fetchingYtTranscript}
                  title="Progressive-reach fetch: 1) official YouTube captions API (owned videos), 2) public timedtext scrape, 3) yt-dlp auto-subs. Uses the first that succeeds."
                >
                  {fetchingYtTranscript ? "📥 Fetching…" : "📥 Fetch from YouTube"}
                </button>
              )}
              {ytTranscriptError && (
                <span style={{ color: "var(--red)", fontSize: "0.7rem" }} title={ytTranscriptError}>
                  YT fetch: {ytTranscriptError.slice(0, 80)}{ytTranscriptError.length > 80 ? "…" : ""}
                </span>
              )}
            </>
          );
        })()}
        {video.summary_doc_id && discordChannel && (
          <button
            className="btn btn-sm"
            style={{ fontSize: "0.72rem" }}
            onClick={() => pushToDiscord("summary", {
              content: `**${video.title}**${dateTag(video.recorded_at)}\n📄 Show Notes: https://docs.google.com/document/d/${video.summary_doc_id}${
                (video.locations ?? []).find(l => l.platform === "YouTube" && l.role === "Destination" && l.external_url)?.external_url
                  ? `\n▶ Watch: ${(video.locations ?? []).find(l => l.platform === "YouTube" && l.role === "Destination" && l.external_url)!.external_url}`
                  : ""
              }`,
            })}
            disabled={pushingDiscord === "summary"}
            title={`Post this record's summary link to the series Discord channel (${discordChannel.replace(/https:\/\/(?:.*\.)?discord(?:app)?\.com\/api\/webhooks\//i, "…/")})`}
          >
            {pushingDiscord === "summary" ? "💬 Pushing…" : "💬 Push Show Notes to Discord"}
          </button>
        )}
        {/* ADR-046 slice 5 — Lock toggle. Only relevant once a summary
            exists; before that, locking a non-existent summary does
            nothing useful. */}
        {video.summary_doc_id && (
          <button
            className="btn btn-sm"
            style={{ fontSize: "0.72rem" }}
            onClick={toggleSummaryLock}
            title={video.summary_locked
              ? "Locked — bulk regen skips this record. Click to unlock so the next prompt bump rewrites it."
              : "Lock the summary so the next prompt-bump bulk regen doesn't overwrite hand edits."}
          >
            {video.summary_locked ? "🔒 Unlock summary" : "🔓 Lock summary"}
          </button>
        )}
        {summaryError && (
          <span style={{ fontSize: "0.7rem", color: "var(--red)", marginLeft: 4 }}>
            Summary error: {summaryError.slice(0, 90)}
          </span>
        )}
        <button
          className="btn btn-sm"
          style={{ fontSize: "0.72rem" }}
          onClick={() => setShowProvenance((v) => !v)}
        >
          {showProvenance ? "Hide provenance" : "Provenance"}
        </button>
        <button
          className="btn btn-sm"
          style={{ fontSize: "0.72rem" }}
          onClick={() => { setShowLog(v => !v); setLogTick(t => t + 1); }}
          title="Show events scoped to this video"
        >
          {showLog ? "Hide log" : "Log"}
        </button>
        {!showNotes && video.notes.length === 0 && (
          <button className="btn btn-sm" onClick={() => setShowNotes(true)}>
            + Note
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm btn-red"
          style={{ marginLeft: "auto" }}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </button>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this record?"
        description={`"${video.title}"${dateTag(video.recorded_at)} will be removed from the catalog. This cannot be undone — the record's history is preserved in the audit log but the card disappears.`}
        confirmLabel="Delete"
        onConfirm={() => {
          videoStore.remove(video.id);
          onEvent(`VideoDeleted: "${video.title}"${dateTag(video.recorded_at)}`, { video_id: video.id });
          setConfirmDelete(false);
          onMutated();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
      {/* ADR-069 follow-up: screen-reader announcements for async operations
          on this card. Individual mutations (regen, push-to-YouTube, transcript
          fetch, publish) can setStatusMessage(...) to surface progress /
          success / error without a visual toast. Cleared by the next mutation
          or when the card unmounts. */}
      <div role="status" aria-live="polite" className="visually-hidden">
        {statusMessage}
      </div>
    </div>
  );
}
