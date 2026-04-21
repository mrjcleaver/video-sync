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
import { resolveExternalUrl } from "../lib/urlResolver";
import { loadClientLog, type LogRecord } from "../lib/logger";
import { setPrivacy, normalisePrivacy } from "../lib/youtubePrivacyCache";
import { fetchChannelUploads, rankCandidates, getCachedUploads, type MatchCandidate } from "../lib/youtubeUploadsCache";

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

// Static admin actor for demo purposes
const ADMIN_ACTOR = JSON.stringify({
  user_id: "00000000-0000-0000-0000-000000000001",
  role: "Admin",
});

interface Props {
  video: VideoRecordJSON;
  onMutated: () => void;
  onEvent: (event: string, fields?: { video_id?: string }) => void;
  /** Switch filter (if needed) and scroll the card into view. Used on publish transitions. */
  onNavigateToVideo?: (id: string, intent?: "publish") => void;
}

export default function VideoCard({ video, onMutated, onEvent, onNavigateToVideo }: Props) {
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
  const [showLog, setShowLog] = useState(false);
  const [logTick, setLogTick] = useState(0);
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

    // Prefer the public YouTube destination URL over the download_url
    const ytLoc = (video.locations ?? []).find(
      (l) => l.platform === "YouTube" && l.role === "Destination" && l.external_url,
    );
    const parentYouTubeUrl = ytLoc?.external_url ?? null;
    const parentYouTubeId = ytLoc?.external_id ?? null;

    if (!parentYouTubeUrl) {
      setShortsError("No public YouTube URL found. Publish to YouTube first, or ensure the video is public.");
      setShortsLoading(false);
      return;
    }

    try {
      setShortsPhase("Submitting to Opus Clip…");
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

      const genData = await genRes.json() as { jobId?: string; error?: string };
      if (!genRes.ok) throw new Error(genData.error ?? `Submission failed (${genRes.status})`);
      const jobId = genData.jobId!;

      onEvent(`ShortsJobSubmitted: "${video.title}"${dateTag(video.recorded_at)} → Opus Clip job ${jobId}`, { video_id: video.id });
      setShowShortsModal(false);

      // Poll for completion (max 10 min, every 15 s)
      const maxPolls = 40;
      for (let i = 0; i < maxPolls; i++) {
        await new Promise((r) => setTimeout(r, 15_000));
        setShortsPhase(`Processing… (poll ${i + 1}/${maxPolls})`);
        const statusRes = await fetch(
          `/api/shorts/status?jobId=${encodeURIComponent(jobId)}&apiKey=${encodeURIComponent(opusApiKey)}`,
        );
        const statusData = await statusRes.json() as ShortsStatusResponse;

        if (statusData.status === "failed") throw new Error(statusData.error ?? "Opus Clip job failed");
        if (statusData.status === "completed") {
          const { indexShortClips: indexFn } = await import("./ShortsPanel");
          const count = indexFn({
            parentVideoId: video.id,
            parentSourceId: video.source_id,
            parentYouTubeId,
            jobId,
            clips: statusData.clips,
          });
          onEvent(`ShortsIndexed: ${count} clip(s) from "${video.title}"${dateTag(video.recorded_at)} — review in Shorts panel`, { video_id: video.id });
          onMutated();
          break;
        }
      }
    } catch (err) {
      setShortsError(String(err));
      onEvent(`ShortsError: "${video.title}"${dateTag(video.recorded_at)} — ${String(err)}`, { video_id: video.id });
    } finally {
      setShortsLoading(false);
      setShortsPhase("");
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
        JSON.stringify({
          actor: JSON.parse(ADMIN_ACTOR),
          edits,
        }),
      ),
    );
    onEvent(`MetadataApplied: "${video.title}"${dateTag(video.recorded_at)} ← Loom${loomInfo.description ? " (with description)" : ""}`, { video_id: video.id });
    onMutated();
  }

  function approve() {
    videoStore.mutate(video.id, (r) =>
      r.approve(JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR) }))
    );
    onEvent(`VideoApproved: "${video.title}"${dateTag(video.recorded_at)}`, { video_id: video.id });
    onMutated();
  }

  function markInScope() {
    videoStore.mutate(video.id, (r) =>
      r.mark_in_scope(
        JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR), rule_id: null })
      )
    );
    onEvent(`VideoScoped: "${video.title}"${dateTag(video.recorded_at)}`, { video_id: video.id });
    onMutated();
  }

  function skip() {
    videoStore.mutate(video.id, (r) =>
      r.skip(
        JSON.stringify({
          actor: JSON.parse(ADMIN_ACTOR),
          reason: "Skipped from dashboard",
        })
      )
    );
    onEvent(`VideoSkipped: "${video.title}"${dateTag(video.recorded_at)}`, { video_id: video.id });
    onMutated();
  }

  function exclude() {
    addExclusion(video.source_platform, video.source_id, "Manual exclusion");
    videoStore.mutate(video.id, (r) =>
      r.skip(
        JSON.stringify({
          actor: JSON.parse(ADMIN_ACTOR),
          reason: "Excluded from ingestion",
        })
      )
    );
    onEvent(`VideoExcluded: "${video.title}"${dateTag(video.recorded_at)}`, { video_id: video.id });
    onMutated();
  }

  function requestPublish() {
    videoStore.mutate(video.id, (r) =>
      r.request_publish(JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR) }))
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

      if (!result) throw new Error("Upload stream ended without a result. Check YouTube Studio.");

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

  function abandonVideo() {
    videoStore.mutate(video.id, (r) =>
      r.abandon(JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR), reason: "Abandoned from dashboard" }))
    );
    onEvent(`VideoAbandoned: "${video.title}"${dateTag(video.recorded_at)}`, { video_id: video.id });
    onMutated();
  }

  function markToRetry() {
    videoStore.mutate(video.id, (r) =>
      r.mark_to_retry(JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR), reason: "Retry requested from dashboard" }))
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
          r.approve(JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR) })),
        );
      }
      const rec = videoStore.get(video.id);
      if (rec) {
        const cur = JSON.parse(rec.to_json()).status;
        if (cur === "Approved") {
          videoStore.mutate(video.id, r =>
            r.request_publish(JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR) })),
          );
        }
      }
      videoStore.mutate(video.id, r =>
        r.mark_published(JSON.stringify({
          actor: JSON.parse(ADMIN_ACTOR),
          destination_id: ytId,
          destination_url: videoUrl,
          destination_platform: "YouTube",
        })),
      );

      onEvent(`VideoRecovered: "${video.title}"${dateTag(video.recorded_at)} -> ${videoUrl}`, { video_id: video.id });
      onMutated();
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

    let connections: Record<string, { credentials?: Record<string, string> }> = {};
    try {
      const raw = localStorage.getItem("video-sync:connections");
      if (raw) connections = JSON.parse(raw);
    } catch { /* ignore */ }

    const zoomCreds = connections["Zoom"]?.credentials;
    if (!zoomCreds?.accountId || !zoomCreds?.clientId || !zoomCreds?.clientSecret) {
      setTranscriptError("Zoom credentials not configured. Go to Connections first.");
      return;
    }

    // Extract the Zoom meeting UUID from source_id (format: "zoom-<uuid>")
    const meetingUuid = video.source_id.replace(/^zoom-/, "");

    setLoadingTranscript(true);
    setTranscriptError(null);
    try {
      const res = await fetch("/api/zoom/transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: zoomCreds.accountId,
          clientId: zoomCreds.clientId,
          clientSecret: zoomCreds.clientSecret,
          meetingUuid,
        }),
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
              JSON.stringify({
                actor: JSON.parse(ADMIN_ACTOR),
                platform: "YouTube",
                external_id: loc.external_id,
                status: data.status,
              })
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
            JSON.stringify({
              actor: JSON.parse(ADMIN_ACTOR),
              platform: "YouTube",
              external_id: loc.external_id,
              status: data.status,
            })
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
        JSON.stringify({
          actor: JSON.parse(ADMIN_ACTOR),
          platform: locPlatform,
          external_id: locExternalId.trim(),
          external_url: locExternalUrl.trim() || null,
          role: locRole,
        })
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
        JSON.stringify({
          actor: JSON.parse(ADMIN_ACTOR),
          platform: loc.platform,
          external_id: loc.external_id,
        })
      )
    );
    onEvent(`LocationRemoved: "${video.title}"${dateTag(video.recorded_at)} — ${loc.platform}/${loc.external_id}`, { video_id: video.id });
    onMutated();
  }

  function addNote() {
    if (!noteText.trim()) return;
    videoStore.mutate(video.id, (r) =>
      r.add_note(
        JSON.stringify({
          actor: JSON.parse(ADMIN_ACTOR),
          text: noteText.trim(),
        })
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
        JSON.stringify({
          actor: JSON.parse(ADMIN_ACTOR),
          platform: linkPlatform,
          external_id: linkExternalId.trim(),
          relation: linkRelation,
          linked_by: "Manual",
        })
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
        JSON.stringify({
          actor: JSON.parse(ADMIN_ACTOR),
          platform: link.platform,
          external_id: link.external_id,
          reject,
        })
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
    const ranked = rankCandidates(cached.uploads, title, video.recorded_at, 1);
    // Only surface high-confidence matches to avoid bad auto-suggestions
    if (ranked.length === 0 || ranked[0].score < 0.7) return null;
    return ranked[0];
  }, [video.status, video.locations, video.title, video.recorded_at, previewTitle]);

  const status = video.status;
  const canApprove = status === "Discovered" || status === "InScope" || status === "Failed" || status === "ToRetry";
  const canSkip = status === "Discovered" || status === "InScope";
  const canAbandon = status === "Failed" || status === "InScope" || status === "Discovered" || status === "Skipped" || status === "Published";
  const canRetry = status === "Failed" || status === "Published";
  // Recover is useful for any non-Published video that's already live on YouTube
  // (SSE-dropped uploads, out-of-band publishes, imports of existing YT content).
  const canRecover = status !== "Published" && status !== "Publishing" && status !== "Abandoned";
  const canScope = status === "Discovered";
  const canPublish = status === "Approved";
  const isPublishing = status === "Publishing";
  const canGenerateShorts = (status === "Published" || status === "Approved") && video.source_platform !== "OpusClip";
  const alreadyPublished = (video.locations ?? []).some(
    (l) => l.role === "Destination" && l.platform === "YouTube"
  );

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

      <div className="video-card-meta">
        <span>{video.source_platform}</span>
        <span title={`${Math.floor(video.duration_seconds / 60)} min`}>{formatDuration(video.duration_seconds)}</span>
        <span>{formatDate(video.recorded_at || video.indexed_at)}</span>
        {video.participants.length > 0 && (
          <span>{video.participants.length} participants</span>
        )}
      </div>

      {video.description && (
        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: 8 }}>
          {video.description}
        </p>
      )}

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

          <div className="form-actions">
            <button className="btn btn-sm btn-green" onClick={publishToYouTube}>
              Confirm &amp; Upload
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
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.78rem" }}>
                    {c.upload.title}
                  </div>
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
        {canSkip && (
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
          <span style={{ fontSize: "0.8rem", color: "var(--green)", padding: "4px 10px" }}>
            Already published
          </span>
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
                Publish to YouTube
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
