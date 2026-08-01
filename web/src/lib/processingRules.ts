/**
 * Publishing attribute processing rules — ADR-014.
 * Transforms video metadata into publish attributes at upload time.
 * Non-destructive: produces an overlay; never mutates the VideoRecord.
 */

import type { VideoRecordJSON } from "./wasm";
import { matchesCriteria, type RuleCriteria } from "./rules";
import type { SeriesRegistryEntry } from "./youtubeTitleAlign";
import { getSeriesRegistryCached } from "./seriesRegistryClient";

// ── Types ─────────────────────────────────────────────────────

export type AttributeTransformMode =
  | "template"          // {{variable}} interpolation
  | "literal"           // verbatim string
  | "transcript_extract" // extractive first-N sentences from transcript
  | "transcript_llm";  // OpenRouter-powered summary (server-side)

export interface AttributeTransform {
  mode: AttributeTransformMode;
  value?: string;       // template string or literal
  max_chars?: number;   // truncation limit
}

export interface TagTransform {
  mode: "append" | "replace";
  tags: string[];
}

export type TrimSnapMode = "hour" | "half" | "quarter"; // :00 | :00/:30 | :00/:15/:30/:45

export interface TrimTransform {
  snap: TrimSnapMode;
}

export interface ProcessingTransforms {
  title?: AttributeTransform;
  description?: AttributeTransform;
  tags?: TagTransform;
  privacy_status?: "private" | "unlisted" | "public";
  trim?: TrimTransform;
}

export interface ProcessingRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  criteria: RuleCriteria;
  transforms: ProcessingTransforms;
}

export interface PublishAttributes {
  title: string;
  description: string;
  tags: string[];
  privacy_status: "private" | "unlisted" | "public";
  trim_start_seconds: number; // 0 = no trim
  /** ADR-060 — seconds to trim from the END of the recording so
   *  ADR-014 processing, ADR-059 summarisation, and the ADR-062
   *  stitched-source builder share the same post-show window
   *  from the series-registry scheduled_end_local. 0 = no end trim. */
  trim_end_seconds: number;
}

// ── Pre-processing: trim to boundary ─────────────────────────

/** Seconds to trim from the start of a recording to reach the next snap boundary. */
export function computeTrimSeconds(video: VideoRecordJSON, trim: TrimTransform): number {
  const date = new Date(video.recorded_at || video.indexed_at);
  const currentOffset = date.getMinutes() * 60 + date.getSeconds();
  if (currentOffset === 0) return 0; // already on a boundary

  const snapMinutes = trim.snap === "quarter" ? 15 : trim.snap === "half" ? 30 : 60;
  for (let b = snapMinutes * 60; b <= 3600; b += snapMinutes * 60) {
    if (b > currentOffset) return b - currentOffset;
  }
  return 3600 - currentOffset;
}

// ── Storage ───────────────────────────────────────────────────

const STORAGE_KEY = "video-sync:processing-rules";

export function loadProcessingRules(): ProcessingRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveProcessingRules(rules: ProcessingRule[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  fetch("/api/rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ processingRules: rules }),
  }).catch(() => {});
}

export async function syncProcessingRulesFromServer(): Promise<void> {
  try {
    const res = await fetch("/api/rules");
    if (!res.ok) return;
    const data = await res.json() as { processingRules?: ProcessingRule[] };
    if (data.processingRules && data.processingRules.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data.processingRules));
    } else {
      const local = loadProcessingRules();
      if (local.length > 0) saveProcessingRules(local);
    }
  } catch { /* ignore */ }
}

// ── Template engine ───────────────────────────────────────────

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function formatDate(date: Date, fmt: string): string {
  const d = date.getDate();
  const m = date.getMonth();
  const y = date.getFullYear();
  const h = date.getHours();
  const min = date.getMinutes();
  // Single-pass replace with longest tokens first — prevents "MMM"→"Mar" being
  // clobbered by the later "M"→"3" pass, which would produce "3ar" instead of "Mar".
  const tokens: Record<string, string> = {
    YYYY: String(y),
    YY:   String(y).slice(-2),
    MMMM: MONTH_NAMES[m],
    MMM:  MONTH_SHORT[m],
    MM:   String(m + 1).padStart(2, "0"),
    M:    String(m + 1),
    DD:   String(d).padStart(2, "0"),
    D:    String(d),
    ddd:  DAY_NAMES[date.getDay()].slice(0, 3),
    HH:   String(h).padStart(2, "0"),
    mm:   String(min).padStart(2, "0"),
  };
  return fmt.replace(/YYYY|YY|MMMM|MMM|MM|M|DD|D|ddd|HH|mm/g, (token) => tokens[token] ?? token);
}

