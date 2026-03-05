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

  if (c.days_of_week && c.days_of_week.length > 0) {
    const day = new Date(video.created_at).getDay();
    if (!c.days_of_week.includes(day)) return false;
  }

  if (c.time_range) {
    const d = new Date(video.created_at);
    const hhmm = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    if (c.time_range.after && hhmm < c.time_range.after) return false;
    if (c.time_range.before && hhmm > c.time_range.before) return false;
  }

  if (c.min_duration_secs != null && video.duration_seconds < c.min_duration_secs) return false;
  if (c.max_duration_secs != null && video.duration_seconds > c.max_duration_secs) return false;

  if (c.date_from) {
    const from = new Date(c.date_from).getTime();
    if (new Date(video.created_at).getTime() < from) return false;
  }

  if (c.date_to) {
    const to = new Date(c.date_to).getTime();
    if (new Date(video.created_at).getTime() > to) return false;
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
