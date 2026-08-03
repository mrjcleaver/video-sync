/**
 * POST /api/description/from-show-notes
 *
 * ADR-064 follow-up (Show Notes → Description prompt). Takes Show Notes
 * markdown, runs the admin-configured `show_notes_prompt` against it
 * via OpenRouter, and returns the resulting plain-text YouTube
 * description. Distinct from /api/process/summarize (which is the
 * transcript-mode summariser and returns JSON `{summary,topics,highlights}`).
 *
 * Client callers: VideoCard's Copy-from-Show-Notes button.
 * Falls back to the deterministic converter (showNotesToDescription)
 * on caller side when this returns non-200.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getSharedCredential } from "../../../../lib/sharedCredentials";
import { readDescriptionConfig } from "../config/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_MODEL = "google/gemini-2.5-flash";
const FALLBACK_MODEL = "anthropic/claude-haiku-4-5";
const MAX_INPUT_CHARS = 200_000;
const MAX_OUTPUT_CHARS = 4800;

async function handler(req: NextRequest) {
  let body: { show_notes?: string; apiKey?: string; model?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const showNotes = (body.show_notes ?? "").trim();
  if (showNotes.length < 100) {
    return NextResponse.json({ error: "show_notes text < 100 chars — nothing useful to render" }, { status: 400 });
  }

  const sharedOR = (await getSharedCredential("openrouter")) ?? {};
  const apiKey = body.apiKey?.trim() || (sharedOR as { apiKey?: string }).apiKey?.trim() || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OpenRouter API key not configured" }, { status: 503 });
  }
  const model = body.model?.trim() || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const cfg = await readDescriptionConfig();
  const systemPrompt = cfg.show_notes_prompt;

  const trimmed = showNotes.length > MAX_INPUT_CHARS
    ? showNotes.slice(0, MAX_INPUT_CHARS) + "\n\n[show notes truncated]"
    : showNotes;

  const rid = req.headers.get("x-request-id") ?? "n/a";

  async function callModel(m: string): Promise<Response> {
    return fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/mrjcleaver/video-sync",
        "X-Title": "video-sync description from show notes",
      },
      body: JSON.stringify({
        model: m,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: trimmed },
        ],
        temperature: 0.4,
        // 5000 chars ≈ 1250 tokens; give the model 2000 to leave headroom
        // for slight over-runs which we'll then hard-cap.
        max_tokens: 2000,
      }),
    });
  }

  const FALLBACK_TRIGGERS = new Set([400, 402, 404, 429]);
  let res: Response;
  let usedModel = model;
  try {
    res = await callModel(model);
    if (FALLBACK_TRIGGERS.has(res.status) && model !== FALLBACK_MODEL) {
      serverLog("warn", "ext:openrouter", "description-from-show-notes retry", { status: res.status, model, fallback: FALLBACK_MODEL, rid });
      res = await callModel(FALLBACK_MODEL);
      usedModel = FALLBACK_MODEL;
    }
  } catch (err) {
    serverLog("error", "ext:openrouter", "fetch threw", { rid, error: String(err) });
    return NextResponse.json({ error: `OpenRouter request failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    serverLog("error", "ext:openrouter", "non-ok response", { rid, status: res.status, body_preview: bodyText.slice(0, 300) });
    return NextResponse.json({ error: `OpenRouter error (${res.status}): ${bodyText.slice(0, 200)}` }, { status: 502 });
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  let text = (data.choices?.[0]?.message?.content ?? "").trim();
  if (!text) {
    // Empty completion — try Haiku fallback once if we haven't already.
    if (usedModel !== FALLBACK_MODEL) {
      const retryRes = await callModel(FALLBACK_MODEL).catch(() => null);
      if (retryRes && retryRes.ok) {
        const retryData = await retryRes.json() as { choices?: Array<{ message?: { content?: string } }> };
        text = (retryData.choices?.[0]?.message?.content ?? "").trim();
        usedModel = FALLBACK_MODEL;
      }
    }
    if (!text) {
      return NextResponse.json({ error: "Model returned an empty description" }, { status: 502 });
    }
  }

  // Belt-and-braces: repair chapter-cue timestamps using the source
  // Show Notes as ground truth. LLMs routinely truncate HH:MM:SS
  // down to HH:MM (dropping actual seconds), or condense to MM:SS.
  // YouTube's chapter picker silently ignores non-HH:MM:SS forms.
  // We extract the ordered list of chapter timestamps from the Show
  // Notes and overwrite each LLM chapter line's timestamp with the
  // corresponding source value.
  text = repairChapterTimestamps(text, trimmed);

  // Cap: if the model overshoots 4800 chars, truncate at the last
  // complete line under the limit and append an ellipsis.
  if (text.length > MAX_OUTPUT_CHARS) {
    const clip = text.slice(0, MAX_OUTPUT_CHARS - 20);
    const lastNewline = clip.lastIndexOf("\n");
    text = (lastNewline > 0 ? clip.slice(0, lastNewline) : clip) + "\n…";
  }

  serverLog("info", "api:description/from-show-notes", "ok", { rid, model: usedModel, in_chars: trimmed.length, out_chars: text.length });
  return NextResponse.json({ text, model: usedModel });
}

export const POST = withRequestLogging("api:description/from-show-notes", handler);

/**
 * Extract chapter start-timestamps from the source Show Notes in
 * document order. The prompt asks the model to keep chapter order, so
 * positional matching against the LLM output is the safest repair
 * we can do without embeddings / fuzzy title matching.
 *
 * Recognises the common Show Notes chapter-heading forms:
 *   `## N. Title [HH:MM:SS-HH:MM:SS]`
 *   `Chapter Title {HH:MM:SS-HH:MM:SS}`
 *   `[HH:MM:SS]` bullets when they're the FIRST bullet under a
 *      chapter heading (fallback if the heading itself uses HH:MM).
 * Prefers 3-component HH:MM:SS; padds 2-component `HH:MM` as
 * `HH:MM:00`.
 */
