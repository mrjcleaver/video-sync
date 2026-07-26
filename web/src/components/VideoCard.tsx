"use client";

import { useState, useMemo } from "react";
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
  // ADR-036: derive actor from IAP JWT via /api/auth/me. Falls back to the
  // synthetic admin during boot or in dev mode (ALLOW_NO_IAP=1) so single-
  // user behaviour is preserved until IAP is configured. Throws on auth
  // error (state.error) so the click handler surfaces via ErrorBoundary
  // rather than silently mutating as the synthetic admin.
  const actorState = useCurrentActor();
  const cmd = (extra?: Record<string, unknown>) => actorCommand(actorState, extra);
  const [noteText, setNoteText] = useState("");
  const [showNotes, setShowNotes] = useState(false);
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
  const [showAttrsPreview, setShowAttrsPreview] = useState(false);
  const [attrsPreview, setAttrsPreview] = useState<PublishAttributes | null>(null);
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
  const [shortsCaption, setShortsCaption] = useState(true);
  const [shortsPrompt, setShortsPrompt] = useState("");
  const [shortsLoading, setShortsLoading] = useState(false);
  const [shortsError, setShortsError] = useState<string | null>(null);
  const [shortsPhase, setShortsPhase] = useState("");
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
      // Surface the outgoing URL in the client event log so a 4xx from
      // Opus can be diagnosed from the dashboard without opening Cloud
      // Logging. Paired with the ShortsError line on failure.
      onEvent(`ShortsRequested: "${video.title}"${dateTag(video.recorded_at)} → ${parentYouTubeUrl}${shortsPrompt ? ` (prompt: ${shortsPrompt.slice(0, 40)}${shortsPrompt.length > 40 ? "…" : ""})` : ""}`, { video_id: video.id });
      const genRes = await fetch("/api/shorts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentYouTubeUrl,
          videoTitle: video.title,
          captions: shortsCaption,
          prompt: shortsPrompt || undefined,
          apiKey: opusApiKey,
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
      const res = await fetch("/api/summary/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          record_id: video.id,
          title: video.title,
          source_platform: video.source_platform,
          source_id: video.source_id,
          recorded_at: video.recorded_at ?? video.indexed_at,
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
    let attrs = applyProcessingRules(rules, video);

    // If any rule uses transcript_llm and we have a transcript, fetch summary
    const needsLlm = rules.some(
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
        attrs = applyProcessingRules(rules, enriched);
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
      alert("YouTube not authorized. Configure and authorize YouTube in Connections first.");
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
      setRecoverError("YouTube not authorised. Configure in Connections first.");
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
  async function generateDescriptionFromTranscript() {
    if (!video.transcript_text || video.transcript_text.length < 200) {
      setDescriptionError("Transcript is too short or missing.");
      return;
    }
    setGeneratingDescription(true);
    setDescriptionError(null);
    try {
      const result = await requestLlmSummary(video.transcript_text);
      const description = result.summary?.trim();
      if (!description) throw new Error("LLM returned no summary text");
      videoStore.mutate(video.id, (r) =>
        r.update_metadata(cmd({ edits: { description } })),
      );
      onEvent(`DescriptionGenerated: "${video.title}"${dateTag(video.recorded_at)} (${description.length} chars)`, { video_id: video.id });
      onMutated();
    } catch (err) {
      setDescriptionError(err instanceof Error ? err.message : String(err));
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
      alert("YouTube not authorized. Configure YouTube in Connections first.");
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
    const attrs = applyProcessingRules(loadProcessingRules(), video);
    setAttrsPreview(attrs);
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
          <h3 style={{ margin: 0 }}>{previewTitle ?? video.title}</h3>
          {previewTitle && (
            <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: 2, fontStyle: "italic" }}>
              {video.title}
            </div>
          )}
        </div>
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
          background: "rgba(168,85,247,0.08)", border: "1px solid rgba(168,85,247,0.25)", borderRadius: 6,
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
        <span title={`${Math.floor(video.duration_seconds / 60)} min`}>{formatDuration(video.duration_seconds)}</span>
        <span>{formatDate(video.recorded_at || video.indexed_at)}</span>
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
        {pairedBroadcasts.map(p => (
          <a
            key={p.destination_record_id}
            href={`https://www.youtube.com/watch?v=${p.external_id}`}
            target="_blank"
            rel="noopener noreferrer"
            title={`Broadcast destination on YouTube Live (paired record ${p.destination_record_id.slice(0, 8)}…). Click to open.`}
            style={{
              fontSize: "0.7rem",
              padding: "1px 6px",
              borderRadius: 10,
              background: "rgba(248,113,113,0.10)",
              color: "#fb7185",
              border: "1px solid rgba(248,113,113,0.35)",
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            📺 YouTube Live · {p.external_id}
          </a>
        ))}
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
              background: "rgba(245,158,11,0.10)",
              color: "#f59e0b",
              border: "1px solid rgba(245,158,11,0.35)",
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            📝 {p.destination_platform} · {p.external_id.slice(0, 12)}…
          </a>
        ))}
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
          {video.summary_locked ? "🔒 " : ""}Summary: prompt v{video.summary_prompt_version ?? "?"}
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
        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: 8 }}>
          {video.description}
        </p>
      ) : (video.transcript_text && video.transcript_text.length >= 200) ? (
        <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: 8, fontStyle: "italic", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span>No description yet.</span>
          <button
            className="btn btn-sm"
            style={{ fontSize: "0.72rem" }}
            onClick={generateDescriptionFromTranscript}
            disabled={generatingDescription}
            title="Generate a short paragraph description from the transcript via OpenRouter. Distinct from the chapter-oriented Summary doc (ADR-046)."
          >
            {generatingDescription ? "Generating…" : "✨ Generate from transcript"}
          </button>
          {descriptionError && (
            <span style={{ color: "var(--red)" }}>Error: {descriptionError.slice(0, 100)}</span>
          )}
        </div>
      ) : null}

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
            <span style={{ color: "var(--text-muted)", fontSize: "0.7rem" }}>Privacy: </span>
            <span>{attrsPreview.privacy_status}</span>
          </div>
        </div>
      )}

      {/* Locations */}
      {video.locations && video.locations.length > 0 && (
        <div className="locations-section">
          {video.locations.map((loc) => (
            <div key={`${loc.platform}-${loc.external_id}`} className="location-row">
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
          ))}
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
            <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: 8 }}>No upstream links.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
              {video.upstream_links.map((link) => (
                <div key={`${link.platform}-${link.external_id}`} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ color: "var(--text-muted)", fontSize: "0.7rem" }}>{derivationLabel(link.relation)}</span>
                  <span style={{ fontWeight: 600 }}>{link.platform}</span>
                  <span style={{ fontFamily: "monospace", fontSize: "0.72rem" }}>{link.external_id}</span>
                  {link.account_hint && <span style={{ color: "var(--text-muted)", fontSize: "0.7rem" }}>({link.account_hint})</span>}
                  <span style={{ color: "var(--text-muted)", fontSize: "0.65rem" }}>{linkOriginLabel(link.linked_by)}</span>
                  <button
                    className="btn btn-sm"
                    style={{ padding: "1px 6px", fontSize: "0.65rem", marginLeft: "auto" }}
                    onClick={() => removeUpstreamLink(link, false)}
                    title="Remove link"
                  >
                    Remove
                  </button>
                  <button
                    className="btn btn-sm btn-red"
                    style={{ padding: "1px 6px", fontSize: "0.65rem" }}
                    onClick={() => removeUpstreamLink(link, true)}
                    title="Reject — suppress future auto-suggestions"
                  >
                    Reject
                  </button>
                </div>
              ))}
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
        {(video.transcript_text && video.transcript_text.length > 200) && (
          <button
            className="btn btn-sm"
            style={{ fontSize: "0.72rem" }}
            onClick={generateSummary}
            disabled={summarising}
            title={video.summary_doc_id
              ? `Regenerate summary (current: prompt v${video.summary_prompt_version ?? "?"})`
              : "Generate a chapter-oriented summary on Drive (ADR-046)"}
          >
            {summarising ? "📄 Summarising…" : (video.summary_doc_id ? "📄 Re-summarise" : "📄 Summarise")}
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
          className="btn btn-sm btn-red"
          style={{ marginLeft: "auto" }}
          onClick={() => {
            if (window.confirm(`Delete "${video.title}"${dateTag(video.recorded_at)}? This cannot be undone.`)) {
              videoStore.remove(video.id);
              onEvent(`VideoDeleted: "${video.title}"${dateTag(video.recorded_at)}`, { video_id: video.id });
              onMutated();
            }
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
