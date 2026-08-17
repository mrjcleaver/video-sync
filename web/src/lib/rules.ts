/**
 * Ingestion rules engine — types, localStorage persistence, and evaluation.
 * ADR-013 MVP / Tier 1 (browser-only).
 */

import type { VideoRecordJSON } from "./wasm";

// ── Types ────────────────────────────────────────────────

export interface RuleCriteria {
  title_pattern?: string;
  title_exclude?: string;
  days_of_week?: number[]; // 0=Sun … 6=Sat
  time_range?: { after: string; before: string }; // "HH:MM"
  min_duration_secs?: number;
  max_duration_secs?: number;
  date_from?: string; // ISO date
  date_to?: string;   // ISO date
  source_platforms?: string[]; // e.g. ["Zoom","Fireflies"] — empty/absent = any
}

export type RuleAction = "mark_in_scope" | "auto_approve" | "auto_skip";

export interface IngestionRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  criteria: RuleCriteria;
  action: RuleAction;
}

export interface ExclusionEntry {
  source_platform: string;
  source_id: string;
  excluded_at: string;
  reason?: string;
}

// ── Storage keys ─────────────────────────────────────────

const RULES_KEY = "video-sync:rules";
const EXCLUSIONS_KEY = "video-sync:exclusions";

// ── Rules CRUD ───────────────────────────────────────────

export function loadRules(): IngestionRule[] {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveRules(rules: IngestionRule[]): void {
  localStorage.setItem(RULES_KEY, JSON.stringify(rules));
  fetch("/api/rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ingestionRules: rules }),
  }).catch(() => {}); // best-effort; localStorage is the primary store
}

/** Hydrate localStorage from server (call on app boot). Server wins if non-empty. */
export async function syncRulesFromServer(): Promise<void> {
  try {
    const res = await fetch("/api/rules");
    if (!res.ok) return;
    const data = await res.json() as { ingestionRules?: IngestionRule[] };
    if (data.ingestionRules && data.ingestionRules.length > 0) {
      localStorage.setItem(RULES_KEY, JSON.stringify(data.ingestionRules));
    } else {
      // push local rules to server so they're persisted going forward
      const local = loadRules();
      if (local.length > 0) saveRules(local);
    }
  } catch { /* offline or server error — ignore */ }
}

// ── Exclusions ───────────────────────────────────────────

export function loadExclusions(): ExclusionEntry[] {
  try {
    const raw = localStorage.getItem(EXCLUSIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveExclusions(entries: ExclusionEntry[]): void {
  localStorage.setItem(EXCLUSIONS_KEY, JSON.stringify(entries));
  // ADR-043: write-through to server so Bob doesn't re-import what
  // Alice already excluded. Best-effort; localStorage is the primary.
  fetch("/api/exclusions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entries),
  }).catch(() => { /* offline — ignore */ });
}

/** ADR-043: hydrate localStorage from server on boot. Server-wins-if-non-empty. */
export async function syncExclusionsFromServer(): Promise<void> {
  try {
    const res = await fetch("/api/exclusions", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json() as ExclusionEntry[];
    if (Array.isArray(data) && data.length > 0) {
      localStorage.setItem(EXCLUSIONS_KEY, JSON.stringify(data));
    } else {
      const local = loadExclusions();
      if (local.length > 0) saveExclusions(local);
    }
  } catch { /* offline — ignore */ }
}

export function addExclusion(
  platform: string,
  sourceId: string,
  reason?: string
): void {
  const list = loadExclusions();
  if (list.some((e) => e.source_platform === platform && e.source_id === sourceId)) {
    return; // already excluded
  }
  list.push({
    source_platform: platform,
    source_id: sourceId,
    excluded_at: new Date().toISOString(),
    reason,
  });
  saveExclusions(list);
}

export function isExcluded(platform: string, sourceId: string): boolean {
  return loadExclusions().some(
    (e) => e.source_platform === platform && e.source_id === sourceId
  );
}

/**
 * Remove any exclusion pinned to (platform, sourceId). Returns the
 * number of entries removed (0 or 1 in practice, but robust to any
 * accidental duplicates). Used by VideoCard's Delete flow so a
 * deleted record can be re-imported cleanly — Delete means "start
 * over", and a lingering exclusion would silently block re-ingest.
 */
export function removeExclusion(platform: string, sourceId: string): number {
  const list = loadExclusions();
  const next = list.filter(
    (e) => !(e.source_platform === platform && e.source_id === sourceId),
  );
  const removed = list.length - next.length;
  if (removed > 0) saveExclusions(next);
  return removed;
}

// ── Rule matching ────────────────────────────────────────

export function matchesCriteria(c: RuleCriteria, video: VideoRecordJSON): boolean {

  if (c.title_pattern) {
    try {
      if (!new RegExp(c.title_pattern, "i").test(video.title)) return false;
    } catch {
      if (!video.title.toLowerCase().includes(c.title_pattern.toLowerCase())) return false;
    }
  }

  if (c.title_exclude) {
    try {
      if (new RegExp(c.title_exclude, "i").test(video.title)) return false;
    } catch {
      if (video.title.toLowerCase().includes(c.title_exclude.toLowerCase())) return false;
    }
  }

  // Date-based criteria evaluate against when the meeting was actually
  // recorded, NOT when this record was added to the catalog. For 18-month
  // backfills the difference matters: an import done today of a video
  // recorded last Friday should match a "Friday only" rule.
  const eventTimeStr = video.recorded_at ?? video.indexed_at ?? video.created_at;
  const eventTime = new Date(eventTimeStr);

  if (c.days_of_week && c.days_of_week.length > 0) {
    if (!c.days_of_week.includes(eventTime.getDay())) return false;
  }

  if (c.time_range) {
    const hhmm = `${eventTime.getHours().toString().padStart(2, "0")}:${eventTime.getMinutes().toString().padStart(2, "0")}`;
    if (c.time_range.after && hhmm < c.time_range.after) return false;
    if (c.time_range.before && hhmm > c.time_range.before) return false;
  }

  if (c.source_platforms && c.source_platforms.length > 0) {
    if (!c.source_platforms.includes(video.source_platform)) return false;
  }

  if (c.min_duration_secs != null && video.duration_seconds < c.min_duration_secs) return false;
  if (c.max_duration_secs != null && video.duration_seconds > c.max_duration_secs) return false;

  if (c.date_from) {
    const from = new Date(c.date_from).getTime();
    if (eventTime.getTime() < from) return false;
  }

  if (c.date_to) {
    const to = new Date(c.date_to).getTime();
    if (eventTime.getTime() > to) return false;
  }

  return true;
}

export function matchesRule(rule: IngestionRule, video: VideoRecordJSON): boolean {
  return matchesCriteria(rule.criteria, video);
}

// ── Rule runner ──────────────────────────────────────────

export interface RuleRunResult {
  matched: Map<string, string>; // videoId → ruleId
  actions: Array<{ videoId: string; action: RuleAction; ruleId: string }>;
}

export function runRules(
  rules: IngestionRule[],
  videos: VideoRecordJSON[]
): RuleRunResult {
  const enabledRules = rules
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority);

  const matched = new Map<string, string>();
  const actions: RuleRunResult["actions"] = [];

  for (const video of videos) {
    // Only evaluate Discovered videos (rules move them to InScope/Approved/Skipped)
    if (video.status !== "Discovered") continue;

    for (const rule of enabledRules) {
      if (matchesRule(rule, video)) {
        matched.set(video.id, rule.id);
        actions.push({ videoId: video.id, action: rule.action, ruleId: rule.id });
        break; // first matching rule wins
      }
    }
  }

  return { matched, actions };
}
