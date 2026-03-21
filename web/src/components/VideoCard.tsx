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

const PLATFORMS = ["Zoom", "Loom", "Fireflies", "YouTube", "Kaltura", "Veedio"] as const;
const ROLES = ["Origin", "Intermediate", "Destination"] as const;

/** Resolve internal pseudo-URLs to real web URLs, or return null for non-navigable schemes. */
function resolveExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("fireflies://")) {
    const id = url.slice("fireflies://".length);
    return `https://app.fireflies.ai/view/${id}`;
  }
  // zoom://recording/... and other internal schemes have no navigable web URL
  return null;
}

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

// Static admin actor for demo purposes
const ADMIN_ACTOR = JSON.stringify({
  user_id: "00000000-0000-0000-0000-000000000001",
  role: "Admin",
});

interface Props {
  video: VideoRecordJSON;
  onMutated: () => void;
  onEvent: (event: string) => void;
}

export default function VideoCard({ video, onMutated, onEvent }: Props) {
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

      onEvent(`ShortsJobSubmitted: "${video.title}" → Opus Clip job ${jobId}`);
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
          onEvent(`ShortsIndexed: ${count} clip(s) from "${video.title}" — review in Shorts panel`);
          onMutated();
          break;
        }
      }
    } catch (err) {
      setShortsError(String(err));
      onEvent(`ShortsError: "${video.title}" — ${String(err)}`);
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
      onEvent(`LoomMetadataFetched: "${data.title}" by ${data.authorName}`);
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
    onEvent(`MetadataApplied: "${video.title}" ← Loom${loomInfo.description ? " (with description)" : ""}`);
    onMutated();
  }

  function approve() {
    videoStore.mutate(video.id, (r) =>
      r.approve(JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR) }))
    );
    onEvent(`VideoApproved: "${video.title}"`);
    onMutated();
  }

  function markInScope() {
    videoStore.mutate(video.id, (r) =>
      r.mark_in_scope(
        JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR), rule_id: null })
      )
    );
    onEvent(`VideoScoped: "${video.title}"`);
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
    onEvent(`VideoSkipped: "${video.title}"`);
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
    onEvent(`VideoExcluded: "${video.title}"`);
    onMutated();
  }

  function requestPublish() {
    videoStore.mutate(video.id, (r) =>
      r.request_publish(JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR) }))
    );
    onEvent(`StatusChanged: "${video.title}" -> Publishing`);
    onMutated();
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
        onEvent(`LlmSummarizeFailed: "${video.title}" — ${String(err)}`);
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
        onEvent(`TrimApplied: "${video.title}" — ${attrs.trim_start_seconds}s from start`);
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

      // POST returns 202 + { jobId } immediately — no timeout risk
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

      const { jobId } = await res.json() as { jobId: string };

      // Poll GET /api/youtube/upload?jobId=XXX every 5s until done
      const pollStart = Date.now();
      const POLL_INTERVAL = 5000;
      const POLL_TIMEOUT = 15 * 60 * 1000; // 15 min max

      type JobPoll = { status: string; videoId?: string; videoUrl?: string; error?: string; phase?: string };
      let data: JobPoll | null = null;
      while (Date.now() - pollStart < POLL_TIMEOUT) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        const pollRes = await fetch(`/api/youtube/upload?jobId=${encodeURIComponent(jobId)}`);
        const pollData = await pollRes.json() as JobPoll;
        if (pollData?.phase) setUploadPhase(pollData.phase);
        if (pollData?.status === "completed" || pollData?.status === "failed") {
          data = pollData;
          break;
        }
      }

      if (!data) throw new Error("Upload timed out — check YouTube Studio for the video.");
      if (data.status === "failed") throw new Error(data.error ?? "Upload failed");

      videoStore.mutate(video.id, (r) =>
        r.mark_published(
          JSON.stringify({
            destination_id: data!.videoId,
            destination_url: data!.videoUrl,
          })
        )
      );
      onEvent(`VideoPublished: "${video.title}" -> ${data.videoUrl}`);
      onMutated();
      firePostProcessingRules(loadPostProcessingRules(), true, video, data.videoUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      videoStore.mutate(video.id, (r) =>
        r.mark_failed(JSON.stringify({ error_message: msg }))
      );
      onEvent(`VideoPublishFailed: "${video.title}" — ${msg}`);
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
    onEvent(`VideoAbandoned: "${video.title}"`);
    onMutated();
  }

  function markToRetry() {
    videoStore.mutate(video.id, (r) =>
      r.mark_to_retry(JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR), reason: "Retry requested from dashboard" }))
    );
    onEvent(`VideoMarkedToRetry: "${video.title}"`);
    onMutated();
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
      onEvent(`TranscriptLoaded: "${video.title}" (${data.chars} chars)`);
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
      if (!res.ok) {
        // Video not found or API error — mark as failed
        if (res.status === 404) {
          try {
            videoStore.mutate(video.id, (r) =>
              r.mark_failed(JSON.stringify({ error_message: "YouTube video not found" }))
            );
            onEvent(`VideoFailed: "${video.title}" — YouTube video not found`);
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
        onEvent(`VideoFailed: "${video.title}" — YouTube ${data.status}`);
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
        onEvent(`LocationStatusUpdated (display only): YouTube/${loc.external_id} -> ${data.status}`);
        onMutated();
        return;
      }
      onEvent(`LocationStatusUpdated: "${video.title}" YouTube/${loc.external_id} -> ${data.status}`);
      onMutated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent(`YouTubeStatusCheckFailed: "${video.title}" — ${msg}`);
      alert(`YouTube status check failed: ${msg}`);
    } finally {
      setCheckingStatus(null);
    }
  }

  function markFailed() {
    videoStore.mutate(video.id, (r) =>
      r.mark_failed(JSON.stringify({ error_message: "Manual failure from dashboard" }))
    );
    onEvent(`StatusChanged: "${video.title}" -> Failed`);
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
    onEvent(`LocationAdded: "${video.title}" — ${locPlatform}/${locExternalId}`);
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
    onEvent(`LocationRemoved: "${video.title}" — ${loc.platform}/${loc.external_id}`);
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
    onEvent(`NoteAdded: "${video.title}" — "${noteText.trim()}"`);
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
    onEvent(`UpstreamLinked: "${video.title}" <- ${linkPlatform}/${linkExternalId.trim()}`);
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
    onEvent(`UpstreamUnlinked: "${video.title}" <- ${link.platform}/${link.external_id}${reject ? " (rejected)" : ""}`);
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

  const status = video.status;
  const canApprove = status === "Discovered" || status === "InScope" || status === "Failed" || status === "ToRetry";
  const canSkip = status === "Discovered" || status === "InScope";
  const canAbandon = status === "Failed" || status === "InScope" || status === "Discovered" || status === "Skipped" || status === "Published";
  const canRetry = status === "Failed" || status === "Published";
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
        {!showNotes && video.notes.length === 0 && (
          <button className="btn btn-sm" onClick={() => setShowNotes(true)}>
            + Note
          </button>
        )}
        <button
          className="btn btn-sm btn-red"
          style={{ marginLeft: "auto" }}
          onClick={() => {
            if (window.confirm(`Delete "${video.title}"? This cannot be undone.`)) {
              videoStore.remove(video.id);
              onEvent(`VideoDeleted: "${video.title}"`);
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
