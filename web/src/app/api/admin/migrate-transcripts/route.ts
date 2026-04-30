/**
 * One-shot migration: copy transcripts from `data/transcripts.json` (ADR-035 L2)
 * into Drive (ADR-039) as `transcript.md` per meeting.
 *
 * Idempotent — re-runs are safe; setArtifact upserts by filename within the
 * meeting folder. The Drive folder structure is created on demand.
 *
 * Auth: Admin role only (IAP-mediated). Returns a summary report.
 *
 * Usage (after deploy with DRIVE_* env vars set):
 *   curl -X POST -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
 *     https://video-sync.agentics.org/api/admin/migrate-transcripts
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { setArtifact } from "../../../../lib/driveArtifactStore";
import { getActor } from "../../../../lib/auth";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";

interface VideoRecordLike {
  id?: string;
  title?: string;
  source_platform?: string;
  source_id?: string;
  recorded_at?: string;
  indexed_at?: string;
}

async function postHandler(req: NextRequest) {
  const actor = await getActor(req);
  if (actor.role !== "Admin") {
    return NextResponse.json({ error: "Admin role required" }, { status: 403 });
  }

  const dataDir = join(process.cwd(), "data");
  const catalogPath = join(dataDir, "catalog.json");
  const transcriptsPath = join(dataDir, "transcripts.json");

  let catalog: { records?: Record<string, string> } = {};
  let transcripts: Record<string, string> = {};
  try {
    catalog = JSON.parse(await fs.readFile(catalogPath, "utf-8"));
  } catch {
    return NextResponse.json({ error: "catalog.json not readable" }, { status: 500 });
  }
  try {
    transcripts = JSON.parse(await fs.readFile(transcriptsPath, "utf-8"));
  } catch {
    return NextResponse.json({ error: "transcripts.json not readable", note: "may already be migrated and removed" }, { status: 200 });
  }

  const total = Object.keys(transcripts).length;
  const results = {
    total,
    migrated: 0,
    no_record: 0,
    failed: [] as Array<{ id: string; error: string }>,
  };

  for (const [id, text] of Object.entries(transcripts)) {
    const recJson = catalog.records?.[id];
    if (!recJson) {
      results.no_record++;
      continue;
    }
    let rec: VideoRecordLike;
    try {
      rec = JSON.parse(recJson);
    } catch {
      results.failed.push({ id, error: "record JSON parse" });
      continue;
    }

    const ctx = {
      record_id: id,
      title: rec.title ?? "Untitled",
      source_platform: rec.source_platform ?? "Unknown",
      source_id: rec.source_id ?? id,
      recorded_at: rec.recorded_at ?? rec.indexed_at ?? new Date().toISOString(),
    };

    const frontmatter = [
      "---",
      `record_id: ${id}`,
      `source_platform: ${ctx.source_platform}`,
      `source_id: ${ctx.source_id}`,
      `recorded_at: ${ctx.recorded_at}`,
      "generated_by: migration",
      `generated_at: ${new Date().toISOString()}`,
      "---",
      "",
      "",
    ].join("\n");
    const body = frontmatter + text;

    try {
      await setArtifact(ctx, "transcript", body);
      results.migrated++;
      serverLog("info", "migrate-transcripts", "ok", { video_id: id });
    } catch (err) {
      results.failed.push({ id, error: String(err) });
      serverLog("error", "migrate-transcripts", "failed", { video_id: id, error: String(err) });
    }
  }

  return NextResponse.json(results);
}

export const POST = withRequestLogging("api:admin/migrate-transcripts", postHandler);
