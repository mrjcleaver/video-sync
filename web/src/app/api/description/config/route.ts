/**
 * GET  /api/description/config — public. Returns the current config.
 * PUT  /api/description/config — Admin only. Persists a new config.
 *
 * Pattern matches /api/summary/prompt (ADR-046). Storage:
 * data/description-config.json on the FUSE-mounted bucket.
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getActor } from "../../../../lib/auth";

export const dynamic = "force-dynamic";

const CONFIG_FILE = join(process.cwd(), "data", "description-config.json");

const DEFAULT_PROMPT = `You are a video session summariser. Given a meeting or coding session transcript, return a JSON object with exactly these fields:
- summary: string — 2-4 sentences describing what the session covered
- topics: string[] — 3-7 key topics discussed (short phrases)
- highlights: string[] — 2-5 notable moments, decisions, or insights

Return only valid JSON. No markdown, no explanation.`;

// Kept in server-side sync with lib/descriptionConfig.ts's DEFAULT_SHOW_NOTES_PROMPT.
const DEFAULT_SHOW_NOTES_PROMPT = `You are turning a chapter-by-chapter Show Notes markdown document into a YouTube video description that both preserves chapter cues (HH:MM:SS lines) AND sells the video to a first-time viewer. Total ≤ 4800 chars. See the client default for the full rubric — this server-side stub only fires when the config file is missing.`;

interface DescriptionConfig {
  mode: "copy_show_notes" | "generate";
  prompt_text: string;
  show_notes_prompt: string;
  updated_at?: string;
  updated_by?: string;
}

const DEFAULT_CONFIG: DescriptionConfig = {
  mode: "copy_show_notes",
  prompt_text: DEFAULT_PROMPT,
  show_notes_prompt: DEFAULT_SHOW_NOTES_PROMPT,
};

async function readDescriptionConfig(): Promise<DescriptionConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DescriptionConfig>;
    return {
      mode: parsed.mode === "generate" ? "generate" : "copy_show_notes",
      prompt_text: typeof parsed.prompt_text === "string" && parsed.prompt_text.length > 0
        ? parsed.prompt_text
        : DEFAULT_PROMPT,
      show_notes_prompt: typeof parsed.show_notes_prompt === "string" && parsed.show_notes_prompt.length > 0
        ? parsed.show_notes_prompt
        : DEFAULT_SHOW_NOTES_PROMPT,
      updated_at: parsed.updated_at,
      updated_by: parsed.updated_by,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function getHandler() {
  return NextResponse.json(await readDescriptionConfig());
}

async function putHandler(req: NextRequest) {
  let actor;
  try { actor = await getActor(req); }
  catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }
  if (actor.role !== "Admin") {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }
  let body: Partial<DescriptionConfig>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const mode = body.mode === "generate" ? "generate" : "copy_show_notes";
  const prompt_text = typeof body.prompt_text === "string" && body.prompt_text.trim().length > 20
    ? body.prompt_text
    : DEFAULT_PROMPT;
  const show_notes_prompt = typeof body.show_notes_prompt === "string" && body.show_notes_prompt.trim().length > 20
    ? body.show_notes_prompt
    : DEFAULT_SHOW_NOTES_PROMPT;
  const next: DescriptionConfig = {
    mode,
    prompt_text,
    show_notes_prompt,
    updated_at: new Date().toISOString(),
    updated_by: actor.user_id,
  };
  try {
    await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
  } catch (err) {
    serverLog("error", "api:description/config", "write-failed", { error: String(err) });
    return NextResponse.json({ error: `Write failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
  serverLog("info", "api:description/config", "updated", { mode, prompt_len: prompt_text.length, updated_by: actor.user_id });
  return NextResponse.json({ ok: true, config: next });
}

export const GET = withRequestLogging("api:description/config", getHandler);
export const PUT = withRequestLogging("api:description/config", putHandler as never);
