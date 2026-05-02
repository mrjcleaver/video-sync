/**
 * Backfill types, storage helpers, queue management, and calendar utilities.
 * ADR-016 — Retrospective Backfill Uploader (MVP + Tier 1).
 */

import type { VideoRecordJSON } from "./wasm";
import { loadProcessingRules, applyProcessingRules, type PublishAttributes } from "./processingRules";

// ── Types ──────────────────────────────────────────────────────────────────

export interface BackfillCriteria {
  days_of_week?: number[];         // 0=Sun…6=Sat; e.g. [4,5] for Thu/Fri
  min_duration_minutes?: number;   // e.g. 45
  max_duration_minutes?: number;   // e.g. 120
  title_pattern?: string;          // regex
}

export interface BackfillProfile {
  id: string;
  name: string;
  enabled: boolean;
  source_platforms: string[];      // ["Zoom","Fireflies","Loom"]
  date_from: string;               // ISO date "YYYY-MM-DD"
  date_to?: string;                // defaults to today
  criteria: BackfillCriteria;
  default_privacy: "private" | "unlisted" | "public";
  processing_rule_id?: string;
  max_uploads_per_day: number;
  upload_window_start_hour: number; // UTC hour to begin (0–23)
}

export interface BackfillQueueEntry {
  video_id: string;
  profile_id: string;
  queued_at: string;
  retry_after?: string;   // ISO datetime — skip until this time
  attempts: number;
}

export interface BackfillClientState {
  uploads_today: number;
  last_reset_date: string; // "YYYY-MM-DD" UTC
}

export interface CalendarSlot {
  date: string;          // "YYYY-MM-DD"
  day_of_week: number;
  is_target: boolean;
  video?: {
    id: string;
    title: string;
    duration_seconds: number;
    source_platform: string;
    status: string;
    origin_url?: string;   // source download URL (may be pseudo-URL)
    youtube_url?: string;  // destination URL on YouTube
    kaltura_url?: string;  // destination URL on Kaltura
  };
}

export interface TickResponse {
  can_upload: boolean;
  next_id: string | null;
  uploads_today: number;
  quota_limit: number;
  window_open: boolean;
  reason?: string;
}

// ── Storage keys ───────────────────────────────────────────────────────────

const PROFILES_KEY = "video-sync:backfill-profiles";
const QUEUE_KEY    = "video-sync:backfill-queue";
const STATE_KEY    = "video-sync:backfill-state";

export function loadProfiles(): BackfillProfile[] {
  try { return JSON.parse(localStorage.getItem(PROFILES_KEY) || "[]"); } catch { return []; }
}
export function saveProfiles(profiles: BackfillProfile[]) {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  // ADR-043: write-through to server. Best-effort; localStorage is the
  // primary cache and survives network failures.
  fetch("/api/backfill/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profiles),
  }).catch(() => { /* offline / 5xx — ignore */ });
}

/** ADR-043: hydrate localStorage from server on boot. Server wins
 *  when non-empty; otherwise push local up to seed the server. */
export async function syncProfilesFromServer(): Promise<void> {
  try {
    const res = await fetch("/api/backfill/profiles", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json() as BackfillProfile[];
    if (Array.isArray(data) && data.length > 0) {
      localStorage.setItem(PROFILES_KEY, JSON.stringify(data));
    } else {
      const local = loadProfiles();
      if (local.length > 0) saveProfiles(local);
    }
  } catch { /* offline — ignore */ }
}

export function loadQueue(): BackfillQueueEntry[] {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch { return []; }
}
export function saveQueue(queue: BackfillQueueEntry[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  fetch("/api/backfill/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(queue),
  }).catch(() => { /* offline — ignore */ });
}

export async function syncQueueFromServer(): Promise<void> {
  try {
    const res = await fetch("/api/backfill/queue", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json() as BackfillQueueEntry[];
    if (Array.isArray(data) && data.length > 0) {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(data));
    } else {
      const local = loadQueue();
      if (local.length > 0) saveQueue(local);
    }
  } catch { /* offline — ignore */ }
}

export function loadClientState(): BackfillClientState {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) || "{}"); }
  catch { return { uploads_today: 0, last_reset_date: "" }; }
}
export function saveClientState(s: BackfillClientState) {
  localStorage.setItem(STATE_KEY, JSON.stringify(s));
}

// ── Matching ───────────────────────────────────────────────────────────────