function extractSourceChapterTimestamps(showNotes: string): string[] {
  const out: string[] = [];
  const HEADING_TS = /(?:[\[{])\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*[-–—]\s*(?:\d{1,2}):(?:\d{2})(?::\d{2})?\s*(?:[\]}])/;
  const pad = (n: string) => n.padStart(2, "0");
  for (const rawLine of showNotes.split("\n")) {
    const line = rawLine.trim();
    // Only take timestamps that appear inside a chapter HEADING line
    // — level-1 or level-2 markdown headings, or a line that looks
    // like `Chapter Title {HH:MM-HH:MM}`. Bullets inside sections
    // (Key Moments etc.) are per-moment, not per-chapter.
    const isHeading = /^#{1,3}\s/.test(line) || /^\s*(?:\d+\.\s*)?[A-Z][^{[\r\n]{0,120}[{[]/.test(line);
    if (!isHeading) continue;
    const m = line.match(HEADING_TS);
    if (!m) continue;
    const [, h, min, s] = m;
    out.push(`${pad(h)}:${pad(min)}:${pad(s ?? "00")}`);
  }
  return out;
}

/**
 * Overwrite each chapter-cue line in the LLM output with the
 * corresponding source-of-truth timestamp (positional). If the
 * source produced fewer timestamps than the LLM emitted (e.g. the
 * model added a synthetic `00:00:00 Opening` line the source didn't
 * have), we insert `00:00:00` for that leading extra and shift the
 * rest.
 *
 * A chapter-cue line is: first token is a timestamp (2- or 3-component),
 * followed by a title (alphabetic first char of the remainder).
 */
function repairChapterTimestamps(llmOutput: string, showNotes: string): string {
  const sourceTs = extractSourceChapterTimestamps(showNotes);
  if (sourceTs.length === 0) {
    // Nothing to repair from — fall back to conservative padding.
    return padChapterTimestamps(llmOutput);
  }
  const CUE_RE = /^(\s*)(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(\s+[A-Za-z].*)$/;
  const lines = llmOutput.split("\n");
  let idx = 0;
  let leadingSyntheticZero = false;
  const out = lines.map(line => {
    const m = line.match(CUE_RE);
    if (!m) return line;
    const rest = m[5];
    // The model often prepends a synthetic `00:00:00 Opening` when
    // the first source chapter doesn't start at 0. If so, keep that
    // synthetic zero and pull source timestamps starting at idx 0
    // for the rest.
    if (idx === 0 && sourceTs[0] !== "00:00:00" && /^(0{1,2}:)?0?0:0?0(?::0?0)?$/.test(`${m[2]}:${m[3]}${m[4] !== undefined ? `:${m[4]}` : ""}`)) {
      leadingSyntheticZero = true;
      return `${m[1]}00:00:00${rest}`;
    }
    const ts = sourceTs[leadingSyntheticZero ? idx : idx];
    idx++;
    if (!ts) {
      // Ran out of source timestamps — pad whatever the model wrote.
      return padOne(m);
    }
    return `${m[1]}${ts}${rest}`;
  });
  return out.join("\n");
}

/** Conservative padding when we have no source-of-truth. Pads
 *  2-component as `HH:MM:00` (assuming missing SS), which is the
 *  least-damaging interpretation when the model dropped seconds. */
function padChapterTimestamps(text: string): string {
  const CUE_RE = /^(\s*)(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(\s+[A-Za-z].*)$/;
  return text.split("\n").map(line => {
    const m = line.match(CUE_RE);
    if (!m) return line;
    return padOne(m);
  }).join("\n");
}

function padOne(m: RegExpMatchArray): string {
  const [, indent, a, b, c, rest] = m;
  const pad = (n: string) => n.padStart(2, "0");
  if (c !== undefined) {
    return `${indent}${pad(a)}:${pad(b)}:${pad(c)}${rest}`;
  }
  // Two-component with no source-of-truth: assume HH:MM (model
  // dropped seconds). Emit HH:MM:00 — worst-case a viewer clicking
  // the chapter jumps a few seconds earlier than the actual moment,
  // which is FAR less bad than YouTube ignoring the chapter list.
  return `${indent}${pad(a)}:${pad(b)}:00${rest}`;
}
