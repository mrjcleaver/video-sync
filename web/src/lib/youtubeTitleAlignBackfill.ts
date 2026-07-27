/**
 * ADR-055 — Retrospective backfill driver for YouTube title alignment.
 *
 * Walks the catalog, finds YouTube-source records whose titles would
 * be aligned by the resolver (Strategy 1 paired-canonical or
 * Strategy 2 series-registry), and applies the rewrite via WASM
 * update_metadata.
 *
 * Parallel structure to summaryBadgeBackfill (ADR-052).
 *
 * Original-title preservation caveat: for records created before
 * ADR-055 shipped, metadata_extra.youtube_original_title is empty;
 * this retrospective rewrite emits the original via the event log
 * only (per-video log filterable at retrieval time). New records
 * created via ADR-055-aware ingest carry the original in
 * metadata_extra directly.
 */

import type { VideoRecordJSON } from "./wasm";
import { videoStore } from "./store";
import { resolveAlignedTitle, resolveAlignedTitleForced, type AlignedTitle, type SeriesRegistryEntry } from "./youtubeTitleAlign";
import { getSeriesRegistry } from "./seriesRegistryClient";
import type { actorCommand } from "./useCurrentActor";
import { actorCommand as buildActorCommand } from "./useCurrentActor";

export interface TitleAlignmentCandidate {
  record: VideoRecordJSON;
  alignment: AlignedTitle;
}

/**
 * Pure scanner — every record for which the resolver would produce
 * a rewrite. ADR-055 restricted this to YouTube-source; ADR-056
 * widens to any platform.
 */
export function findRecordsNeedingTitleAlignment(
  allRecords: VideoRecordJSON[],
  registry: SeriesRegistryEntry[],
  opts?: { force?: boolean },
): TitleAlignmentCandidate[] {
  const resolver = opts?.force ? resolveAlignedTitleForced : resolveAlignedTitle;
  const out: TitleAlignmentCandidate[] = [];
  for (const rec of allRecords) {
    const alignment = resolver(rec, allRecords, registry);
    if (alignment) out.push({ record: rec, alignment });
  }
  return out;
}

export interface TitleAlignmentProgressEvent {
  type: "started" | "item_done" | "complete";
  index?: number;
  total: number;
  recordTitle?: string;
  outcome?:
    | { kind: "renamed"; recordId: string; new_title: string; source: AlignedTitle["source"]; original_title: string; youtubePushed?: "ok" | "noop" | "skipped" | "error"; youtubeError?: string }
    | { kind: "skipped"; reason: string }
    | { kind: "error"; error: string };
  totals?: {
    renamed_via_pair: number;
    renamed_via_registry: number;
    skipped: number;
    errors: number;
    youtube_pushed: number;
    youtube_noop: number;
    youtube_errors: number;
  };
}

