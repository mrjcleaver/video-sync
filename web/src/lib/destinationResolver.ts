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
import { resolveTitleFromRegistry } from "./youtubeTitleAlign";
import type { ProcessingRule } from "./processingRules";
import { matchesCriteria } from "./rules";
import type { BackfillProfile } from "./backfill";

export interface ResolvedDestinations {
  destinations: DestinationSpec[];
  /** Which layer produced this set — useful for the Publish preview
   *  to show "from series X" / "profile default" / "operator added". */
  provenance:
    | { source: "series"; series_name: string }
    | { source: "profile"; profile_id: string }
    | { source: "global_default" };
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
  const aligned = resolveTitleFromRegistry(record.title, record.recorded_at ?? record.indexed_at, registry);

  let destinations: DestinationSpec[];
  let provenance: ResolvedDestinations["provenance"];

  // Layer 1 + 2 — series match beats global default.
  const matchedSeries = aligned?.matched_series
    ? registry.find(r => r.series_name === aligned.matched_series)
    : null;
  if (matchedSeries?.destinations && matchedSeries.destinations.length > 0) {
    destinations = matchedSeries.destinations.map(d => ({ ...d }));
    provenance = { source: "series", series_name: matchedSeries.series_name };
  } else if (profile) {
    // No series destinations — use the profile's default_privacy on
    // the sole YouTube destination. Matches pre-Phase-2 behaviour.
    destinations = [{ platform: "YouTube", visibility: profile.default_privacy }];
    provenance = { source: "profile", profile_id: profile.id };
  } else {
    destinations = GLOBAL_DEFAULT.map(d => ({ ...d }));
    provenance = { source: "global_default" };
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
