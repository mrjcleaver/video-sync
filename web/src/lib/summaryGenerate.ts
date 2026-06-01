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
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    const heading = line.match(/^#{2,3}\s+(.+)$/);
    if (heading) {
      const title = heading[1].toLowerCase();
      if (title.includes("key moment")) current = "m";
      else if (title.includes("key learning")) current = "l";
      else if (title.includes("key takeaway")) current = "t";
      else if (title.includes("chat-sparked") || title.includes("chat sparked")) current = "c";
      else current = null;
      continue;
    }
    if (current && /^\s*-\s+/.test(line)) {
      counts[current]++;
    }
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
  opts: { rid?: string; prompt?: SummaryPromptVersion } = {},
): Promise<GenerateRecordResult> {
  const rid = opts.rid ?? "n/a";
  const prompt = opts.prompt ?? await getCurrentPrompt();

  const transcriptArtifact = await getArtifact(ctx.record_id, "transcript");
  if (!transcriptArtifact?.content) {
    throw new GenerateError("No transcript on Drive for this record — cannot summarise", 400, "no_transcript");
  }
  const transcript = transcriptArtifact.content.length > MAX_TRANSCRIPT_CHARS
    ? transcriptArtifact.content.slice(0, MAX_TRANSCRIPT_CHARS) + "\n\n[transcript truncated]"
    : transcriptArtifact.content;

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

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const markdown = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!markdown) {
    serverLog("error", "ext:summary-generate", "empty model output", { rid, record_id: ctx.record_id });
    throw new GenerateError("Model returned an empty summary", 502, "empty_output");
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
  };
}
