/**
 * ADR-053 — Transcript Provenance Lookup.
 *
 * When a record's own transcript is empty, walk the provenance graph
 * in a defined safe-relations set and find a donor record that has
 * one. Return the donor's text + a TranscriptSource describing the
 * borrow chain so the UI can surface it transparently.
 *
 * Pure function — no I/O. Consumers (tryEnsureSummary, future search,
 * etc.) call this instead of reading record.transcript_text directly.
 */

import type { VideoRecordJSON } from "./wasm";

const TRANSCRIPT_SAFE_RELATIONS: ReadonlySet<string> = new Set([
  "SameEvent",
  "BroadcastedFrom",
  "TranscribedFrom",
]);

/** Quality ordering: lower index = higher priority donor. */
const TRANSCRIPT_BOT_PLATFORMS: ReadonlySet<string> = new Set(["Fireflies"]);
const MEETING_SOURCE_PLATFORMS: ReadonlySet<string> = new Set([
  "Zoom",
  "Streamyard",
  "OBS",
  "Wirecast",
]);

function donorPriority(rec: VideoRecordJSON): number {
  if (TRANSCRIPT_BOT_PLATFORMS.has(rec.source_platform)) return 0;  // Fireflies — diarised
  if (MEETING_SOURCE_PLATFORMS.has(rec.source_platform)) return 1;  // Zoom auto-transcribe
  if (rec.source_platform === "YouTube") return 2;                  // YouTube auto-captions
  if (rec.source_platform === "Kaltura") return 3;                  // Kaltura captions
  return 99;                                                         // Other / unknown
}

export type TranscriptSourceKind = "own" | "borrowed";

export interface TranscriptSource {
  kind: TranscriptSourceKind;
  /** Set when kind === "borrowed". The record whose transcript was used. */
  donor_record_id?: string;
  donor_platform?: string;
  /** Which directional relation linked the donor to the target. */
  donor_relation?: "SameEvent" | "BroadcastedFrom" | "TranscribedFrom";
  /** "outgoing": target has an upstream_link pointing AT donor.
   *  "incoming": donor has an upstream_link pointing AT target. */
  direction?: "outgoing" | "incoming";
}

export interface ResolvedTranscript {
  text: string;
  source: TranscriptSource;
}

export interface TranscriptDonor {
  donor: VideoRecordJSON;
  relation: "SameEvent" | "BroadcastedFrom" | "TranscribedFrom";
  direction: "outgoing" | "incoming";
}

/**
 * Enumerate every record that COULD donate a transcript to `record`
 * under the safe-relations rules. Includes self (record's own text
 * if long enough). Returned in donor-priority order; ties broken by
 * transcript length (longest first).
 *
 * Exported for the ADR-052 backfill scanner's pre-flight count + for
 * unit testing the relation-walk logic.
 */
export function findTranscriptDonors(
  record: VideoRecordJSON,
  allRecords: VideoRecordJSON[],
  minLength = 200,
): TranscriptDonor[] {
  const seen = new Set<string>();
  const out: TranscriptDonor[] = [];

  // Index records by (platform, external_id) for outgoing-link resolution.
  const bySource = new Map<string, VideoRecordJSON>();
  for (const r of allRecords) {
    bySource.set(`${r.source_platform}::${r.source_id}`, r);
  }

  // 1) Outgoing direction — record.upstream_links points AT donors.
  for (const link of record.upstream_links ?? []) {
    if (!TRANSCRIPT_SAFE_RELATIONS.has(link.relation)) continue;
    let donor: VideoRecordJSON | undefined;
    if (link.video_id) {
      donor = allRecords.find((r) => r.id === link.video_id);
    }
    if (!donor) {
      donor = bySource.get(`${link.platform}::${link.external_id}`);
    }
    if (!donor || donor.id === record.id) continue;
    if (seen.has(donor.id)) continue;
    seen.add(donor.id);
    if ((donor.transcript_text?.length ?? 0) < minLength) continue;
    out.push({
      donor,
      relation: link.relation as "SameEvent" | "BroadcastedFrom" | "TranscribedFrom",
      direction: "outgoing",
    });
  }

  // 2) Incoming direction — some other record's upstream_links point AT record.
  for (const other of allRecords) {
    if (other.id === record.id) continue;
    if (seen.has(other.id)) continue;
    for (const link of other.upstream_links ?? []) {
      if (!TRANSCRIPT_SAFE_RELATIONS.has(link.relation)) continue;
      const matchesById = link.video_id === record.id;
      const matchesBySource =
        link.platform === record.source_platform && link.external_id === record.source_id;
      if (!matchesById && !matchesBySource) continue;
      if ((other.transcript_text?.length ?? 0) < minLength) continue;
      seen.add(other.id);
      out.push({
        donor: other,
        relation: link.relation as "SameEvent" | "BroadcastedFrom" | "TranscribedFrom",
        direction: "incoming",
      });
      break;
    }
  }

  // Sort by priority, then by transcript length (longer wins tiebreak —
  // a more complete transcript is preferred over a partial one from
  // the same platform).
  out.sort((a, b) => {
    const pa = donorPriority(a.donor);
    const pb = donorPriority(b.donor);
    if (pa !== pb) return pa - pb;
    return (b.donor.transcript_text?.length ?? 0) - (a.donor.transcript_text?.length ?? 0);
  });

  return out;
}

/**
 * Return the best transcript usable for an operation on `record`:
 *   - record's own text if long enough → kind: "own"
 *   - else the highest-priority donor's text → kind: "borrowed" + provenance
 *   - else null (no usable transcript exists anywhere in the safe set)
 */
export function resolveTranscriptForOperation(
  record: VideoRecordJSON,
  allRecords: VideoRecordJSON[],
  minLength = 200,
): ResolvedTranscript | null {
  // Prefer own transcript when present — borrowing is a fallback.
  const ownLen = record.transcript_text?.length ?? 0;
  if (ownLen >= minLength) {
    return { text: record.transcript_text!, source: { kind: "own" } };
  }

  const donors = findTranscriptDonors(record, allRecords, minLength);
  if (donors.length === 0) return null;
  const top = donors[0];
  return {
    text: top.donor.transcript_text!,
    source: {
      kind: "borrowed",
      donor_record_id: top.donor.id,
      donor_platform: top.donor.source_platform,
      donor_relation: top.relation,
      direction: top.direction,
    },
  };
}