function buildContext(video: VideoRecordJSON): Record<string, string> {
  const dateStr = video.recorded_at || video.indexed_at;
  const date = new Date(dateStr);
  return {
    title: video.title,
    description: video.description ?? "",
    source_platform: video.source_platform,
    duration: `${Math.floor(video.duration_seconds / 60)} min`,
    day: DAY_NAMES[date.getDay()],
    date: formatDate(date, "D MMM YYYY"),
    "date:D MMM YYYY": formatDate(date, "D MMM YYYY"),
    "date:YYYY-MM-DD": formatDate(date, "YYYY-MM-DD"),
    "date:MMMM D, YYYY": formatDate(date, "MMMM D, YYYY"),
    "date:ddd D MMM": formatDate(date, "ddd D MMM"),
    "date:D/M/YYYY": formatDate(date, "D/M/YYYY"),
    "date:MMM YYYY": formatDate(date, "MMM YYYY"),
    tags: video.tags.join(", "),
    "participants[0]": video.participants[0] ?? "",
    participants: video.participants.join(", "),
  };
}

export function renderTemplate(template: string, video: VideoRecordJSON): string {
  const ctx = buildContext(video);
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
    const trimmed = key.trim();
    return trimmed in ctx ? ctx[trimmed] : `{{${trimmed}}}`;
  });
}

// ── Transcript extract ────────────────────────────────────────

export function extractSummary(transcript: string, maxChars = 800): string {
  // Split on sentence-ending punctuation followed by whitespace or end
  const sentences = transcript.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [transcript];
  let result = "";
  for (const s of sentences) {
    if (result.length + s.length > maxChars) {
      if (result.length === 0) result = s.slice(0, maxChars);
      break;
    }
    result += s;
  }
  const trimmed = result.trim();
  return trimmed.length < transcript.trim().length ? trimmed + " …" : trimmed;
}

// ── Apply a single transform ──────────────────────────────────

function applyTransform(
  t: AttributeTransform,
  video: VideoRecordJSON,
  fallback: string,
): string {
  let result: string;
  switch (t.mode) {
    case "template":
      result = renderTemplate(t.value ?? "", video);
      break;
    case "literal":
      result = t.value ?? fallback;
      break;
    case "transcript_extract":
      result = video.transcript_text
        ? extractSummary(video.transcript_text, t.max_chars ?? 800)
        : (t.value ? renderTemplate(t.value, video) : fallback);
      break;
    case "transcript_llm":
      // LLM mode is async and handled separately via /api/process/summarize.
      // Return the fallback synchronously; callers that need LLM output
      // should call requestLlmSummary() before invoking applyProcessingRules().
      result = fallback;
      break;
    default:
      result = fallback;
  }

  if (t.max_chars && result.length > t.max_chars) {
    result = result.slice(0, t.max_chars - 1) + "…";
  }
  return result;
}

// ── ADR-060: scheduled-window derivation ──────────────────────

/**
 * Given a recorded_at timestamp + a series entry with a scheduled
 * window (local-time start/end + IANA timezone), compute the
 * offsets in seconds from the recording's t=0 to trim the pre-
 * show / post-show. Returns null when the record doesn't match
 * any windowed series or the arithmetic doesn't produce a
 * positive main-show interval.
 */
export function computeScheduledWindow(
  video: VideoRecordJSON,
  seriesRegistry: SeriesRegistryEntry[],
): { trim_start_seconds: number; trim_end_seconds: number; series_name: string } | null {
  if (!video.recorded_at) return null;
  const recordedMs = Date.parse(video.recorded_at);
  if (isNaN(recordedMs)) return null;

  // Longest series name wins — more-specific alias beats a
  // catch-all pattern. Matches resolveTitleFromRegistry's rule.
  const sorted = [...seriesRegistry].sort((a, b) => b.series_name.length - a.series_name.length);
  for (const entry of sorted) {
    if (!entry.scheduled_start_local || !entry.scheduled_end_local || !entry.scheduled_timezone) continue;
    let re: RegExp;
    try { re = new RegExp(entry.pattern, "i"); }
    catch { continue; }
    if (!re.test(video.title)) continue;

    // Resolve the wall-clock start/end for the recording's date
    // in the series's timezone.
    const startMs = wallClockToUtcMs(video.recorded_at, entry.scheduled_start_local, entry.scheduled_timezone);
    const endMs = wallClockToUtcMs(video.recorded_at, entry.scheduled_end_local, entry.scheduled_timezone);
    if (startMs == null || endMs == null) continue;

    const trimStart = Math.max(0, Math.round((startMs - recordedMs) / 1000));
    const durationSecs = video.duration_seconds || 0;
    const recordingEndMs = recordedMs + durationSecs * 1000;
    const trimEnd = Math.max(0, Math.round((recordingEndMs - endMs) / 1000));
    // Only accept when there's a positive main-show interval left.
    if (durationSecs > 0 && (trimStart + trimEnd) >= durationSecs) continue;
    return {
      trim_start_seconds: trimStart,
      trim_end_seconds: trimEnd,
      series_name: entry.series_name,
    };
  }
  return null;
}

