/**
 * POST /api/description/backups/[id]/restore
 *
 * Restore a captured backup by PUTting the prior title + description
 * back to YouTube via videos.update. Also captures a NEW backup of
 * the current YouTube state so a restore is itself undoable.
 *
 * Body:
 *   { refreshToken, clientId, clientSecret }   — same OAuth args as update-title.
 *   Optionally `dry_run: true` to just report what would be restored.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../../../lib/serverLogger";
import { getActor } from "../../../../../../lib/auth";
import { getBackup } from "../../../../../../lib/descriptionBackups";

export const dynamic = "force-dynamic";

async function postHandler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let actor;
  try { actor = await getActor(req); }
  catch (err) { return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 }); }
  if (actor.role !== "Admin" && actor.role !== "Publisher") {
    return NextResponse.json({ error: "Publisher+ required" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const backup = await getBackup(id);
  if (!backup) return NextResponse.json({ error: "backup not found" }, { status: 404 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const dryRun = body.dry_run === true;
  if (dryRun) {
    return NextResponse.json({
      dry_run: true,
      would_restore: {
        yt_video_id: backup.yt_video_id,
        title: backup.prior_title,
        description_length: backup.prior_description.length,
        taken_at: backup.taken_at,
      },
    });
  }

  const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken : "";
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret : "";
  if (!refreshToken || !clientId || !clientSecret) {
    return NextResponse.json({ error: "refreshToken, clientId, clientSecret required" }, { status: 400 });
  }

  // Reuse the update-title endpoint — this way the "current before
  // restore" also gets captured as a new backup, and idempotence /
  // scope checks stay in one place.
  const origin = new URL(req.url).origin;
  const putRes = await fetch(`${origin}/api/youtube/update-title`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Pass through IAP cookie / Bearer so getActor on the child call
      // still identifies the operator for the backup provenance.
      "Authorization": req.headers.get("authorization") ?? "",
      "Cookie": req.headers.get("cookie") ?? "",
    },
    body: JSON.stringify({
      videoId: backup.yt_video_id,
      title: backup.prior_title,
      description: backup.prior_description,
      refreshToken, clientId, clientSecret,
      record_id: backup.record_id || undefined,
    }),
  });
  const putData = await putRes.json().catch(() => ({}));
  if (!putRes.ok) {
    serverLog("error", "api:description/backups/restore", "update-title failed", { id, status: putRes.status });
    return NextResponse.json({ error: (putData as { error?: string }).error ?? `videos.update failed (${putRes.status})` }, { status: 502 });
  }
  serverLog("info", "api:description/backups/restore", "restored", { id, yt_video_id: backup.yt_video_id, actor: actor.email });
  return NextResponse.json({ ok: true, restored_to: putData, backup_taken_at: backup.taken_at });
}

export const POST = withRequestLogging("api:description/backups/restore", postHandler as never);
