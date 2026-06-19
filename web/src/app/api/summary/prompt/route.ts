/**
 * ADR-046 — summary prompt CRUD.
 *
 * GET  /api/summary/prompt — return the current prompt (any role).
 *                            Used by the admin panel UI and by the
 *                            generate route to fetch the prompt body.
 * PUT  /api/summary/prompt — bump the prompt version (Admin only).
 *
 * The history of previous versions is retained server-side; this route
 * returns only `current` so the response stays small. A future "prompt
 * history" view can add `?include=history`.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";
import { getActor } from "../../../../lib/auth";
import { getCurrentPrompt, setCurrentPrompt } from "../../../../lib/summaryPrompt";

export const dynamic = "force-dynamic";

async function getHandler() {
  const current = await getCurrentPrompt();
  return NextResponse.json(current);
}

async function putHandler(req: NextRequest) {
  let actor;
  try {
    actor = await getActor(req);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 401 },
    );
  }
  if (actor.role !== "Admin") {
    return NextResponse.json(
      { error: "Admin role required to edit the summary prompt" },
      { status: 403 },
    );
  }

  let body: { text?: string; model?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const text = body.text?.trim();
  const model = body.model?.trim();
  if (!text || text.length < 50) {
    return NextResponse.json(
      { error: "Prompt text must be at least 50 characters" },
      { status: 400 },
    );
  }
  if (!model) {
    return NextResponse.json(
      { error: "Model is required (e.g. google/gemini-2.5-pro)" },
      { status: 400 },
    );
  }

  const updated = await setCurrentPrompt(text, model, actor.email);
  return NextResponse.json(updated.current);
}

export const GET = withRequestLogging("api:summary/prompt", getHandler);
export const PUT = withRequestLogging("api:summary/prompt", putHandler);
