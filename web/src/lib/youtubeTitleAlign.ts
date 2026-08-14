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
  /** Discord webhook URL to post to when the operator taps the
   *  "Push to Discord" affordance on a clip/summary for a record
   *  that matches this series. Blank/omitted disables the button
   *  for the series. */
  discord_channel?: string;
  /** ADR-060 — scheduled show window. Local wall-clock start
   *  time in the show's timezone, e.g. "12:00". */
  scheduled_start_local?: string;
  /** ADR-060 — scheduled show window end, e.g. "13:30". */
  scheduled_end_local?: string;
  /** ADR-060 — IANA zone for the two wall-clock times above,
   *  e.g. "America/New_York". All three must be set for the
   *  window to take effect. */
  scheduled_timezone?: string;
  /** ADR-062 — which summary sections drive highlight extraction
   *  when building a stitched clip source. Default when omitted:
   *  ["M", "C"] (Key Moments + Chat-Sparked). */
  clip_source_sections?: Array<"M" | "L" | "T" | "C">;
  /** ADR-062 — seconds before each highlight marker to include in
   *  the extracted window. Default 30. */
  clip_highlight_radius_before_sec?: number;
  /** ADR-062 — seconds after each highlight marker to include in
   *  the extracted window. Default 90. */
  clip_highlight_radius_after_sec?: number;
  /** ADR-062 — whether the main-show window is included alongside
   *  summary highlights. Default true. Set false for a "just the
   *  highlights" build. */
  clip_include_main_show?: boolean;
  /** ADR-075 Phase 2 — destinations this series publishes to.
   *  Each entry names a platform + platform-specific visibility
   *  and config. When present, replaces the profile default_privacy
   *  for records matching this series. When absent, falls back to
   *  the profile / rule / preview override chain. */
  destinations?: DestinationSpec[];
}

/**
 * ADR-075 Phase 2 — series-driven destination spec. Discriminated
 * union by platform; each variant carries its own visibility model
 * and platform-specific config keys.
 */
export type DestinationSpec =
  | { platform: "YouTube";
      visibility: "public" | "unlisted" | "private";
      /** Optional playlist to add the video to on publish. */
      playlist_id?: string;
      /** Optional YouTube category id override. Default is category
       *  "22" (People & Blogs) matching the existing upload path. */
      category_id?: string;
    }
  | { platform: "Kaltura";
      /** Kaltura's own visibility model — public means listed in
       *  the org's KMC catalog; members means requires KMS login;
       *  unlisted is an entry created with no category membership. */
      visibility: "public" | "members" | "unlisted";
      category_ids?: string[];
    }
  | { platform: "GoogleDrive";
      /** Target folder id on the org's Shared Drive. */
      folder_id: string;
      /** File-level share scope applied after upload. "inherit"
       *  means "use whatever the folder has". */
      share_scope: "inherit" | "org_restricted" | "anyone_with_link";
    }
  | { platform: "Other";
      /** Escape hatch for a platform we haven't formalised. Surfaces
       *  as a "manual step" checklist item in Publish preview; batch
       *  publish skips it. */
      label: string;
      config?: Record<string, string>;
    };

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
  // Accept both 3-letter abbreviations and full month names. A manual
  // rename like "4 June 2026" is still a dated title even though the
  // canonical "D MMM YYYY" form we emit uses the short form.
  const monthNames = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
  const dmy = new RegExp(`\\b\\d{1,2}\\s+${monthNames}\\s+\\d{4}\\b`, "i");
  const iso = /\b\d{4}-\d{2}-\d{2}\b/;
  return dmy.test(title) || iso.test(title);
}

/**
 * Given a title (raw or aligned), return the Discord webhook URL
 * of the first matching series in the registry — or null. Uses
 * the same longest-name-wins ordering as resolveTitleFromRegistry
 * so a title that matches multiple aliases picks the most-specific
 * series's channel. Empty/absent discord_channel counts as null.
 */
export function resolveDiscordChannel(title: string, registry: SeriesRegistryEntry[]): string | null {
  if (!title) return null;
  const sorted = [...registry].sort((a, b) => b.series_name.length - a.series_name.length);
  for (const entry of sorted) {
    let re: RegExp;
    try { re = new RegExp(entry.pattern, "i"); } catch { continue; }
    if (!re.test(title)) continue;
    const dc = (entry.discord_channel ?? "").trim();
    return dc.length > 0 ? dc : null;
  }
  return null;
}

/**
 * Extract a "D MMM YYYY" date string from a title. Returns null
 * when no recognised date is present. Force-mode realign uses this
 * so a rename doesn't accidentally shift the date on records whose
 * recorded_at disagrees with the title-embedded date (a common
 * artifact of legacy ingests where recorded_at was the wall-clock
 * import time instead of the actual recording day).
 */
export function extractDateFromTitle(title: string): string | null {
  if (!title) return null;
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  // Accept short OR full month names; normalise to short in the output.
  const monthAlt = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
  const dmyRe = new RegExp(`\\b(\\d{1,2})\\s+(${monthAlt})\\s+(\\d{4})\\b`, "i");
  const dmy = title.match(dmyRe);
  if (dmy) {
    const monthPrefix = dmy[2].slice(0, 3).toLowerCase();
    const monthCanon = monthNames.find(m => m.toLowerCase() === monthPrefix)!;
    return `${Number(dmy[1])} ${monthCanon} ${dmy[3]}`;
  }
  const iso = title.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const day = Number(iso[3]);
    const month = monthNames[Number(iso[2]) - 1];
    if (!month) return null;
    return `${day} ${month} ${iso[1]}`;
  }
  return null;
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
 * ADR-056 — safe relations for title inheritance. Matches
 * ADR-053's transcript-safe set (minus ClipOf/ScreenRecordingOf,
 * which represent partial audio contexts and can't carry the full
 * record's dated identity).
 */
