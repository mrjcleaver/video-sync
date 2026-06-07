/**
 * ADR-049 slices 3 + 4 — pair-aware view derived from `upstream_links`.
 *
 * A YouTube-Live record with an upstream `BroadcastedFrom` link is a
 * **broadcast destination**; the record it points to is the
 * **canonical** record for that logical event. Slice 3 hides the
 * broadcast destination from the default Overview render and surfaces
 * a "📺 Broadcast to YouTube Live · <id>" badge on the canonical.
 * Slice 4 disables Publish-to-YouTube on the canonical when the pair
 * already exists.
 *
 * Both consumers (BackfillOverview, VideoCard) need the same indexing
 * of "who points at whom"; centralise it here so the lookup logic
 * can't drift.
 */

import type { VideoRecordJSON } from "./wasm";

export interface BroadcastDestinationInfo {
  /** Catalog id of the YouTube-Live broadcast destination record. */
  destination_record_id: string;
  /** The YouTube video id (bare, no prefix). */
  youtube_id: string;
  /** Display title of the broadcast destination — used for tooltips. */
  destination_title: string;
}

export interface BroadcastPairsIndex {
  /** record_id → broadcast destination(s) pointing at it. Canonical
   *  records (Zoom / Streamyard / OBS / Wirecast that are the upstream
   *  of a BroadcastedFrom link) appear as keys here. */
  destinationsFor: Map<string, BroadcastDestinationInfo[]>;
  /** Catalog ids of records that are broadcast destinations themselves
   *  (i.e. the YouTube-Live side that has an outgoing BroadcastedFrom
   *  upstream link). These are hidden from the default Overview. */
  destinationRecordIds: Set<string>;
}

const EMPTY_INDEX: BroadcastPairsIndex = {
  destinationsFor: new Map(),
  destinationRecordIds: new Set(),
};

/**
 * Walk the catalog once and build the lookup tables.
 *
 * The forward direction is straightforward: a YouTube-Live record with
 * an upstream_link of relation=BroadcastedFrom is a destination, and
 * the link's `video_id` (when present) names the canonical record.
 *
 * The link may have a null `video_id` if the upstream wasn't indexed
 * at link time; in that case we resolve by (platform, external_id)
 * against the catalog, which covers the common path where the Zoom
 * record was imported after the link was made.
 */
export function buildBroadcastPairs(records: VideoRecordJSON[]): BroadcastPairsIndex {
  if (records.length === 0) return EMPTY_INDEX;

  // Index records by source_id and by (platform, external_id) for the
  // link-resolution fallback.
  const bySourceId = new Map<string, VideoRecordJSON>();
  for (const r of records) {
    bySourceId.set(r.source_id, r);
  }

  const destinationsFor = new Map<string, BroadcastDestinationInfo[]>();
  const destinationRecordIds = new Set<string>();

  for (const r of records) {
    for (const link of r.upstream_links ?? []) {
      if (link.relation !== "BroadcastedFrom") continue;

      // This record has an outgoing BroadcastedFrom — it's a destination.
      destinationRecordIds.add(r.id);

      // Resolve the canonical record. Prefer the link's video_id,
      // fall back to looking up by source_id.
      let canonicalId = link.video_id;
      if (!canonicalId) {
        const upstream = bySourceId.get(link.external_id);
        if (upstream) canonicalId = upstream.id;
      }
      if (!canonicalId) continue;  // canonical not in this catalog

      // Extract the YouTube video id from the destination record's
      // source_id (format: "youtube-<11-char id>"). Fallback to the
      // bare source_id if the prefix is missing.
      const ytId = r.source_id.replace(/^youtube-/, "");

      const info: BroadcastDestinationInfo = {
        destination_record_id: r.id,
        youtube_id: ytId,
        destination_title: r.title,
      };
      const existing = destinationsFor.get(canonicalId);
      if (existing) existing.push(info);
      else destinationsFor.set(canonicalId, [info]);
    }
  }

  return { destinationsFor, destinationRecordIds };
}

/** Convenience for the common "is this record a broadcast destination?" check. */
export function isBroadcastDestination(index: BroadcastPairsIndex, recordId: string): boolean {
  return index.destinationRecordIds.has(recordId);
}

/** Convenience: get the YouTube broadcast(s) pointing AT this record, if any. */
export function getBroadcastDestinations(index: BroadcastPairsIndex, recordId: string): BroadcastDestinationInfo[] {
  return index.destinationsFor.get(recordId) ?? [];
}
