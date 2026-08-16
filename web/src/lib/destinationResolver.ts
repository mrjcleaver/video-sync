/**
 * ADR-075 Phase 2 — resolve a record's effective destination set.
 *
 * Layering order (later beats earlier):
 *   1. Global default — [{ platform: "YouTube", visibility: "unlisted" }]
 *   2. Series match — replaces (not merges) the global default when
 *      the record's title matches a registered series that has a
 *      destinations array configured.
 *   3. Processing-rule transforms — a rule with a privacy_status
 *      transform mutates the YouTube destination's visibility (legacy
 *      compat with the pre-Phase-2 rule surface). Future rule vocab
 *      may add destination-level transforms.
 *   4. Per-record override — the Publish preview modal reads the
 *      resolved set, lets the operator add / remove / change visibility
 *      before the click. Overrides never persist back to the series.
 *
 * This module implements steps 1-3. Step 4 (per-record override) is
 * the Publish preview's job.
 */

import type { VideoRecordJSON } from "./wasm";
import type { DestinationSpec, SeriesRegistryEntry } from "./youtubeTitleAlign";
import { getSeriesRegistryConfigCached } from "./seriesRegistryClient";
import type { ProcessingRule } from "./processingRules";
import { matchesCriteria } from "./rules";
import type { BackfillProfile } from "./backfill";

/**
 * Independent series-matcher for the resolver. Deliberately does NOT
 * defer to resolveTitleFromRegistry — that function's job is title
 * alignment (rewriting an ingest title into "<series> - D MMM YYYY"),
 * and it short-circuits when the title is already dated so downstream
 * ingest doesn't churn the record's title. That short-circuit was
 * accidentally hiding destination lookups: a record like "Volunteer
 * Training - 14 Aug 2026" is already dated, so title-alignment
 * bails, and the destinations from the matching series never fire.
 *
 * Longest-name-wins ordering matches resolveTitleFromRegistry so a
 * series with a longer, more-specific name still beats a shorter
 * alias in the same tie-break sense.
 */
function findMatchingSeries(title: string, registry: SeriesRegistryEntry[]): SeriesRegistryEntry | null {
  if (!title) return null;
  const sorted = [...registry].sort((a, b) => b.series_name.length - a.series_name.length);
  for (const entry of sorted) {
    try {
      if (new RegExp(entry.pattern, "i").test(title)) return entry;
    } catch { /* malformed pattern — skip */ }
  }
  return null;
}

export interface ResolvedDestinations {
  destinations: DestinationSpec[];
  /** Which layer produced this set — useful for the Publish preview
   *  to show "from series X" / "profile default" / "operator added" /
   *  "no series matches (fallback disabled)". */
  provenance:
    | { source: "series"; series_name: string }
    | { source: "profile"; profile_id: string }
    | { source: "global_default" }
    | { source: "no_match_no_fallback" };
}

const GLOBAL_DEFAULT: DestinationSpec[] = [
  { platform: "YouTube", visibility: "unlisted" },
];

/**
 * Compute the effective destinations for a record. Reads from:
 * - series registry (per-series destinations array)
 * - active processing rules (for the legacy privacy_status transform)
 * - backfill profile (for default_privacy fallback when no series matches)
 *
 * Callers not driving from a specific profile can pass null; the
 * global default fires as the fallback.
 */
export function resolveDestinations(
  record: VideoRecordJSON,
  registry: SeriesRegistryEntry[],
  rules: ProcessingRule[],
  profile: BackfillProfile | null,
): ResolvedDestinations {
  let destinations: DestinationSpec[];
  let provenance: ResolvedDestinations["provenance"];

  // Layer 1 + 2 — series match beats global default. Uses the
  // resolver-local matcher (see findMatchingSeries) so already-dated
  // titles still resolve to their series's destinations.
  const matchedSeries = findMatchingSeries(record.title, registry);
  if (matchedSeries?.destinations && matchedSeries.destinations.length > 0) {
    destinations = matchedSeries.destinations.map(d => ({ ...d }));
    provenance = { source: "series", series_name: matchedSeries.series_name };
  } else {
    // No series destinations — fallback path controlled by the
    // registry-level youtube_fallback_when_no_series_match config
    // (ADR-075 Phase 2 §Follow-up). When OFF, records not covered by
    // a series-with-destinations produce an empty destination set
    // and the publish UI hides.
    const cfg = getSeriesRegistryConfigCached();
    if (!cfg.youtube_fallback_when_no_series_match) {
      destinations = [];
      provenance = { source: "no_match_no_fallback" };
    } else if (profile) {
      // Use the profile's default_privacy on the sole YouTube
      // destination. Matches pre-Phase-2 behaviour.
      destinations = [{ platform: "YouTube", visibility: profile.default_privacy }];
      provenance = { source: "profile", profile_id: profile.id };
    } else {
      destinations = GLOBAL_DEFAULT.map(d => ({ ...d }));
      provenance = { source: "global_default" };
    }
  }

  // Layer 3 — legacy privacy_status rule transform still applies,
  // but only to the YouTube destination.
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!matchesCriteria(record, rule.criteria)) continue;
    const v = rule.transforms.privacy_status;
    if (!v) continue;
    for (const d of destinations) {
      if (d.platform === "YouTube") d.visibility = v;
    }
  }

  return { destinations, provenance };
}

/** Format a DestinationSpec for a compact single-line label. */
export function destinationLabel(d: DestinationSpec): string {
  switch (d.platform) {
    case "YouTube": return `YouTube (${d.visibility})`;
    case "Kaltura": return `Kaltura (${d.visibility})`;
    case "GoogleDrive": return `Drive folder (${d.share_scope})`;
    case "Other": return `${d.label} (manual)`;
  }
}

/**
 * Whether this destination is automated by the tool (Publish button
 * pushes it) or a manual reminder (Publish button shows a checklist
 * marker but doesn't act). Kaltura and Drive are automated once their
 * endpoints ship — currently only YouTube is; Kaltura + Drive stay
 * "manual" (checklist marker) until their endpoints land per the
 * ADR-075 §Follow-ups.
 */
export function isAutomatedDestination(d: DestinationSpec): boolean {
  return d.platform === "YouTube";
}