export interface YouTubePushCreds {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

const DEFAULT_DELAY_MS = 100;

/**
 * Sequential driver. Applies title rewrites via WASM update_metadata.
 * Reads the registry once per run.
 */
export async function runYouTubeTitleAlignBackfill(
  actorState: Parameters<typeof actorCommand>[0],
  onEvent: (ev: TitleAlignmentProgressEvent) => void,
  log?: (msg: string, ctx?: Record<string, unknown>) => void,
  opts?: { delayMs?: number; signal?: AbortSignal; pushToYouTube?: YouTubePushCreds; force?: boolean },
): Promise<{ renamed_via_pair: number; renamed_via_registry: number; skipped: number; errors: number; youtube_pushed: number; youtube_noop: number; youtube_errors: number }> {
  const delayMs = opts?.delayMs ?? DEFAULT_DELAY_MS;
  const signal = opts?.signal ?? new AbortController().signal;
  const pushCreds = opts?.pushToYouTube;
  const force = opts?.force ?? false;

  const registry = await getSeriesRegistry();
  const allRecords = videoStore.getAll();
  const work = findRecordsNeedingTitleAlignment(allRecords, registry, { force });

  onEvent({ type: "started", total: work.length });
  log?.(`YouTube title alignment backfill started — ${work.length} record${work.length === 1 ? "" : "s"} eligible${pushCreds ? " (also pushing to YouTube)" : ""}`);

  let renamed_via_pair = 0;
  let renamed_via_registry = 0;
  let skipped = 0;
  let errors = 0;
  let youtube_pushed = 0;
  let youtube_noop = 0;
  let youtube_errors = 0;

  for (let i = 0; i < work.length; i++) {
    if (signal.aborted) break;
    const { record, alignment } = work[i];

    let outcome: TitleAlignmentProgressEvent["outcome"];
    try {
      const cmdJson = buildActorCommand(actorState, {
        edits: { title: alignment.new_title },
      });
      videoStore.mutate(record.id, (r) => r.update_metadata(cmdJson));
      if (alignment.source === "paired_canonical") renamed_via_pair++;
      else renamed_via_registry++;
      log?.(
        `Retitled ${record.id} via ${alignment.source} — "${alignment.original_title}" → "${alignment.new_title}"`,
        { video_id: record.id },
      );

      // Optional: push the new title to YouTube via videos.update.
      // Best-effort — a push failure never rolls back the local
      // rename. We only push for records where we can identify a
      // YouTube video: either source_platform=YouTube (source_id is
      // the ID) or any YouTube location (Origin/Destination).
      let youtubePushed: "ok" | "noop" | "skipped" | "error" | undefined;
      let youtubeError: string | undefined;
      if (pushCreds) {
        const ytVideoId = extractYouTubeVideoId(record);
        if (!ytVideoId) {
          youtubePushed = "skipped";
        } else {
          try {
            const res = await fetch("/api/youtube/update-title", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                videoId: ytVideoId,
                title: alignment.new_title,
                refreshToken: pushCreds.refreshToken,
                clientId: pushCreds.clientId,
                clientSecret: pushCreds.clientSecret,
              }),
            });
            if (res.ok) {
              const data = await res.json() as { updated?: boolean };
              if (data.updated) { youtubePushed = "ok"; youtube_pushed++; }
              else { youtubePushed = "noop"; youtube_noop++; }
            } else {
              const data = await res.json().catch(() => ({} as { error?: string }));
              youtubePushed = "error";
              youtubeError = (data as { error?: string }).error ?? `HTTP ${res.status}`;
              youtube_errors++;
              log?.(`YouTube update-title failed for ${record.id} (video ${ytVideoId}): ${youtubeError}`, { video_id: record.id });
            }
          } catch (err) {
            youtubePushed = "error";
            youtubeError = err instanceof Error ? err.message : String(err);
            youtube_errors++;
            log?.(`YouTube update-title errored for ${record.id}: ${youtubeError}`, { video_id: record.id });
          }
        }
      }

      outcome = {
        kind: "renamed",
        recordId: record.id,
        new_title: alignment.new_title,
        source: alignment.source,
        original_title: alignment.original_title,
        ...(youtubePushed ? { youtubePushed } : {}),
        ...(youtubeError ? { youtubeError } : {}),
      };
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      outcome = { kind: "error", error: msg };
      log?.(`Retitle error on ${record.id} ("${record.title}"): ${msg}`, { video_id: record.id });
    }

    onEvent({
      type: "item_done",
      index: i + 1,
      total: work.length,
      recordTitle: alignment.original_title,
      outcome,
    });

    if (i < work.length - 1 && delayMs > 0) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  const totals = { renamed_via_pair, renamed_via_registry, skipped, errors, youtube_pushed, youtube_noop, youtube_errors };
  onEvent({ type: "complete", total: work.length, totals });
  log?.(
    `YouTube title alignment complete — ${renamed_via_pair} via pair, ${renamed_via_registry} via registry, ${errors} local error(s)${pushCreds ? `; YouTube pushed ${youtube_pushed}, ${youtube_noop} noop, ${youtube_errors} error(s)` : ""}`,
  );
  return totals;
}

/**
 * Resolve a YouTube video ID from a catalog record. Prefers a
 * YouTube location (Destination first, then Origin); falls back to
 * a plain `youtube-<ID>` source_id.
 */
function extractYouTubeVideoId(rec: VideoRecordJSON): string | null {
  const locs = (rec.locations ?? []).filter((l) => l.platform === "YouTube" && l.external_id);
  const dest = locs.find((l) => l.role === "Destination");
  if (dest) return normalizeYouTubeId(dest.external_id);
  const origin = locs.find((l) => l.role === "Origin");
  if (origin) return normalizeYouTubeId(origin.external_id);
  if (rec.source_platform === "YouTube") return normalizeYouTubeId(rec.source_id);
  return null;
}

function normalizeYouTubeId(id: string): string {
  return id.startsWith("youtube-") ? id.slice("youtube-".length) : id;
}
