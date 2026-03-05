/**
 * POST /api/process/summarize
 * Sends a transcript to OpenRouter and returns a structured summary.
 * ADR-014 — transcript_llm mode.
 *
 * Requires env:
 *   OPENROUTER_API_KEY   — your OpenRouter API key
 *   OPENROUTER_MODEL     — optional, defaults to google/gemini-2.0-flash-001
 */

import { NextRequest, NextResponse } from "next/server";

const DEFAULT_MODEL = "google/gemini-2.0-flash-001";

const SYSTEM_PROMPT = `You are a video session summariser. Given a meeting or coding session transcript, return a JSON object with exactly these fields:
- summary: string — 2-4 sentences describing what the session covered
- topics: string[] — 3-7 key topics discussed (short phrases)
- highlights: string[] — 2-5 notable moments, decisions, or insights

Return only valid JSON. No markdown, no explanation.`;

export async function POST(req: NextRequest) {
  let body: { transcript?: string; apiKey?: string; model?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Key priority: request body (from Connections panel) > env var fallback
  const apiKey = body.apiKey?.trim() || process.env.OPENROUTER_API_KEY;
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

  const model = body.model?.trim() || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;

  // Trim very long transcripts to stay within context limits (~12k chars ≈ ~3k tokens)
  const trimmed = transcript.length > 12000
    ? transcript.slice(0, 12000) + "\n\n[transcript truncated]"
    : transcript;

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/mrjcleaver/video-sync",
        "X-Title": "video-sync summariser",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: trimmed },
        ],
        temperature: 0.3,
        max_tokens: 512,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
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
      model,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Summarize request failed: ${String(err)}` },
      { status: 502 },
    );
  }
}
