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
import type { Role } from "./types/actor";
import { resolveTitleFromRegistry } from "./youtubeTitleAlign";
import { getSeriesRegistry } from "./seriesRegistryClient";

const MEETING_SOURCE_PLATFORMS: ReadonlySet<string> = new Set([
  "Zoom", "Streamyard", "OBS", "Wirecast",
]);

const DEFAULT_ACTOR_ID = "00000000-0000-0000-0000-000000000001";
const DEFAULT_ACTOR_ROLE: Role = "Admin";

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
      /** Per ADR-051: YouTube rows ingested via the publish-trail path
       *  (C1-A backfill, C3 forward-only) land at Published, not
       *  Discovered, because the video is already live on YouTube by
       *  the time we ingest. `fromStatus` is the status the record
       *  was in *before* this advancement (omitted when no advance
       *  was attempted, e.g. row was already Published or in a
       *  terminal state we don't override). */
      advancedToPublished?: { fromStatus: string };
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

/**
 * Read the operator-stored YouTube Google API key from the same place
 * URLImport does — `localStorage["video-sync:connections"]
 * .YouTube.credentials.googleApiKey`. Prod Cloud Run has no
 * GOOGLE_API_KEY env var (server falls through to a 500 without it),
 * so without this the helper hits "No Google API key configured" for
 * every call. Returns null silently if the operator hasn't configured
 * one — the server's error message tells them where to put it.
 */
function getGoogleApiKeyFromConnections(): string | null {
  try {
    const raw = localStorage.getItem("video-sync:connections");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { YouTube?: { credentials?: { googleApiKey?: string } } };
    return parsed?.YouTube?.credentials?.googleApiKey?.trim() || null;
  } catch {
    return null;
  }
}

