/**
 * GET /api/drive/status?record_id=<id>
 *
 * ADR-071 §3 — poll the in-memory ingest job registry for progress.
 * Returns { not_found: true } if no job has been created for this
 * record (either it never was, or the process cold-restarted since).
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";
import { getJob } from "../../../../lib/driveIngestJobs";

async function handler(req: NextRequest) {
  const recordId = req.nextUrl.searchParams.get("record_id");
  if (!recordId) {
    return NextResponse.json({ error: "record_id query param required" }, { status: 400 });
  }
  const job = getJob(recordId);
  if (!job) {
    return NextResponse.json({ not_found: true });
  }
  return NextResponse.json({
    record_id: job.record_id,
    file_id: job.file_id,
    state: job.state,
    bytes_copied: job.bytes_copied,
    bytes_total: job.bytes_total,
    ext: job.ext,
    mime_type: job.mime_type,
    started_at: job.started_at,
    updated_at: job.updated_at,
    finished_at: job.finished_at,
    error: job.error,
  });
}

export const GET = withRequestLogging("api:drive/status", handler);
