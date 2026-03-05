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

export interface ProcessingTransforms {
  title?: AttributeTransform;
  description?: AttributeTransform;
  tags?: TagTransform;
  privacy_status?: "private" | "unlisted" | "public";
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
  return fmt
    .replace("YYYY", String(y))
    .replace("YY", String(y).slice(-2))
    .replace("MMMM", MONTH_NAMES[m])
    .replace("MMM", MONTH_SHORT[m])
    .replace("MM", String(m + 1).padStart(2, "0"))
    .replace("M", String(m + 1))
    .replace("DD", String(d).padStart(2, "0"))
    .replace("D", String(d))
    .replace("ddd", DAY_NAMES[date.getDay()].slice(0, 3))
    .replace("HH", String(h).padStart(2, "0"))
    .replace("mm", String(min).padStart(2, "0"));
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
  }

  return attrs;
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