const TITLE_INHERITANCE_RELATIONS: ReadonlySet<string> = new Set([
  "SameEvent",
  "BroadcastedFrom",
  "TranscribedFrom",
]);

/**
 * Enumerate paired canonicals — records this record's upstream_links
 * point at via any title-inheritance-safe relation. Returns them in
 * catalog order (arbitrary but stable). The caller picks the first
 * dated one.
 *
 * ADR-055 walked BroadcastedFrom only (YouTube→Zoom). ADR-056
 * widened to SameEvent + TranscribedFrom so a Fireflies record with
 * `TranscribedFrom → Zoom` inherits Zoom's dated title, and either
 * side of a SameEvent pair can inherit the other's date.
 */
function findPairedCanonicals(record: VideoRecordJSON, allRecords: VideoRecordJSON[]): VideoRecordJSON[] {
  const out: VideoRecordJSON[] = [];
  for (const link of record.upstream_links ?? []) {
    if (!TITLE_INHERITANCE_RELATIONS.has(link.relation)) continue;
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
  // Prefer the livestream's actual/scheduled START time over
  // recorded_at whenever it's available. On some ingest paths
  // recorded_at is populated from the END of the broadcast (or from
  // publishedAt, which may be later still) — a session that started
  // 22:00 local June 4 but ended 22:58 UTC June 5 would then get
  // "5 Jun" instead of the operator-visible "4 Jun". actualStartTime
  // is the truth for a livestream; recorded_at only wins for
  // Zoom/Fireflies/Kaltura ingests (which don't populate these keys).
  const me = (record.metadata_extra ?? {}) as Record<string, unknown>;
  const liveStart = typeof me.actual_start_time === "string" ? me.actual_start_time
                  : typeof me.scheduled_start_time === "string" ? me.scheduled_start_time
                  : null;
  const when = liveStart ?? record.recorded_at ?? record.indexed_at ?? "";
  return resolveTitleFromRegistry(record.title, when, registry);
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
  opts?: { force?: boolean },
): AlignedTitle | null {
  // In default mode we skip already-dated titles — the primary
  // ingest resolver wants a clean gate so records aren't churned
  // between series each time an alias fires. In force mode
  // (per-record realign, bulk "include already-dated") we skip
  // the gate so an operator can retire an old series_name in
  // favour of a newly-added alias.
  if (!opts?.force && titleContainsDate(title)) return null;
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
    // Date-picking rule: in force mode, if the current title
    // already carries a date, PRESERVE it — the operator asked to
    // rename the series, not shift the date. Some legacy records
    // have `recorded_at` = ingest day, not recording day; using it
    // here would silently corrupt otherwise-correct titles. Only
    // fall back to recorded_at when no date is embedded (which is
    // the normal case for undated ingest titles).
    let dated: string | null = null;
    if (opts?.force) {
      dated = extractDateFromTitle(title);
    }
    if (!dated) dated = formatDMMMYYYY(recordedAt) || null;
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
  // ADR-056 — ADR-055's YouTube-only gate was too narrow; the
  // undated-series problem affects Fireflies and Zoom too. Now
  // applies to any source platform.
  if (titleContainsDate(record.title)) return null;

  return tryStrategyPairedCanonical(record, allRecords)
      ?? tryStrategyRegistry(record, registry);
}

/**
 * "Force" variant used by the per-record realign button and the
 * bulk maintenance card in alias-widen mode. In addition to the
 * regular resolver, this ALSO tries the raw platform-supplied
 * title (metadata_extra.<platform>_original_title) even when the
 * current title is already dated — the "operator just added a new
 * alias and wants the existing dated titles switched to the new
 * canonical name" case that the primary resolver deliberately
 * skips. Returns null when no proposal differs from the current
 * title.
 */
export function resolveAlignedTitleForced(
  record: VideoRecordJSON,
  allRecords: VideoRecordJSON[],
  registry: SeriesRegistryEntry[],
): AlignedTitle | null {
  const primary = resolveAlignedTitle(record, allRecords, registry);
  if (primary) return primary;
  if (!record.recorded_at) return null;
  // Force-run the registry against the current title even if it's
  // already dated. Handles "operator added a new alias and wants
  // records renamed to the new canonical name."
  const directForced = resolveTitleFromRegistry(record.title, record.recorded_at, registry, { force: true });
  if (directForced && directForced.new_title !== record.title) return directForced;
  const meta = (record.metadata_extra ?? {}) as Record<string, unknown>;
  const KEYS = [
    "youtube_original_title",
    "zoom_original_title",
    "fireflies_original_title",
    "kaltura_original_title",
  ];
  for (const key of KEYS) {
    const raw = meta[key];
    if (typeof raw !== "string" || !raw.trim() || raw === record.title) continue;
    const attempt = resolveTitleFromRegistry(raw, record.recorded_at, registry, { force: true });
    if (attempt && attempt.new_title !== record.title) return attempt;
  }
  return null;
}
