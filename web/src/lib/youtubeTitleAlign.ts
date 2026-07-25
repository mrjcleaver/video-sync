/**
 * ADR-055 — Align YouTube-Live broadcast titles with dated series
 * names used elsewhere in the catalog. Pure resolver, no I/O.
 *
 * Two strategies in priority order:
 *
 *   1. Paired-canonical inheritance — when the YouTube record has a
 *      BroadcastedFrom upstream link to a meeting-source canonical
 *      whose title already carries a recognised date, copy the
 *      canonical's title verbatim. Strongest signal.
 *   2. Series-registry template — match the raw YouTube title
 *      against operator-maintained {series_name, pattern} entries
 *      and construct `{series_name} - {D MMM YYYY}` using
 *      recorded_at.
 *
 * Safety guards:
 *   - Already-dated titles are left alone (no double-dating).
 *   - No confident inference → return null (never invent a series).
 *   - Original title is exposed on the result so the consumer can
 *     persist it (metadata_extra at ingest, or the EventLog at
 *     retrospective rewrite time).
 *
 * See docs/adr/ADR-055-youtube-title-alignment.md.
 */

import type { VideoRecordJSON } from "./wasm";

export interface SeriesRegistryEntry {
  /** Human-readable series name, used verbatim as the prefix of the
   *  aligned title. */
  series_name: string;
  /** Regex source string that matches the raw YouTube title. Kept
   *  as a string (not a RegExp) so it can round-trip through JSON
   *  storage (ADR-031 pattern). Constructed with the 'i' flag. */
  pattern: string;
}

export interface AlignedTitle {
  new_title: string;
  original_title: string;
  source: "paired_canonical" | "series_registry";
  /** Set when source === "paired_canonical". */
  canonical_id?: string;
  /** Set when source === "series_registry". */
  matched_series?: string;
}

/**
 * Recognise a date suffix in a title. Two conservative forms:
 *   - "6 Feb 2026", "16 Jun 2026" — the format ADR-014 emits
 *   - "2026-06-19" — ISO
 * Returns true when the title carries either. Consumers use this
 * both to gate rewrites (already-dated → skip) and to validate a
 * paired canonical's title before inheriting it.
 */
export function titleContainsDate(title: string): boolean {
  if (!title) return false;
  const monthNames = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  const dmy = new RegExp(`\\b\\d{1,2}\\s+${monthNames}\\s+\\d{4}\\b`, "i");
  const iso = /\b\d{4}-\d{2}-\d{2}\b/;
  return dmy.test(title) || iso.test(title);
}

/**
 * Format an ISO timestamp (or ISO date) as "D MMM YYYY" — matches
 * ADR-014's default `{{date:D MMM YYYY}}` output.
 */
export function formatDMMMYYYY(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const day = d.getUTCDate();
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const year = d.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

/**
 * Enumerate paired canonicals — records that appear as the target
 * of this record's BroadcastedFrom upstream link. Returns them in
 * catalog order (arbitrary but stable). The caller picks the first
 * dated one.
 */
function findPairedCanonicals(record: VideoRecordJSON, allRecords: VideoRecordJSON[]): VideoRecordJSON[] {
  const out: VideoRecordJSON[] = [];
  for (const link of record.upstream_links ?? []) {
    if (link.relation !== "BroadcastedFrom") continue;
    if (link.video_id) {
      const found = allRecords.find((r) => r.id === link.video_id);
      if (found) { out.push(found); continue; }
    }
    // Fallback resolution by (platform, external_id).
    const found = allRecords.find((r) => r.source_platform === link.platform && r.source_id === link.external_id);
    if (found) out.push(found);
  }
  return out;
}

function tryStrategyPairedCanonical(
  record: VideoRecordJSON,
  allRecords: VideoRecordJSON[],
): AlignedTitle | null {
  const canonicals = findPairedCanonicals(record, allRecords);
  for (const canonical of canonicals) {
    if (!titleContainsDate(canonical.title)) continue;
    if (canonical.title === record.title) return null; // already aligned
    return {
      new_title: canonical.title,
      original_title: record.title,
      source: "paired_canonical",
      canonical_id: canonical.id,
    };
  }
  return null;
}

function tryStrategyRegistry(
  record: VideoRecordJSON,
  registry: SeriesRegistryEntry[],
): AlignedTitle | null {
  return resolveTitleFromRegistry(record.title, record.recorded_at ?? record.indexed_at ?? "", registry);
}

/**
 * Strategy-2-only version of the resolver — usable at ingest time
 * before the record has been added to the catalog (no upstream_links
 * yet, no paired-canonical lookup possible). The retrospective
 * backfill catches Strategy 1 later.
 */
export function resolveTitleFromRegistry(
  title: string,
  recordedAt: string,
  registry: SeriesRegistryEntry[],
): AlignedTitle | null {
  if (titleContainsDate(title)) return null;
  // Prefer the longest series_name on match — a longer name is
  // more specific, so it wins when multiple patterns fire.
  const sorted = [...registry].sort((a, b) => b.series_name.length - a.series_name.length);
  for (const entry of sorted) {
    let re: RegExp;
    try {
      re = new RegExp(entry.pattern, "i");
    } catch {
      continue; // malformed pattern — skip
    }
    if (!re.test(title)) continue;
    const dated = formatDMMMYYYY(recordedAt);
    if (!dated) return null;
    const newTitle = `${entry.series_name} - ${dated}`;
    if (newTitle === title) return null;
    return {
      new_title: newTitle,
      original_title: title,
      source: "series_registry",
      matched_series: entry.series_name,
    };
  }
  return null;
}

/**
 * Compute the aligned title for a record, or null if no rewrite is
 * warranted. Returns null in three cases:
 *
 *   - The record isn't a YouTube source row (out of scope).
 *   - The current title already contains a recognised date.
 *   - Neither strategy fires (no confident inference).
 *
 * Consumers apply the rewrite via WASM update_metadata (retrospective)
 * or via the create-time cmd (ingest, which also gets to populate
 * metadata_extra.youtube_original_title in the same operation).
 */
export function resolveAlignedTitle(
  record: VideoRecordJSON,
  allRecords: VideoRecordJSON[],
  registry: SeriesRegistryEntry[],
): AlignedTitle | null {
  if (record.source_platform !== "YouTube") return null;
  if (titleContainsDate(record.title)) return null;

  return tryStrategyPairedCanonical(record, allRecords)
      ?? tryStrategyRegistry(record, registry);
}
