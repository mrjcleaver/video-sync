/**
 * ADR-046 — single-record summary generation.
 *
 * POST /api/summary/generate
 * Body: { record_id, title, source_platform, source_id, recorded_at }
 *
 * Thin wrapper around lib/summaryGenerate.ts (shared with the bulk-regen
 * SSE endpoint at /api/summary/regen). Returns the GenerateRecordResult
 * as JSON, or an error with the appropriate status code via
 * GenerateError.httpStatus.
 *
 * The caller (client VideoCard) is responsible for calling WASM
 * set_summary_metadata to record the result on the VideoRecord —
 * preserves the WASM-aggregate-source-of-truth pattern.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";
import { getActor } from "../../../../lib/auth";
import { generateRecordSummary, GenerateError } from "../../../../lib/summaryGenerate";
import type { RecordContext } from "../../../../lib/driveArtifactStore";

export const dynamic = "force-dynamic";

interface GenerateBody {
  record_id?: string;
  title?: string;
  source_platform?: string;
  source_id?: string;
  recorded_at?: string;
  /** ADR-053 — client-resolved borrowed transcript (when the target
   *  record has no own transcript, a donor's text is passed inline). */
  transcript_override?: string;
  transcript_source_record_id?: string;
  /** ADR-059 — trim the pre-show off the transcript before
   *  summarising. Value comes from ADR-014 processing rules,
   *  matching what the video upload path uses. */
  trim_start_seconds?: number;
  /** ADR-060 — matching post-show trim (measured from end of recording).
   *  Needed to keep Show Notes anchored to the scheduled programme
   *  window on both sides. duration_seconds pairs with this so the
   *  slicer can compute the absolute end-time in transcript space. */
  trim_end_seconds?: number;
  duration_seconds?: number;
}

async function handler(req: NextRequest) {
  let actor;
  try {
    actor = await getActor(req);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }
  if (actor.role === "Viewer") {
    return NextResponse.json({ error: "Publisher role or higher required to generate summaries" }, { status: 403 });
  }

  let body: GenerateBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { record_id, title, source_platform, source_id, recorded_at, transcript_override, transcript_source_record_id, trim_start_seconds, trim_end_seconds, duration_seconds } = body;
  if (!record_id || !title || !source_platform || !source_id || !recorded_at) {
    return NextResponse.json(
      { error: "record_id, title, source_platform, source_id, recorded_at all required" },
      { status: 400 },
    );
  }

  const rid = req.headers.get("x-request-id") ?? "n/a";
  const ctx: RecordContext = { record_id, title, source_platform, source_id, recorded_at };

  try {
    const result = await generateRecordSummary(ctx, {
      rid,
      transcriptOverride: transcript_override,
      transcriptSourceRecordId: transcript_source_record_id,
      trimStartSeconds: trim_start_seconds,
      trimEndSeconds: trim_end_seconds,
      durationSeconds: duration_seconds,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof GenerateError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

export const POST = withRequestLogging("api:summary/generate", handler);
