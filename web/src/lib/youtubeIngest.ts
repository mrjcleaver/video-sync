/**
 * Shared primitive for ingesting a YouTube video as a fresh catalog
 * source row, with the correct upstream link to its host record.
 *
 * Two consumers (ADR-049 / ADR-050 follow-ups):
 *   C1-A: backfill — walks historically-missing YouTube IDs from past
 *         publishes that never created a YouTube source row.
 *   C3:   forward-only — invoked after every successful YouTube upload
 *         so the publish trail stops accruing the gap.
 *
 * Idempotent on (platform, external_id). If a YouTube source row with
 * `source_id == "youtube-<id>"` already exists, returns the existing
 * record without re-fetching.
 *
 * Upstream link resolution follows ADR-049 + ADR-050:
 *   - host is meeting-source (Zoom/Streamyard/OBS/Wirecast):
 *       new YT row → host via BroadcastedFrom
 *   - host is Fireflies AND has a TranscribedFrom link to a meeting
 *     source still present in the catalog:
 *       new YT row → that-meeting-source via BroadcastedFrom
 *       (skips the Fireflies middleman — YouTube broadcasts derive from
 *       the meeting, not from the transcript bot)
 *   - host is Fireflies standalone (ADR-050 fallback canonical):
 *       new YT row → host (Fireflies) via BroadcastedFrom
 *   - any other host (Loom, Kaltura, YouTube): create the YT row but
 *     skip the auto-link. Let the sibling matcher or operator decide.
 */

import { WasmVideoRecord } from "./wasm";
import type { VideoRecordJSON } from "./wasm";
import { videoStore } from "./store";
import type { YouTubeVideoInfo } from "../app/api/youtube/video-info/route";

const MEETING_SOURCE_PLATFORMS: ReadonlySet<string> = new Set([
  "Zoom", "Streamyard", "OBS", "Wirecast",
]);

const DEFAULT_ACTOR = "00000000-0000-0000-0000-000000000001";

export interface UpstreamLinkInfo {
  canonicalId: string;
  canonicalPlatform: string;
  canonicalExternalId: string;
  relation: "BroadcastedFrom";
}

export type IngestResult =
  | {
      ok: true;
      recordId: string;
      /** True if we created a new record; false if one already existed. */
      created: boolean;
      /** Populated when the helper wrote an upstream_link to the new row. */
      upstreamLinked: UpstreamLinkInfo | null;
    }
  | { ok: false; error: string };

/**
 * Resolve the right canonical for a new YouTube row given its host. See
 * the file header for the directional rules. Returns null if no
 * directional link should be written — the caller leaves the record
 * standalone and lets the matcher decide later.
 */
export function resolveYouTubeCanonical(
  host: VideoRecordJSON,
  allRecords: VideoRecordJSON[],
): { canonical: VideoRecordJSON } | null {
  const hostPlatform = host.source_platform;

  if (MEETING_SOURCE_PLATFORMS.has(hostPlatform)) {
    return { canonical: host };
  }

  if (hostPlatform === "Fireflies") {
    const transcribedLink = (host.upstream_links ?? []).find(
      (l) => l.relation === "TranscribedFrom" && MEETING_SOURCE_PLATFORMS.has(l.platform),
    );
    if (transcribedLink) {
      // Prefer the link's video_id when present; otherwise look up by
      // (platform, external_id) to handle older links written before
      // the lookup field was populated.
      const upstream = transcribedLink.video_id
        ? allRecords.find((r) => r.id === transcribedLink.video_id)
        : allRecords.find(
            (r) =>
              r.source_platform === transcribedLink.platform &&
              r.source_id === transcribedLink.external_id,
          );
      if (upstream) return { canonical: upstream };
      // Link points at a meeting source we don't have in catalog —
      // fall through to Fireflies-as-fallback-canonical (ADR-050).
    }
    return { canonical: host };
  }

  // Loom / Kaltura / YouTube hosts — don't auto-link. The relationship
  // isn't a clean BroadcastedFrom (Loom→YouTube is "re-upload of a Loom
  // recording", semantically closer to ScreenRecordingOf or just a
  // peer SameEvent — out of scope for this helper).
  return null;
}