export function matchesProfile(video: VideoRecordJSON, profile: BackfillProfile): boolean {
  if (!profile.enabled) return false;

  const dateStr = video.recorded_at || video.indexed_at;
  const dateOnly = dateStr.slice(0, 10);

  if (profile.date_from && dateOnly < profile.date_from) return false;
  if (profile.date_to   && dateOnly > profile.date_to)   return false;

  if (profile.source_platforms.length > 0 &&
      !profile.source_platforms.includes(video.source_platform)) return false;

  const { criteria: c } = profile;
  // Parse as local time to avoid UTC→local day-of-week shift
  if (c.days_of_week?.length) {
    const [y, m, d] = dateOnly.split("-").map(Number);
    const dow = new Date(y, m - 1, d).getDay();
    if (!c.days_of_week.includes(dow)) return false;
  }

  const mins = video.duration_seconds / 60;
  if (c.min_duration_minutes != null && mins < c.min_duration_minutes) return false;
  if (c.max_duration_minutes != null && mins > c.max_duration_minutes) return false;

  if (c.title_pattern) {
    try { if (!new RegExp(c.title_pattern, "i").test(video.title)) return false; } catch { /* skip bad regex */ }
  }
  return true;
}

// ── Queue management ───────────────────────────────────────────────────────

/** Add Approved videos matching any profile to the queue (skip already queued). */
export function populateQueue(videos: VideoRecordJSON[], profiles: BackfillProfile[]): number {
  const queue = loadQueue();
  const queued = new Set(queue.map((e) => e.video_id));
  let added = 0;

  for (const video of videos) {
    if (video.status !== "Approved" && video.status !== "ToRetry") continue;
    if (queued.has(video.id)) continue;

    for (const profile of profiles) {
      if (!profile.enabled) continue;
      if (matchesProfile(video, profile)) {
        queue.push({ video_id: video.id, profile_id: profile.id, queued_at: new Date().toISOString(), attempts: 0 });
        queued.add(video.id);
        added++;
        break;
      }
    }
  }

  if (added > 0) saveQueue(queue);
  return added;
}

/** Return the ready entries (retry_after has passed), oldest first. */
export function readyQueue(queue: BackfillQueueEntry[]): BackfillQueueEntry[] {
  const now = new Date().toISOString();
  return queue
    .filter((e) => !e.retry_after || e.retry_after <= now)
    .sort((a, b) => a.queued_at.localeCompare(b.queued_at));
}

export function removeFromQueue(videoId: string) {
  saveQueue(loadQueue().filter((e) => e.video_id !== videoId));
}

export function markQueueEntryFailed(videoId: string, delayDays = 1) {
  const queue = loadQueue();
  const entry = queue.find((e) => e.video_id === videoId);
  if (entry) {
    entry.attempts += 1;
    entry.retry_after = new Date(Date.now() + delayDays * 86400000).toISOString();
    saveQueue(queue);
  }
}

// ── Publish attributes ─────────────────────────────────────────────────────

export function computePublishAttrs(
  video: VideoRecordJSON,
  profile: BackfillProfile,
): PublishAttributes {
  const rules = loadProcessingRules();
  const attrs = applyProcessingRules(rules, video);
  // Override privacy from profile if not already set by a rule
  if (!rules.some((r) => r.enabled && r.transforms.privacy_status)) {
    attrs.privacy_status = profile.default_privacy;
  }
  return attrs;
}

// ── Calendar ───────────────────────────────────────────────────────────────

/** Classify a destination URL by host so we can split the legacy
 *  singular `destination_url` between YouTube and Kaltura badges. */
function classifyDestinationUrl(url: string): "youtube" | "kaltura" | "unknown" {
  if (/(youtube\.com|youtu\.be)/i.test(url)) return "youtube";
  if (/kaltura\.com/i.test(url)) return "kaltura";
  return "unknown";
}

function videoSlotPayload(v: VideoRecordJSON): NonNullable<CalendarSlot["video"]> {
  const ytLoc = v.locations?.find(l => l.platform === "YouTube" && l.role === "Destination");
  const kalLoc = v.locations?.find(l => l.platform === "Kaltura" && l.role === "Destination");
  const ytFromLoc = ytLoc?.external_url
    ?? (ytLoc?.external_id ? `https://www.youtube.com/watch?v=${ytLoc.external_id}` : undefined);
  const kalFromLoc = kalLoc?.external_url ?? undefined;

  // Legacy single destination_url field — older records that pre-date the
  // locations[] design. Classify by URL host so a Kaltura URL doesn't get
  // mis-shown as a YouTube badge (or vice versa).
  let ytFromLegacy: string | undefined;
  let kalFromLegacy: string | undefined;
  if (v.destination_url) {
    const kind = classifyDestinationUrl(v.destination_url);
    if (kind === "youtube" && !ytFromLoc) ytFromLegacy = v.destination_url;
    else if (kind === "kaltura" && !kalFromLoc) kalFromLegacy = v.destination_url;
    else if (kind === "unknown" && !ytFromLoc && !kalFromLoc) ytFromLegacy = v.destination_url;
  }

  return {
    id: v.id, title: v.title, duration_seconds: v.duration_seconds,
    source_platform: v.source_platform, status: v.status,
    origin_url: v.download_url || undefined,
    youtube_url: ytFromLoc ?? ytFromLegacy,
    kaltura_url: kalFromLoc ?? kalFromLegacy,
  };
}

