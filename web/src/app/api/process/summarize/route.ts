/**
 * POST /api/process/summarize
 * Sends a transcript to OpenRouter and returns a structured summary.
 * ADR-014 — transcript_llm mode.
 *
 * Requires env:
 *   OPENROUTER_API_KEY   — your OpenRouter API key
 *   OPENROUTER_MODEL     — optional, defaults to google/gemini-2.5-flash
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getSharedCredential } from "../../../../lib/sharedCredentials";

// google/gemini-2.0-flash-001 was retired upstream — OpenRouter returns
// 404 "No endpoints found" for it. Default to the current Flash tier;
// the fallback handler below also triggers on 404 so a future
// retirement doesn't take this route down again.
const DEFAULT_MODEL = "google/gemini-2.5-flash";
const FALLBACK_MODEL = "anthropic/claude-haiku-4-5";

const SYSTEM_PROMPT = `You are a video session summariser. Given a meeting or coding session transcript, return a JSON object with exactly these fields:
- summary: string — 2-4 sentences describing what the session covered
- topics: string[] — 3-7 key topics discussed (short phrases)
- highlights: string[] — 2-5 notable moments, decisions, or insights

Return only valid JSON. No markdown, no explanation.`;

async function handler(req: NextRequest) {
  let body: { transcript?: string; apiKey?: string; model?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ADR-042 resolution: operator override (body) → shared secret → env legacy.
  const sharedOR = (await getSharedCredential("openrouter")) ?? {};
  const apiKey = body.apiKey?.trim() || (sharedOR as { apiKey?: string }).apiKey?.trim() || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OpenRouter API key not configured. Add it in the Connections panel." },
      { status: 503 },
    );
  }

  const { transcript } = body;
  if (!transcript || transcript.trim().length < 50) {
    return NextResponse.json(
      { error: "transcript must be at least 50 characters" },
      { status: 400 },
    );
  }

  const rid = req.headers.get("x-request-id") ?? "n/a";
  const model = body.model?.trim() || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;

  // Trim very long transcripts to stay within context limits (~12k chars ≈ ~3k tokens)
  const trimmed = transcript.length > 12000
    ? transcript.slice(0, 12000) + "\n\n[transcript truncated]"
    : transcript;

  async function callOpenRouter(m: string): Promise<Response> {
    return fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/mrjcleaver/video-sync",
        "X-Title": "video-sync summariser",
      },
      body: JSON.stringify({
        model: m,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: trimmed },
        ],
        temperature: 0.3,
        max_tokens: 512,
        response_format: { type: "json_object" },
      }),
    });
  }

  try {
    const t0 = Date.now();
    let res = await callOpenRouter(model);
    let usedModel = model;

    // Trigger the fallback for rate-limit (429), model-retired (404
    // "No endpoints found"), and model-not-available-on-this-key
    // (400/402). Catches the common reasons a configured model
    // disappears without taking the route down.
    const FALLBACK_TRIGGERS = new Set([400, 402, 404, 429]);
    if (FALLBACK_TRIGGERS.has(res.status) && model !== FALLBACK_MODEL) {
      serverLog("warn", "ext:openrouter", "retrying with fallback", { status: res.status, model, fallback: FALLBACK_MODEL, rid });
      res = await callOpenRouter(FALLBACK_MODEL);
      usedModel = FALLBACK_MODEL;
    }

    serverLog("info", "ext:openrouter", "response", { status: res.status, model: usedModel, duration_ms: Date.now() - t0, rid });
    if (!res.ok) {
      const text = await res.text();
      serverLog("error", "ext:openrouter", "failed", { status: res.status, model: usedModel, rid });
      return NextResponse.json(
        { error: `OpenRouter error (${res.status}): ${text.slice(0, 300)}` },
        { status: 502 },
      );
    }

    const data = await res.json();
    const content: string = data.choices?.[0]?.message?.content ?? "{}";

    let parsed: { summary?: string; topics?: string[]; highlights?: string[] };
    try {
      parsed = JSON.parse(content);
    } catch {
      return NextResponse.json(
        { error: `Model returned non-JSON: ${content.slice(0, 200)}` },
        { status: 502 },
      );
    }

    return NextResponse.json({
      summary: parsed.summary ?? "",
      topics: parsed.topics ?? [],
      highlights: parsed.highlights ?? [],
      model: usedModel,
    });
  } catch (err) {
    serverLog("error", "ext:openrouter", "exception", { error: String(err), rid });
    return NextResponse.json(
      { error: `Summarize request failed: ${String(err)}` },
      { status: 502 },
    );
  }
}

export const POST = withRequestLogging("api:process/summarize", handler);
