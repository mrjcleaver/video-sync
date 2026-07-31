/**
 * ADR-062 — preview endpoint for summary-guided clip source regions.
 *
 * Given a record's summary_doc_id + main-show window + registry
 * settings, returns the merged/sorted region set that the (future)
 * stitcher will feed to Opus. Ships ahead of the actual ffmpeg
 * stitch pipeline so the Shorts modal can show the operator
 * exactly how many regions + how many minutes of stitched
 * duration they'd pay Opus credits for, before anything ships to
 * Opus. The heavy pipeline (download + extract + concat + Drive
 * upload) lands as a follow-up per ADR-062.
 *
 * POST body:
 *   { record_id, summary_doc_id, source_duration_sec,
 *     main_show_start_sec?, main_show_end_sec?,
 *     sections?, radius_before_sec?, radius_after_sec?,
 *     include_main_show?, merge_gap_sec? }
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";
import { getActor } from "../../../../lib/auth";
import { buildRegions } from "../../../../lib/clipSourceRegions";
import { getDrive } from "../../../../lib/drive";

interface PreviewBody {
  record_id?: string;
  summary_doc_id?: string;
  source_duration_sec?: number;
  main_show_start_sec?: number;
  main_show_end_sec?: number;
  sections?: Array<"M" | "L" | "T" | "C">;
  radius_before_sec?: number;
  radius_after_sec?: number;
  include_main_show?: boolean;
  merge_gap_sec?: number;
}

async function fetchSummaryMarkdown(docId: string): Promise<string> {
  // Google Docs exposes markdown export via files.export with the
  // "text/markdown" mimeType (recent Drive API addition). If that's
  // unavailable in this deployment's Drive API surface, fall back
  // to text/plain which still gives us the [HH:MM:SS] markers we
  // need for extraction (formatting loss doesn't matter).
  const drive = getDrive();
  try {
    const md = await drive.files.export({ fileId: docId, mimeType: "text/markdown" });
    if (typeof md.data === "string") return md.data;
  } catch { /* fall through to text/plain */ }
  const txt = await drive.files.export({ fileId: docId, mimeType: "text/plain" });
  return typeof txt.data === "string" ? txt.data : "";
}

async function handler(req: NextRequest) {
  try { await getActor(req); }
  catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }

  const body: PreviewBody = await req.json().catch(() => ({}));
  const { record_id, summary_doc_id, source_duration_sec } = body;

  if (!record_id) return NextResponse.json({ error: "record_id required" }, { status: 400 });
  if (typeof source_duration_sec !== "number" || source_duration_sec <= 0) {
    return NextResponse.json({ error: "source_duration_sec must be a positive number" }, { status: 400 });
  }

  let markdown = "";
  if (summary_doc_id) {
    try {
      markdown = await fetchSummaryMarkdown(summary_doc_id);
    } catch (err) {
      // Not fatal — the operator can still preview a main-show-only
      // build. Report why the highlights are empty.
      return NextResponse.json({
        error: `Couldn't fetch summary Doc ${summary_doc_id} (${err instanceof Error ? err.message : String(err)}). Preview main-show-only by setting include_main_show=true and omitting summary_doc_id, or generate a summary first.`,
      }, { status: 424 });
    }
  }

  const rs = buildRegions(markdown, {
    sections: body.sections,
    radius_before_sec: body.radius_before_sec,
    radius_after_sec: body.radius_after_sec,
    include_main_show: body.include_main_show,
    main_show_start_sec: body.main_show_start_sec,
    main_show_end_sec: body.main_show_end_sec,
    merge_gap_sec: body.merge_gap_sec,
    source_duration_sec,
  });

  return NextResponse.json({
    record_id,
    ...rs,
  });
}

export const POST = withRequestLogging("api:shorts/preview-regions", handler);