async function fetchYouTubeVideoInfo(videoId: string): Promise<YouTubeVideoInfo> {
  const params = new URLSearchParams({ videoId });
  const apiKey = getGoogleApiKeyFromConnections();
  if (apiKey) params.set("apiKey", apiKey);
  const res = await fetch(`/api/youtube/video-info?${params}`);
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
  opts?: { actor?: { user_id: string; role: Role } | null },
): Promise<IngestResult> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeVideoId)) {
    return { ok: false, error: `Invalid YouTube video id: ${youtubeVideoId}` };
  }
  // Role MUST be one of Admin/Publisher/Viewer — the WASM aggregate
  // rejects others (incident 2026-06-07: hardcoded "Operator" → every
  // upstream-link write failed silently after a successful ingest).
  const actorUserId = opts?.actor?.user_id ?? DEFAULT_ACTOR_ID;
  const actorRole: Role = opts?.actor?.role ?? DEFAULT_ACTOR_ROLE;

  // Idempotency check — but with repair-on-rerun semantics. If a row
  // already exists but is missing its BroadcastedFrom upstream link
  // (e.g. partial completion from a prior run where the ingest
  // succeeded but the link write failed), write the missing link now.
  // Also auto-advance to Published per ADR-051 if it's still in a
  // pre-publish state.
  const existing = findExistingYouTubeRow(youtubeVideoId);
  if (existing) {
    const actor = { user_id: actorUserId, role: actorRole };
    const linked = maybeWriteBroadcastedFromLink(existing.id, host, actor);
    const advanced = maybeAdvanceToPublished(existing.id, youtubeVideoId, actor);
    return { ok: true, recordId: existing.id, created: false, upstreamLinked: linked, advancedToPublished: advanced };
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

  // ADR-055 — align the title with the dated series form used
  // elsewhere. At first-ingest only Strategy 2 (series-registry
  // template) can fire: Strategy 1 (paired-canonical inheritance)
  // needs an upstream_link that's added AFTER creation by
  // maybeWriteBroadcastedFromLink below. The retrospective backfill
  // card catches Strategy 1 on the next Catch-Up pass — the raw
  // YouTube title is always preserved in metadata_extra so that
  // pass still has the original to work from.
  const registry = await getSeriesRegistry();
  const alignmentProbe = resolveTitleFromRegistry(info.title, info.publishedAt, registry);
  const finalTitle = alignmentProbe?.new_title ?? info.title;
  const alignedAtIngest = alignmentProbe != null;

  const cmd: Record<string, unknown> = {
    source_id: `youtube-${youtubeVideoId}`,
    source_platform: "YouTube",
    title: finalTitle,
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
      // ADR-055 — always preserve the raw YouTube title so a
      // retrospective realignment (paired canonical arrives later)
      // can still see what YouTube itself called it. Only stamp
      // when we actually rewrote — for untouched titles the raw
      // is already in `title` and the record.
      ...(alignedAtIngest ? {
        youtube_original_title: info.title,
        title_aligned_source: alignmentProbe!.source,
        ...(alignmentProbe!.matched_series ? { title_aligned_matched_series: alignmentProbe!.matched_series } : {}),
      } : {}),
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
  const actor = { user_id: actorUserId, role: actorRole };

  const linked = maybeWriteBroadcastedFromLink(newRecordId, host, actor);
  const advanced = maybeAdvanceToPublished(newRecordId, youtubeVideoId, actor);
  return { ok: true, recordId: newRecordId, created: true, upstreamLinked: linked, advancedToPublished: advanced };
}

/**
 * ADR-051 — chain a YouTube source row through
 * Discovered/InScope/Approved → Publishing → Published. The video is
 * already on YouTube (that's how the ingest path knows about it), so
 * the Discovered default starting status is misleading; advance to
 * Published immediately.
 *
 * Status guard: only advance when the row is in a pre-publish status
 * the operator hasn't deliberately moved it past. We never override
 * Failed / Skipped / Abandoned — those represent explicit operator
 * intent. Already-Published / already-Publishing is a no-op.
 *
 * Returns the prior status when an advancement actually happened;
 * undefined when no advancement was attempted or it failed at any
 * stage. The record's catalog state is consistent either way — failed
 * stages just leave the record at its current stage (the next backfill
 * run will retry).
 */
/** ADR-051 status guard — exported for unit testing. The statuses
 *  where it's safe to auto-advance to Published represent "operator
 *  hasn't deliberately moved this past Approved." Skipped / Failed /
 *  Abandoned / Publishing / Published are excluded. */
export const ADVANCEABLE_STATUSES: ReadonlyArray<string> = ["Discovered", "InScope", "Approved"];
export function isAdvanceableStatus(status: string): boolean {
  return ADVANCEABLE_STATUSES.includes(status);
}

function maybeAdvanceToPublished(
  recordId: string,
  youtubeVideoId: string,
  actor: { user_id: string; role: Role },
): { fromStatus: string } | undefined {
  const allRecords = videoStore.getAll();
  const rec = allRecords.find((r) => r.id === recordId);
  if (!rec) return undefined;
  const fromStatus = rec.status;
  if (!isAdvanceableStatus(fromStatus)) return undefined;

  const actorBlock = { actor };
  try {
    // Discovered → Approved (skip mark_in_scope; approve accepts from Discovered too)
    if (fromStatus === "Discovered" || fromStatus === "InScope") {
      videoStore.mutate(recordId, (r) => r.approve(JSON.stringify(actorBlock)));
    }
    // Approved → Publishing
    videoStore.mutate(recordId, (r) => r.request_publish(JSON.stringify(actorBlock)));
    // Publishing → Published. mark_published dedupes the implicit
    // Origin=Destination case via ADR-049 slice 1's normalize_external_id,
    // so passing the bare video id as destination_id is correct here.
    const markPubCmd = {
      actor,
      destination_id: youtubeVideoId,
      destination_url: `https://www.youtube.com/watch?v=${youtubeVideoId}`,
      destination_platform: "YouTube" as const,
    };
    videoStore.mutate(recordId, (r) => r.mark_published(JSON.stringify(markPubCmd)));
  } catch {
    // Mid-chain failure — record sits at whichever stage it reached.
    // Don't surface as ingest-level error; next backfill run will
    // retry the remaining transitions (each is idempotent on its
    // own — request_publish from Publishing is a no-op, etc).
    return undefined;
  }
  return { fromStatus };
}

/**
 * Idempotent helper — given a newly-created or existing YouTube source
 * row, write a BroadcastedFrom upstream link to the canonical resolved
 * via ADR-049/050 rules, IF such a link doesn't already exist on the
 * row. Returns the link info if a link is (or already was) present
 * pointing at the expected canonical; null if no canonical applies or
 * the write failed.
 *
 * Repair-on-rerun: a row from a prior partial run (record created but
 * link missing — e.g. WASM rejected the link cmd) gets healed on the
 * next backfill pass without needing a re-fetch from YouTube.
 */
function maybeWriteBroadcastedFromLink(
  youtubeRecordId: string,
  host: VideoRecordJSON,
  actor: { user_id: string; role: Role },
): UpstreamLinkInfo | null {
  const allRecords = videoStore.getAll();
  const canonicalResolution = resolveYouTubeCanonical(host, allRecords);
  if (!canonicalResolution) return null;
  const canonical = canonicalResolution.canonical;

  const youtubeRow = allRecords.find((r) => r.id === youtubeRecordId);
  if (!youtubeRow) return null;
  const alreadyLinked = (youtubeRow.upstream_links ?? []).some(
    (l) =>
      l.relation === "BroadcastedFrom" &&
      l.platform === canonical.source_platform &&
      l.external_id === canonical.source_id,
  );
  if (alreadyLinked) {
    return {
      canonicalId: canonical.id,
      canonicalPlatform: canonical.source_platform,
      canonicalExternalId: canonical.source_id,
      relation: "BroadcastedFrom",
    };
  }

  const linkCmd = {
    actor,
    video_id: canonical.id,
    platform: canonical.source_platform,
    external_id: canonical.source_id,
    relation: "BroadcastedFrom" as const,
    linked_by: "Auto" as const,
  };
  try {
    videoStore.mutate(youtubeRecordId, (r) => r.link_upstream(JSON.stringify(linkCmd)));
  } catch {
    // The record is in catalog; just the link failed. Next backfill
    // run will retry — repair semantics ensure no permanent orphan.
    return null;
  }
  return {
    canonicalId: canonical.id,
    canonicalPlatform: canonical.source_platform,
    canonicalExternalId: canonical.source_id,
    relation: "BroadcastedFrom",
  };
}

// ── C1-A backfill driver ─────────────────────────────────────────

/** A YouTube Destination location whose YouTube video id has no
 *  corresponding source row in the catalog. The host is whichever
 *  record's `locations` carries the Destination entry. */
export interface MissingYouTubeRow {
  youtubeVideoId: string;
  host: VideoRecordJSON;
}

/**
 * Walk the catalog and return every YouTube Destination location that
 * still needs work: either no YouTube source row exists yet (full
 * ingest needed) OR the row exists but is missing its expected
 * BroadcastedFrom upstream link (link-repair needed — e.g. partial
 * completion from a prior run where the ingest succeeded but the link
 * write failed).
 *
 * "Fully complete" pairs — YT row exists AND has a BroadcastedFrom
 * link to the expected canonical — are excluded so the operator sees
 * a count that reflects remaining work.
 *
 * Dedupe by (youtubeVideoId, host.id) — the same YouTube video
 * published from multiple host records produces one work item per
 * host. The helper handles each idempotently.
 */
export function findMissingYouTubeRows(allRecords: VideoRecordJSON[]): MissingYouTubeRow[] {
  const existingYouTubeRowByBareId = new Map<string, VideoRecordJSON>();
  for (const rec of allRecords) {
    if (rec.source_platform !== "YouTube") continue;
    const bare = rec.source_id.startsWith("youtube-") ? rec.source_id.slice("youtube-".length) : rec.source_id;
    existingYouTubeRowByBareId.set(bare, rec);
  }

  const out: MissingYouTubeRow[] = [];
  const seenPairs = new Set<string>();
  for (const host of allRecords) {
    for (const loc of host.locations ?? []) {
      if (loc.platform !== "YouTube" || loc.role !== "Destination") continue;
      const extId = loc.external_id;
      if (!extId) continue;
      const bare = extId.startsWith("youtube-") ? extId.slice("youtube-".length) : extId;
      if (!/^[A-Za-z0-9_-]{11}$/.test(bare)) continue;  // skip malformed
      const pairKey = `${bare}::${host.id}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const existingRow = existingYouTubeRowByBareId.get(bare);
      if (!existingRow) {
        // No YT source row yet — full ingest needed.
        out.push({ youtubeVideoId: bare, host });
        continue;
      }
      // YT row exists. Include in work list only if it's missing the
      // BroadcastedFrom link to the expected canonical (link-repair
      // case). If no canonical applies (host platform doesn't qualify),
      // the row is correctly standalone — no work needed.
      const canonicalResolution = resolveYouTubeCanonical(host, allRecords);
      if (!canonicalResolution) continue;
      const canonical = canonicalResolution.canonical;
      const alreadyLinked = (existingRow.upstream_links ?? []).some(
        (l) =>
          l.relation === "BroadcastedFrom" &&
          l.platform === canonical.source_platform &&
          l.external_id === canonical.source_id,
      );
      if (alreadyLinked) continue;
      out.push({ youtubeVideoId: bare, host });
    }
  }
  return out;
}

export interface BackfillProgressEvent {
  type: "started" | "item_done" | "complete";
  /** 1-indexed; only present on "item_done". */
  index?: number;
  total: number;
  youtubeVideoId?: string;
  hostTitle?: string;
  /** Outcome of this item — only present on "item_done". */
  outcome?:
    | { kind: "created"; recordId: string; linkedTo: string | null }
    | { kind: "repaired"; recordId: string; linkedTo: string }
    | { kind: "skipped_existed" }
    | { kind: "error"; error: string };
  /** Summary counts — only present on "complete". */
  totals?: { created: number; repaired: number; skipped: number; errors: number };
}

/**
 * Iterate `findMissingYouTubeRows`, call `ingestYouTubeSourceRow` for
 * each, emit progress events. Sequential (not concurrent) — keeps
 * YouTube Data API politeness simple and avoids racing the
 * idempotency check across same-host duplicates.
 *
 * Returns final totals; also delivers them via the final `complete`
 * event.
 */
export async function runYouTubeRowBackfill(
  onEvent: (ev: BackfillProgressEvent) => void,
  log?: (msg: string, ctx?: Record<string, unknown>) => void,
  opts?: { delayMs?: number; actor?: { user_id: string; role: Role } | null },
): Promise<{ created: number; repaired: number; skipped: number; errors: number }> {
  const allRecords = videoStore.getAll();
  const work = findMissingYouTubeRows(allRecords);
  onEvent({ type: "started", total: work.length });
  log?.(`YouTube row backfill started — ${work.length} missing row${work.length === 1 ? "" : "s"} to ingest`);

  let created = 0;
  let repaired = 0;
  let skipped = 0;
  let errors = 0;
  const delayMs = opts?.delayMs ?? 200;

  for (let i = 0; i < work.length; i++) {
    const { youtubeVideoId, host } = work[i];
    const hostTitle = host.title || host.source_id;
    let outcome: BackfillProgressEvent["outcome"];
    try {
      const result = await ingestYouTubeSourceRow(youtubeVideoId, host, { actor: opts?.actor ?? null });
      if (!result.ok) {
        errors++;
        outcome = { kind: "error", error: result.error };
        log?.(`Backfill error on ${youtubeVideoId} (host "${hostTitle}"): ${result.error}`, { video_id: host.id });
      } else {
        const advanceMsg = result.advancedToPublished
          ? `, ${result.advancedToPublished.fromStatus}→Published`
          : "";
        if (!result.created) {
          // Existing row — distinguish full no-op from link-repair
          // and/or status-advance.
          if (result.upstreamLinked || result.advancedToPublished) {
            repaired++;
            const linkedTo = result.upstreamLinked
              ? `${result.upstreamLinked.canonicalPlatform}:${result.upstreamLinked.canonicalExternalId}`
              : null;
            outcome = { kind: "repaired", recordId: result.recordId, linkedTo: linkedTo ?? "(no canonical)" };
            const what: string[] = [];
            if (linkedTo) what.push(`wrote missing BroadcastedFrom → ${linkedTo}`);
            if (result.advancedToPublished) what.push(`advanced ${result.advancedToPublished.fromStatus}→Published`);
            log?.(
              `Repaired YouTube row ${youtubeVideoId} — ${what.join("; ")}`,
              { video_id: result.recordId },
            );
          } else {
            skipped++;
            outcome = { kind: "skipped_existed" };
          }
        } else {
          created++;
          const linkedTo = result.upstreamLinked
            ? `${result.upstreamLinked.canonicalPlatform}:${result.upstreamLinked.canonicalExternalId}`
            : null;
          outcome = { kind: "created", recordId: result.recordId, linkedTo };
          log?.(
            `Backfilled YouTube row ${youtubeVideoId}${linkedTo ? ` — linked BroadcastedFrom → ${linkedTo}` : " (standalone)"}${advanceMsg}`,
            { video_id: result.recordId },
          );
        }
      }
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      outcome = { kind: "error", error: msg };
      log?.(`Backfill threw on ${youtubeVideoId} (host "${hostTitle}"): ${msg}`, { video_id: host.id });
    }

    onEvent({
      type: "item_done",
      index: i + 1,
      total: work.length,
      youtubeVideoId,
      hostTitle,
      outcome,
    });

    if (i < work.length - 1 && delayMs > 0) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  const totals = { created, repaired, skipped, errors };
  onEvent({ type: "complete", total: work.length, totals });
  log?.(`YouTube row backfill complete — ${created} created, ${repaired} repaired, ${skipped} skipped, ${errors} error(s)`);
  return totals;
}