/**
 * Convert a wall-clock time ("HH:MM" in a named timezone) on the
 * calendar date of `recordedIso` into an absolute UTC ms. Uses
 * Intl.DateTimeFormat to derive the timezone's offset on that
 * specific date (so DST is respected). Returns null on malformed
 * inputs.
 */
function wallClockToUtcMs(recordedIso: string, hhmm: string, timezone: string): number | null {
  const recordedMs = Date.parse(recordedIso);
  if (isNaN(recordedMs)) return null;
  const m = hhmm.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);

  // Extract the local (in-timezone) calendar date of the recording.
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "numeric" });
  } catch { return null; }
  const [y, mo, da] = fmt.format(new Date(recordedMs)).split("-").map(Number);
  if (!y || !mo || !da) return null;

  // Iterate to converge on the correct UTC timestamp. The trick:
  // build a candidate UTC ms for the target wall-clock time, then
  // adjust by the timezone offset at that instant. One round is
  // enough except across a DST transition, so do two.
  let utcMs = Date.UTC(y, mo - 1, da, hours, minutes, 0);
  for (let i = 0; i < 2; i++) {
    const offsetMin = tzOffsetMinutes(timezone, utcMs);
    if (offsetMin == null) return null;
    utcMs = Date.UTC(y, mo - 1, da, hours, minutes, 0) - offsetMin * 60_000;
  }
  return utcMs;
}

/** Timezone offset in minutes at the given UTC instant. */
function tzOffsetMinutes(timezone: string, utcMs: number): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(utcMs));
  } catch { return null; }
  const get = (k: string) => Number(parts.find(p => p.type === k)?.value ?? NaN);
  const y = get("year"), mo = get("month"), da = get("day");
  const h = get("hour"), mi = get("minute"), s = get("second");
  if ([y, mo, da, h, mi, s].some(isNaN)) return null;
  // `formatToParts` sometimes returns hour "24" for midnight.
  const hourNorm = h === 24 ? 0 : h;
  const localMs = Date.UTC(y, mo - 1, da, hourNorm, mi, s);
  return Math.round((localMs - utcMs) / 60_000);
}

// ── Apply all rules to produce PublishAttributes ──────────────

export function applyProcessingRules(
  rules: ProcessingRule[],
  video: VideoRecordJSON,
  /** ADR-060 — optional series registry so a scheduled-window
   *  match can derive trim_start_seconds + trim_end_seconds
   *  automatically. When omitted, the derivation is skipped and
   *  only explicit rule-based trim (t.trim) fires. */
  seriesRegistry?: SeriesRegistryEntry[],
): PublishAttributes {
  const attrs: PublishAttributes = {
    title: video.title,
    description: video.description ?? "",
    tags: [...video.tags],
    privacy_status: "unlisted",
    trim_start_seconds: 0,
    trim_end_seconds: 0,
  };

  // ADR-060 derivation runs FIRST so any explicit rule-based trim
  // below can layer on top (an operator override in the publish
  // preview still wins). Only fires when the record's title matches
  // a registered series with a full scheduled window and the
  // record has a recorded_at.
  // Registry falls back to the AppContext-warmed cache so existing
  // call-sites keep working without threading it through every
  // location that touches the publish attributes.
  const effectiveRegistry = seriesRegistry ?? getSeriesRegistryCached();
  if (effectiveRegistry.length > 0 && video.recorded_at) {
    const window = computeScheduledWindow(video, effectiveRegistry);
    if (window) {
      attrs.trim_start_seconds = window.trim_start_seconds;
      attrs.trim_end_seconds = window.trim_end_seconds;
    }
  }

  let titleSet = false;
  let descSet = false;

  const enabled = rules
    .filter((r) => r.enabled && matchesCriteria(r.criteria, video))
    .sort((a, b) => a.priority - b.priority);

  for (const rule of enabled) {
    const { transforms: t } = rule;

    if (t.title && !titleSet) {
      attrs.title = applyTransform(t.title, video, video.title);
      titleSet = true;
    }
    if (t.description && !descSet) {
      attrs.description = applyTransform(t.description, video, video.description ?? "");
      descSet = true;
    }
    if (t.tags) {
      attrs.tags = t.tags.mode === "replace"
        ? [...t.tags.tags]
        : [...new Set([...attrs.tags, ...t.tags.tags])];
    }
    if (t.privacy_status) {
      attrs.privacy_status = t.privacy_status;
    }
    if (t.trim && attrs.trim_start_seconds === 0) {
      attrs.trim_start_seconds = computeTrimSeconds(video, t.trim);
    }
  }

  return attrs;
}