async function fetchYouTubeVideoInfo(videoId: string): Promise<YouTubeVideoInfo> {
  const res = await fetch(`/api/youtube/video-info?videoId=${encodeURIComponent(videoId)}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`video-info ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as YouTubeVideoInfo;
}

function findExistingYouTubeRow(youtubeVideoId: string): VideoRecordJSON | null {
  const sourceId = `youtube-${youtubeVideoId}`;
  for (const rec of videoStore.getAll()) {
    if (rec.source_platform === "YouTube" && rec.source_id === sourceId) {
      return rec;
    }
  }
  return null;
}

export async function ingestYouTubeSourceRow(
  youtubeVideoId: string,
  host: VideoRecordJSON,
  opts?: { actorUserId?: string },
): Promise<IngestResult> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeVideoId)) {
    return { ok: false, error: `Invalid YouTube video id: ${youtubeVideoId}` };
  }
  const actorUserId = opts?.actorUserId ?? DEFAULT_ACTOR;

  // Idempotency check
  const existing = findExistingYouTubeRow(youtubeVideoId);
  if (existing) {
    return { ok: true, recordId: existing.id, created: false, upstreamLinked: null };
  }

  let info: YouTubeVideoInfo;
  try {
    info = await fetchYouTubeVideoInfo(youtubeVideoId);
  } catch (err) {
    return { ok: false, error: `Metadata fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Build the same shape YouTubeLiveImport.tsx uses, so all downstream
  // code (sibling matcher, broadcastPairs, dashboard renderer) sees a
  // record indistinguishable from a channel-poll import.
  const isLive = info.liveBroadcastContent === "live" || info.liveBroadcastContent === "completed";
  const tags = isLive ? ["youtube-live", `live-${info.liveBroadcastContent}`] : [];
  const cmd: Record<string, unknown> = {
    source_id: `youtube-${youtubeVideoId}`,
    source_platform: "YouTube",
    title: info.title,
    description: info.description ?? undefined,
    duration_seconds: info.durationSeconds,
    participants: [],
    download_url: `youtube://${youtubeVideoId}`,
    thumbnail_url: info.thumbnailUrl ?? undefined,
    tags,
    recorded_at: info.publishedAt,
    metadata_extra: {
      channel: info.channelTitle,
      privacy_status: info.privacyStatus,
      live_broadcast_content: info.liveBroadcastContent,
      ...(isLive ? { live_broadcast: "1" } : {}),
      youtube_url: `https://www.youtube.com/watch?v=${youtubeVideoId}`,
    },
  };

  let record: WasmVideoRecord;
  try {
    record = new WasmVideoRecord(JSON.stringify(cmd));
  } catch (err) {
    return { ok: false, error: `WASM rejected record: ${err instanceof Error ? err.message : String(err)}` };
  }
  videoStore.add(record);
  const newRecordId = record.id();

  // Resolve canonical AFTER adding to store, so findExistingYouTubeRow
  // semantics stay consistent (host is unchanged but the new YT row is
  // visible to subsequent lookups).
  const canonicalResolution = resolveYouTubeCanonical(host, videoStore.getAll());
  if (!canonicalResolution) {
    return { ok: true, recordId: newRecordId, created: true, upstreamLinked: null };
  }

  const canonical = canonicalResolution.canonical;
  const linkCmd = {
    actor: { user_id: actorUserId, role: "Operator" },
    video_id: canonical.id,
    platform: canonical.source_platform,
    external_id: canonical.source_id,
    relation: "BroadcastedFrom" as const,
    linked_by: "Auto" as const,
  };
  try {
    videoStore.mutate(newRecordId, (r) => r.link_upstream(JSON.stringify(linkCmd)));
  } catch (err) {
    // The record is in catalog; just the upstream link failed. Caller
    // can still surface the success of ingestion. The matcher will
    // attempt to write the link on a subsequent catch-up pass.
    return {
      ok: true,
      recordId: newRecordId,
      created: true,
      upstreamLinked: null,
    };
    void err;
  }

  return {
    ok: true,
    recordId: newRecordId,
    created: true,
    upstreamLinked: {
      canonicalId: canonical.id,
      canonicalPlatform: canonical.source_platform,
      canonicalExternalId: canonical.source_id,
      relation: "BroadcastedFrom",
    },
  };
}