export function buildCalendarMonth(
  videos: VideoRecordJSON[],
  profile: BackfillProfile,
  year: number,
  month: number, // 0-indexed
): CalendarSlot[] {
  const targetDays = profile.criteria.days_of_week ?? [4, 5];

  // Index ALL videos by recorded date. We now keep every video that lands
  // on a date (multiple per day allowed) — each emits its own row in the
  // Overview, sorted by status rank descending so the most-progressed
  // record is on top. Profile criteria don't filter; they only determine
  // target days for the gap-vs-coverage view.
  const byDate = new Map<string, VideoRecordJSON[]>();
  for (const v of videos) {
    const key = (v.recorded_at || v.indexed_at).slice(0, 10);
    const arr = byDate.get(key);
    if (arr) arr.push(v);
    else byDate.set(key, [v]);
  }
  for (const arr of byDate.values()) {
    arr.sort((a, b) => statusRank(b.status) - statusRank(a.status));
  }

  const slots: CalendarSlot[] = [];
  const last = new Date(year, month + 1, 0).getDate();
  const today = new Date().toISOString().slice(0, 10);

  for (let d = 1; d <= last; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (dateStr > today) break; // don't show future
    const dow = new Date(year, month, d).getDay();
    const inRange = dateStr >= profile.date_from && (!profile.date_to || dateStr <= profile.date_to);
    const isTarget = inRange && targetDays.includes(dow);
    const dayVideos = byDate.get(dateStr);

    if (dayVideos && dayVideos.length > 0) {
      // Emit one slot per video on this date — Kaltura videos no longer
      // hide behind same-day Zoom records.
      for (const v of dayVideos) {
        slots.push({
          date: dateStr,
          day_of_week: dow,
          is_target: isTarget,
          video: videoSlotPayload(v),
        });
      }
    } else {
      // Empty slot — target-day gap or non-target empty day.
      slots.push({
        date: dateStr,
        day_of_week: dow,
        is_target: isTarget,
        video: undefined,
      });
    }
  }
  return slots;
}

function statusRank(s: string): number {
  return { Published: 6, Publishing: 5, Approved: 4, InScope: 3, Discovered: 2, Failed: 1, Skipped: 0 }[s] ?? 0;
}

export function statusColor(status: string | undefined): string {
  if (!status) return "var(--text-muted)";
  return {
    Published: "var(--green)",
    Publishing: "#4fa3e0",
    Approved: "#a78bfa",
    InScope: "#fbbf24",
    Discovered: "var(--text-muted)",
    Failed: "var(--red)",
    ToRetry: "#f97316",
    Skipped: "var(--text-muted)",
  }[status] ?? "var(--text-muted)";
}

// ── Multi-month overview ──────────────────────────────────────────────────

export interface MonthSummary {
  year: number;
  month: number;         // 0-indexed
  label: string;         // "Jan 2025"
  target_days: number;   // total target slots in this month
  published: number;
  approved: number;
  in_backlog: number;    // InScope + Discovered
  failed: number;
  gaps: number;          // target days with no video
  slots: CalendarSlot[];
}

/** Build summaries for every month in the profile's date range. */
export function buildCalendarOverview(
  videos: VideoRecordJSON[],
  profile: BackfillProfile,
): MonthSummary[] {
  const from = profile.date_from;
  const to = profile.date_to || new Date().toISOString().slice(0, 10);

  const [startY, startM] = from.split("-").map(Number);
  const [endY, endM] = to.split("-").map(Number);

  const summaries: MonthSummary[] = [];
  let y = startY, m = startM - 1; // 0-indexed month

  while (y < endY || (y === endY && m <= endM - 1)) {
    const slots = buildCalendarMonth(videos, profile, y, m);
    // Multiple slots per date are possible (one per video on that date),
    // so target_days and gaps must dedupe by date — counting days, not rows.
    const targetDates = new Set<string>();
    const targetDatesWithVideo = new Set<string>();
    for (const s of slots) {
      if (!s.is_target) continue;
      targetDates.add(s.date);
      if (s.video) targetDatesWithVideo.add(s.date);
    }
    const targetSlotsWithVideo = slots.filter(s => s.is_target && s.video);
    summaries.push({
      year: y,
      month: m,
      label: `${MONTH_NAMES_SHORT[m]} ${y}`,
      target_days: targetDates.size,
      published: targetSlotsWithVideo.filter(s => s.video?.status === "Published").length,
      approved: targetSlotsWithVideo.filter(s => s.video?.status === "Approved" || s.video?.status === "Publishing").length,
      in_backlog: targetSlotsWithVideo.filter(s => s.video && (s.video.status === "InScope" || s.video.status === "Discovered")).length,
      failed: targetSlotsWithVideo.filter(s => s.video?.status === "Failed" || s.video?.status === "ToRetry").length,
      gaps: targetDates.size - targetDatesWithVideo.size,
      slots,
    });
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return summaries;
}

const MONTH_NAMES_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
