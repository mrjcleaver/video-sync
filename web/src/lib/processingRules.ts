/**
 * Publishing attribute processing rules — ADR-014.
 * Transforms video metadata into publish attributes at upload time.
 * Non-destructive: produces an overlay; never mutates the VideoRecord.
 */

import type { VideoRecordJSON } from "./wasm";
import { matchesCriteria, type RuleCriteria } from "./rules";

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

// ── Apply all rules to produce PublishAttributes ──────────────

export function applyProcessingRules(
  rules: ProcessingRule[],
  video: VideoRecordJSON,
): PublishAttributes {
  const attrs: PublishAttributes = {
    title: video.title,
    description: video.description ?? "",
    tags: [...video.tags],
    privacy_status: "unlisted",
    trim_start_seconds: 0,
  };

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
