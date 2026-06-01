/**
 * ADR-046 — single-record summary generation.
 *
 * POST /api/summary/generate
 * Body: {
 *   record_id, title, source_platform, source_id, recorded_at  // RecordContext
 * }
 *
 * Flow:
 *   1. Read current prompt + model (data/summary-prompt.json).
 *   2. Read transcript + chat artifacts from Drive.
 *   3. Call OpenRouter with the prompt body + transcript + chat.
 *   4. Parse markdown output — count bullets under the four headings.
 *   5. Write the result as a native Google Doc via setSummaryDoc.
 *   6. Return { doc_id, doc_url, prompt_version, counts }.
 *
 * The caller (client VideoCard) then calls WASM set_summary_metadata
 * to record the result on the VideoRecord; this route does NOT mutate
 * the catalog directly (preserves the WASM-aggregate-source-of-truth
 * pattern used everywhere else).
 *
 * No catalog read — context comes from the body so this route works
 * without a server-side catalog dependency. The client already has
 * the record loaded; we just need title/source/recorded_at for the
 * Drive folder layout (ADR-039).
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getActor } from "../../../../lib/auth";
import { getSharedCredential } from "../../../../lib/sharedCredentials";
import { getCurrentPrompt } from "../../../../lib/summaryPrompt";
import { getArtifact, setSummaryDoc, type RecordContext } from "../../../../lib/driveArtifactStore";
import type { SummaryCountsJSON } from "../../../../lib/wasm";

export const dynamic = "force-dynamic";

// Cap transcript size to keep one-shot generation tractable. Slice 2 is
// single-pass; two-pass for very long transcripts is deferred to a
// later slice per the ADR's "single-record generate" scope.
const MAX_TRANSCRIPT_CHARS = 400_000;  // ~100K tokens
const MAX_CHAT_CHARS = 100_000;

const FALLBACK_MODEL = "anthropic/claude-haiku-4-5";

interface GenerateBody {
  record_id?: string;
  title?: string;
  source_platform?: string;
  source_id?: string;
  recorded_at?: string;
}

interface GenerateResponse {
  doc_id: string;
  doc_url?: string;
  prompt_version: number;
  counts: SummaryCountsJSON;
  model: string;
  generated_at: string;
}

/**
 * Count bullets under each of the four section headings, regardless of
 * how the model nested them inside chapter wrappers.
 *
 * The parser walks line-by-line:
 *   - When it sees `### Key Moments` (or one of the other three), it
 *     enters that section.
 *   - When it sees any other `## ` or `### ` heading, it leaves the
 *     current section.
 *   - While in a section, each line starting with `- ` (after optional
 *     whitespace) increments the count.
 */
function parseSectionCounts(markdown: string): SummaryCountsJSON {
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

async function handler(req: NextRequest) {
  let actor;
  try {
    actor = await getActor(req);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 401 },
    );
  }
  if (actor.role === "Viewer") {
    return NextResponse.json(
      { error: "Publisher role or higher required to generate summaries" },
      { status: 403 },
    );
  }

  let body: GenerateBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { record_id, title, source_platform, source_id, recorded_at } = body;
  if (!record_id || !title || !source_platform || !source_id || !recorded_at) {
    return NextResponse.json(
      { error: "record_id, title, source_platform, source_id, recorded_at all required" },
      { status: 400 },
    );
  }

  const rid = req.headers.get("x-request-id") ?? "n/a";
  const ctx: RecordContext = { record_id, title, source_platform, source_id, recorded_at };

  // 1. Resolve current prompt.
  const prompt = await getCurrentPrompt();

  // 2. Read transcript + chat from Drive. Transcript is required;
  //    chat is optional (Zoom CHAT may not have been captured).
  const transcriptArtifact = await getArtifact(record_id, "transcript");
  if (!transcriptArtifact?.content) {
    return NextResponse.json(
      { error: "No transcript on Drive for this record — cannot summarise" },
      { status: 400 },
    );
  }
  const transcript = transcriptArtifact.content.length > MAX_TRANSCRIPT_CHARS
    ? transcriptArtifact.content.slice(0, MAX_TRANSCRIPT_CHARS) + "\n\n[transcript truncated]"
    : transcriptArtifact.content;

  const chatArtifact = await getArtifact(record_id, "chat").catch(() => null);
  const chat = chatArtifact?.content && chatArtifact.content.length > 0
    ? (chatArtifact.content.length > MAX_CHAT_CHARS
        ? chatArtifact.content.slice(0, MAX_CHAT_CHARS) + "\n\n[chat truncated]"
        : chatArtifact.content)
    : null;

  // 3. Resolve OpenRouter key (ADR-042: shared secret with operator override).
  const sharedOR = (await getSharedCredential("openrouter")) ?? {};
  const apiKey = (sharedOR as { apiKey?: string }).apiKey?.trim() || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OpenRouter API key not configured. Set the shared OpenRouter credential." },
      { status: 503 },
    );
  }

  // 4. Build the LLM payload.
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
    record_id,
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
    serverLog("error", "ext:summary-generate", "fetch threw", { rid, record_id, error: String(err) });
    return NextResponse.json({ error: `OpenRouter request failed: ${String(err)}` }, { status: 502 });
  }
  const durationMs = Date.now() - t0;

  if (!res.ok) {
    const text = await res.text();
    serverLog("error", "ext:summary-generate", "openrouter error", { rid, record_id, status: res.status, body_preview: text.slice(0, 300) });
    return NextResponse.json(
      { error: `OpenRouter error (${res.status}): ${text.slice(0, 400)}` },
      { status: 502 },
    );
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const markdown = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!markdown) {
    serverLog("error", "ext:summary-generate", "empty model output", { rid, record_id });
    return NextResponse.json({ error: "Model returned an empty summary" }, { status: 502 });
  }

  // 5. Count + write.
  const counts = parseSectionCounts(markdown);

  // Prepend the ADR-046 banner so a Doc reader sees provenance even
  // without inspecting appProperties.
  const generatedAt = new Date().toISOString();
  const bannered = `🤖 Generated by video-sync summary-prompt v${prompt.version} on ${generatedAt}.
Edit freely. Lock the record from the dashboard to preserve this summary from prompt-bump regenerations.

---

${markdown}`;

  try {
    const entry = await setSummaryDoc(ctx, bannered, prompt.version, generatedAt);
    const result: GenerateResponse = {
      doc_id: entry.drive_file_id,
      doc_url: entry.drive_web_url,
      prompt_version: prompt.version,
      counts,
      model: usedModel,
      generated_at: generatedAt,
    };
    serverLog("info", "ext:summary-generate", "done", {
      rid,
      record_id,
      prompt_version: prompt.version,
      doc_id: entry.drive_file_id,
      counts,
      duration_ms: durationMs,
      model: usedModel,
    });
    return NextResponse.json(result);
  } catch (err) {
    serverLog("error", "ext:summary-generate", "drive write failed", { rid, record_id, error: String(err) });
    return NextResponse.json({ error: `Drive write failed: ${String(err)}` }, { status: 502 });
  }
}

export const POST = withRequestLogging("api:summary/generate", handler);
