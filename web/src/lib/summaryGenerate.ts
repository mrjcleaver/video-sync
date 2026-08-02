/**
 * ADR-046 — per-record summary generation extracted into a library so
 * both /api/summary/generate (single-record) and the bulk-regen flow
 * (slice 4) call the same code.
 */

import { serverLog } from "./serverLogger";
import { getSharedCredential } from "./sharedCredentials";
import { getCurrentPrompt, type SummaryPromptVersion } from "./summaryPrompt";
import { getArtifact, setSummaryDoc, type RecordContext } from "./driveArtifactStore";
import type { SummaryCountsJSON } from "./wasm";
import { sliceTranscriptFromSeconds, sliceTranscriptToSeconds } from "./transcriptSlice";

// Cap transcript size to keep one-shot generation tractable. Two-pass
// strategy for very long transcripts is deferred per ADR-046's slice
// scope; single-pass with truncation is the slice-2/slice-4 contract.
const MAX_TRANSCRIPT_CHARS = 400_000;  // ~100K tokens
const MAX_CHAT_CHARS = 100_000;

const FALLBACK_MODEL = "anthropic/claude-haiku-4-5";

export interface GenerateRecordResult {
  doc_id: string;
  doc_url?: string;
  prompt_version: number;
  counts: SummaryCountsJSON;
  model: string;
  generated_at: string;
  duration_ms: number;
  /** ADR-059 — the trim window applied to the transcript before
   *  the LLM saw it. 0 = no trim (or the record's processing rule
   *  produced 0). Recorded so a rule change can be detected as
   *  staleness later. */
  trim_start_seconds: number;
  /** ADR-060 — matching tail trim (from record end). */
  trim_end_seconds: number;
}

export class GenerateError extends Error {
  constructor(message: string, public readonly httpStatus: number, public readonly code?: string) {
    super(message);
    this.name = "GenerateError";
  }
}

/**
 * Count bullets under each of the four section headings, regardless of
 * how the model nested them inside chapter wrappers.
 */
export function parseSectionCounts(markdown: string): SummaryCountsJSON {
  const counts: SummaryCountsJSON = { m: 0, l: 0, t: 0, c: 0 };
  let current: keyof SummaryCountsJSON | null = null;

  // Match section headings tolerantly. Accept:
  //   ## Key Moments        (level 2-6 hash headings)
  //   ### Key Moments
  //   **Key Moments**       (bold-only "heading" — Haiku sometimes emits this)
  //   Key Moments:          (plain line ending in colon)
  const HEADING_RES = [
    /^#{2,6}\s+(.+?)\s*$/,
    /^\*\*(.+?)\*\*\s*:?\s*$/,
    /^(.+?):\s*$/,
  ];
  const classify = (rawTitle: string): keyof SummaryCountsJSON | null => {
    const t = rawTitle.toLowerCase().replace(/[*_]/g, "").trim();
    if (t.includes("moment") || t.includes("highlight")) return "m";
    if (t.includes("learning") || t.includes("lesson") || t.includes("insight")) return "l";
    if (t.includes("takeaway") || t.includes("action") || t.includes("theme")) return "t";
    if (t.includes("chat")) return "c";
    return null;
  };

  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;

    let matchedHeading: string | null = null;
    for (const re of HEADING_RES) {
      const m = line.match(re);
      if (m) { matchedHeading = m[1]; break; }
    }
    // Only treat plain "Title:" lines as headings when they classify —
    // otherwise `Speaker A:` inside a bullet's paragraph gets misread.
    if (matchedHeading) {
      const which = classify(matchedHeading);
      if (which) { current = which; continue; }
      // Non-classifying heading (chapter title, etc.) — reset section.
      if (line.startsWith("#") || /^\*\*.+\*\*\s*:?\s*$/.test(line)) current = null;
    }

    if (!current) continue;

    // Count any line inside the current section that contains a
    // timestamp marker — every bullet per the prompt starts with
    // `[HH:MM:SS]`, so counting timestamps is robust against variations
    // in bullet style (`- `, `* `, `1. `, or an indented paragraph).
    if (/\[\d{1,2}:\d{2}(?::\d{2})?\]/.test(line)) counts[current]++;
  }
  return counts;
}

/**
 * Run a single-record summary generation. Throws GenerateError with a
 * httpStatus matching the original route's error mapping so callers can
 * preserve status codes when surfacing the failure.
 *
 * Optional `prompt` parameter lets bulk-regen pre-resolve the current
 * prompt once and reuse it across many records (saves N file reads).
 */