// ── Post-processing rules ──────────────────────────────────────

export type PostProcessingTrigger = "success" | "failure" | "always";

export interface WebhookAction {
  type: "webhook";
  url: string;
}

export interface EmailAction {
  type: "email";
  to: string;
  subject_template?: string; // supports {{title}} and {{status}}
}

export type PostProcessingAction = WebhookAction | EmailAction;

export interface PostProcessingRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: PostProcessingTrigger;
  action: PostProcessingAction;
}

const POST_STORAGE_KEY = "video-sync:post-processing-rules";

export function loadPostProcessingRules(): PostProcessingRule[] {
  try {
    const raw = localStorage.getItem(POST_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function savePostProcessingRules(rules: PostProcessingRule[]): void {
  localStorage.setItem(POST_STORAGE_KEY, JSON.stringify(rules));
  fetch("/api/rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postProcessingRules: rules }),
  }).catch(() => {});
}

export async function syncPostProcessingRulesFromServer(): Promise<void> {
  try {
    const res = await fetch("/api/rules");
    if (!res.ok) return;
    const data = await res.json() as { postProcessingRules?: PostProcessingRule[] };
    if (data.postProcessingRules && data.postProcessingRules.length > 0) {
      localStorage.setItem(POST_STORAGE_KEY, JSON.stringify(data.postProcessingRules));
    } else {
      const local = loadPostProcessingRules();
      if (local.length > 0) savePostProcessingRules(local);
    }
  } catch { /* ignore */ }
}

/** Fire matching post-processing rules non-blocking after a YouTube upload. */
export function firePostProcessingRules(
  rules: PostProcessingRule[],
  success: boolean,
  video: VideoRecordJSON,
  youtubeUrl?: string,
  error?: string,
): void {
  const matching = rules.filter(
    (r) =>
      r.enabled &&
      (r.trigger === "always" ||
        (r.trigger === "success" && success) ||
        (r.trigger === "failure" && !success)),
  );
  for (const rule of matching) {
    fetch("/api/process/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: rule.action,
        video: {
          id: video.id,
          title: video.title,
          source_platform: video.source_platform,
          source_id: video.source_id,
          recorded_at: video.recorded_at,
          description: video.description ?? null,
          transcript_text: video.transcript_text ?? null,
        },
        success,
        youtubeUrl,
        error,
      }),
    }).catch(() => { /* best-effort — ignore network errors */ });
  }
}

// ── OpenRouter LLM summary (async, server-side) ───────────────

export interface LlmSummary {
  summary: string;
  topics: string[];
  highlights: string[];
}

function loadOpenRouterCredentials(): { apiKey?: string; model?: string } {
  try {
    const raw = localStorage.getItem("video-sync:connections");
    const conn = raw ? JSON.parse(raw) : {};
    return conn["OpenRouter"]?.credentials ?? {};
  } catch {
    return {};
  }
}

export async function requestLlmSummary(transcript: string): Promise<LlmSummary> {
  const { apiKey, model } = loadOpenRouterCredentials();
  const res = await fetch("/api/process/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript, apiKey, model }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `Summarize failed (${res.status})`);
  }
  return res.json() as Promise<LlmSummary>;
}

// ── Universal display title ──────────────────────────────────

/**
 * Apply processing rules to produce a display title for any video.
 * Returns the transformed title if rules change it, otherwise the original.
 * Safe to call from any component — lightweight, synchronous, no side effects.
 */
export function getDisplayTitle(video: VideoRecordJSON): string {
  const rules = loadProcessingRules();
  if (rules.length === 0) return video.title;
  return applyProcessingRules(rules, video).title;
}
