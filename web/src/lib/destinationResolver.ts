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
 *
 * ADR-077 §2 — the layering logic is pure: `resolveDestinationsWith`
 * takes every input explicitly and touches no browser API, so server
 * routes, cron jobs and MCP tools can resolve a record's destinations
 * (see destinationResolverServer.ts). `resolveDestinations` keeps the
 * original signature for client callers and supplies the registry
 * config from the AppContext-warmed cache.
 */

import type { VideoRecordJSON } from "./wasm";
import type { DestinationSpec, SeriesRegistryEntry } from "./youtubeTitleAlign";
import { getSeriesRegistryConfigCached, type SeriesRegistryConfig } from "./seriesRegistryClient";
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

/** Every input the layering needs, passed explicitly. ADR-077 §2 —
 *  keeping this a plain record is what makes the resolver callable
 *  from a server route, where there is no localStorage to read rules
 *  from and no warmed registry cache. */
export interface ResolverInputs {
  registry: SeriesRegistryEntry[];
  rules: ProcessingRule[];
  /** Backfill profile driving this publish, for the legacy
   *  default_privacy fallback. null when no profile is in play. */
  profile: BackfillProfile | null;
  config: SeriesRegistryConfig;
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
  return resolveDestinationsWith(record, {
    registry,
    rules,
    profile,
    config: getSeriesRegistryConfigCached(),
  });
}

/**
 * The pure layering core. Same rules as resolveDestinations, but every
 * input is supplied by the caller, so this function has no dependency
 * on localStorage, fetch, or the warmed registry cache.
 *
 * Server callers should go through destinationResolverServer.ts, which
 * loads the inputs from FUSE and calls this.
 */
export function resolveDestinationsWith(
  record: VideoRecordJSON,
  inputs: ResolverInputs,
): ResolvedDestinations {
  const { registry, rules, profile, config } = inputs;
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
    if (!config.youtube_fallback_when_no_series_match) {
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
    // Arguments were swapped: the signature is (criteria, video). Passing the
    // record as `criteria` meant every `if (c.<field>)` guard saw undefined,
    // so the function fell through to `return true` for EVERY rule — each
    // enabled rule's privacy_status applied to every record regardless of its
    // criteria. Correcting the order restores criteria matching.
    if (!matchesCriteria(rule.criteria, record)) continue;
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
 * Whether the tool can push the media to this destination itself, or
 * whether Publish can only show a checklist marker for an operator to
 * action by hand.
 *
 * All three real platforms now have push endpoints, so all three are
 * automated:
 *   YouTube      → /api/youtube/upload
 *   Kaltura      → /api/kaltura/upload  (ADR-037)
 *   GoogleDrive  → /api/drive/publish   (ADR-075 §Follow-up #4)
 *
 * `Other` is the declared-but-not-wired escape hatch and stays manual
 * by design — that's the whole point of the variant.
 *
 * This returned YouTube-only until 2026-08-23, long after the Kaltura
 * and Drive endpoints shipped, so the Publish preview was labelling
 * working automation "⚠ manual".
 *
 * NOTE: "automated" here means the MEDIA gets pushed. It does not mean
 * the destination's declared visibility is applied — see
 * appliesDeclaredVisibility below.
 */
export function isAutomatedDestination(d: DestinationSpec): boolean {
  return d.platform === "YouTube"
    || d.platform === "Kaltura"
    || d.platform === "GoogleDrive";
}

/**
 * Whether pushing this destination also applies the visibility the
 * series declared for it.
 *
 * YouTube and Drive do; Kaltura does not:
 *
 *   YouTube      — /api/youtube/upload takes `privacyStatus` and sets it.
 *   GoogleDrive  — /api/drive/publish applies the declared share_scope as a
 *                  file permission and reads the result back (ADR-077 §5).
 *   Kaltura      — the upload body carries categoryIds but no access-control
 *                  id, so a declared `public` / `members` / `unlisted` never
 *                  reaches the entry. The ids are partner-specific, so
 *                  closing this needs the mapping from the org's KMC
 *                  administrator — the one ADR-077 dependency outside
 *                  engineering.
 *
 * Kept separate from isAutomatedDestination so the Publish preview can
 * tell an operator "we'll upload it, you still have to set visibility"
 * instead of implying the declaration was honoured end to end.
 */
export function appliesDeclaredVisibility(d: DestinationSpec): boolean {
  return d.platform === "YouTube" || d.platform === "GoogleDrive";
}