export async function generateRecordSummary(
  ctx: RecordContext,
  opts: {
    rid?: string;
    prompt?: SummaryPromptVersion;
    /** ADR-053 — caller-supplied transcript override. When the target
     *  record has no own transcript, the client passes a donor's text
     *  inline (resolved via transcriptProvenance.resolveTranscriptForOperation).
     *  Bypasses the Drive read for the target record entirely. */
    transcriptOverride?: string;
    /** Audit trail — donor record_id when transcriptOverride is set. */
    transcriptSourceRecordId?: string;
    /** ADR-059 — drop transcript lines whose [HH:MM:SS] marker
     *  precedes this offset, so summary generation ignores the
     *  pre-show warm-up window. Same value the publish path uses
     *  for ffmpeg trimming, sourced from ADR-014 processing rules.
     *  0 or undefined ⇒ no slice. */
    trimStartSeconds?: number;
    /** ADR-060 — drop transcript lines whose [HH:MM:SS] marker is at
     *  or after (duration - trimEndSeconds), so the post-show
     *  tear-down doesn't pollute the summary either. Requires
     *  durationSeconds to compute the absolute cutoff. */
    trimEndSeconds?: number;
    durationSeconds?: number;
  } = {},
): Promise<GenerateRecordResult> {
  const rid = opts.rid ?? "n/a";
  const prompt = opts.prompt ?? await getCurrentPrompt();

  let rawTranscript: string;
  if (opts.transcriptOverride && opts.transcriptOverride.length >= 200) {
    rawTranscript = opts.transcriptOverride;
  } else {
    const transcriptArtifact = await getArtifact(ctx.record_id, "transcript");
    if (!transcriptArtifact?.content) {
      throw new GenerateError("No transcript on Drive for this record — cannot summarise", 400, "no_transcript");
    }
    rawTranscript = transcriptArtifact.content;
  }
  // ADR-059 — slice the transcript at trim_start_seconds. Applied
  // BEFORE the size-cap truncation so the trim recovers head-of-
  // transcript budget that was previously lost to pre-show content.
  // ADR-060 — same for the tail (post-show tear-down). Both sides
  // are recorded in the sidecar so any change triggers a regen.
  const trimSecs = Math.max(0, Math.floor(opts.trimStartSeconds ?? 0));
  const trimEndSecs = Math.max(0, Math.floor(opts.trimEndSeconds ?? 0));
  const duration = Math.max(0, Math.floor(opts.durationSeconds ?? 0));
  let trimmedTranscript = trimSecs > 0
    ? sliceTranscriptFromSeconds(rawTranscript, trimSecs)
    : rawTranscript;
  if (trimEndSecs > 0 && duration > trimEndSecs) {
    trimmedTranscript = sliceTranscriptToSeconds(trimmedTranscript, duration - trimEndSecs);
  }
  const transcript = trimmedTranscript.length > MAX_TRANSCRIPT_CHARS
    ? trimmedTranscript.slice(0, MAX_TRANSCRIPT_CHARS) + "\n\n[transcript truncated]"
    : trimmedTranscript;

  const chatArtifact = await getArtifact(ctx.record_id, "chat").catch(() => null);
  const chat = chatArtifact?.content && chatArtifact.content.length > 0
    ? (chatArtifact.content.length > MAX_CHAT_CHARS
        ? chatArtifact.content.slice(0, MAX_CHAT_CHARS) + "\n\n[chat truncated]"
        : chatArtifact.content)
    : null;

  const sharedOR = (await getSharedCredential("openrouter")) ?? {};
  const apiKey = (sharedOR as { apiKey?: string }).apiKey?.trim() || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new GenerateError("OpenRouter API key not configured", 503, "no_api_key");
  }

  const userBlock = chat
    ? `TRANSCRIPT (timestamps in [HH:MM:SS]):\n\n${transcript}\n\n---\n\nEMBEDDED CHAT (lines as "[HH:MM:SS] author: message"):\n\n${chat}`
    : `TRANSCRIPT (timestamps in [HH:MM:SS]):\n\n${transcript}\n\n(No chat captured for this video — omit the Chat-Sparked Discussions section per chapter.)`;

  async function callModel(modelName: string): Promise<Response> {
    return fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/mrjcleaver/video-sync",
        "X-Title": "video-sync ADR-046 summary",
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: "system", content: prompt.text },
          { role: "user", content: userBlock },
        ],
        temperature: 0.2,
      }),
    });
  }

  serverLog("info", "ext:summary-generate", "starting", {
    rid,
    record_id: ctx.record_id,
    prompt_version: prompt.version,
    model: prompt.model,
    transcript_chars: transcript.length,
    chat_chars: chat?.length ?? 0,
  });

  const t0 = Date.now();
  let res: Response;
  let usedModel = prompt.model;
  try {
    res = await callModel(prompt.model);
    if (res.status === 429 && prompt.model !== FALLBACK_MODEL) {
      serverLog("warn", "ext:summary-generate", "rate-limited, retrying with fallback", { rid, model: prompt.model, fallback: FALLBACK_MODEL });
      res = await callModel(FALLBACK_MODEL);
      usedModel = FALLBACK_MODEL;
    }
  } catch (err) {
    serverLog("error", "ext:summary-generate", "fetch threw", { rid, record_id: ctx.record_id, error: String(err) });
    throw new GenerateError(`OpenRouter request failed: ${String(err)}`, 502, "fetch_failed");
  }
  const durationMs = Date.now() - t0;

  if (!res.ok) {
    const text = await res.text();
    serverLog("error", "ext:summary-generate", "openrouter error", { rid, record_id: ctx.record_id, status: res.status, body_preview: text.slice(0, 300) });
    throw new GenerateError(`OpenRouter error (${res.status}): ${text.slice(0, 400)}`, 502, "openrouter_error");
  }

  let data = await res.json() as { choices?: Array<{ message?: { content?: string; finish_reason?: string } }> };
  let markdown = data.choices?.[0]?.message?.content?.trim() ?? "";
  // Empty completions from Gemini 2.5 Pro on huge transcripts are a
  // known failure mode — it accepts the context, spins for minutes, then
  // returns nothing without erroring. Fall back to Haiku once before
  // giving up. Haiku is more tolerant of noisy / long input and rarely
  // returns empty.
  if (!markdown && usedModel !== FALLBACK_MODEL) {
    serverLog("warn", "ext:summary-generate", "empty output, retrying with fallback model", { rid, record_id: ctx.record_id, model: usedModel, fallback: FALLBACK_MODEL });
    try {
      const retryRes = await callModel(FALLBACK_MODEL);
      if (retryRes.ok) {
        data = await retryRes.json() as typeof data;
        markdown = data.choices?.[0]?.message?.content?.trim() ?? "";
        usedModel = FALLBACK_MODEL;
      } else {
        const body = await retryRes.text();
        serverLog("error", "ext:summary-generate", "fallback openrouter error", { rid, status: retryRes.status, body_preview: body.slice(0, 300) });
      }
    } catch (err) {
      serverLog("error", "ext:summary-generate", "fallback fetch threw", { rid, error: String(err) });
    }
  }
  if (!markdown) {
    serverLog("error", "ext:summary-generate", "empty model output (fallback also exhausted)", { rid, record_id: ctx.record_id, model: usedModel });
    throw new GenerateError(`Model returned an empty summary (tried ${usedModel === FALLBACK_MODEL ? FALLBACK_MODEL : `${prompt.model} + ${FALLBACK_MODEL}`}). Transcript may be too noisy — check the description for hints and consider manual editing.`, 502, "empty_output");
  }

  const counts = parseSectionCounts(markdown);
  const generatedAt = new Date().toISOString();
  const bannered = `🤖 Generated by video-sync summary-prompt v${prompt.version} on ${generatedAt}.
Edit freely. Lock the record from the dashboard to preserve this summary from prompt-bump regenerations.

---

${markdown}`;

  const entry = await setSummaryDoc(ctx, bannered, prompt.version, generatedAt);

  serverLog("info", "ext:summary-generate", "done", {
    rid,
    record_id: ctx.record_id,
    prompt_version: prompt.version,
    doc_id: entry.drive_file_id,
    counts,
    duration_ms: durationMs,
    model: usedModel,
  });

  return {
    doc_id: entry.drive_file_id,
    doc_url: entry.drive_web_url,
    prompt_version: prompt.version,
    counts,
    model: usedModel,
    generated_at: generatedAt,
    duration_ms: durationMs,
    trim_start_seconds: trimSecs,
    trim_end_seconds: trimEndSecs,
  };
}

/**
 * ADR-059 helper — return the transcript from the first line whose
 * leading [HH:MM:SS] marker is at or after `startSecs`. If no line
 * matches (or the transcript has no markers), returns the original
 * transcript unchanged so we never over-truncate. Marker forms
 * accepted: [HH:MM:SS], [H:MM:SS], [MM:SS], [M:SS] — matching what
 * Kaltura caption import / Fireflies fetch / Zoom VTT flatten emit.
 */
// Slicer helpers live in ../lib/transcriptSlice (client-safe) so
// client components can import them without pulling in the server-
// side Secret Manager machinery. Re-exported here for existing
// call-sites that reach for summaryGenerate.
export { sliceTranscriptFromSeconds, sliceTranscriptToSeconds } from "./transcriptSlice";
