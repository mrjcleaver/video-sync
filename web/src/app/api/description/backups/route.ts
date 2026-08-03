/**
 * GET /api/description/backups[?record_id=<id>]
 * Publisher+ can read backups. Admin sees all; Publisher sees all in
 * their org (we don't scope by actor since backups are org-level).
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";
import { getActor } from "../../../../lib/auth";
import { listBackups } from "../../../../lib/descriptionBackups";

export const dynamic = "force-dynamic";

async function getHandler(req: NextRequest) {
  let actor;
  try { actor = await getActor(req); }
  catch (err) { return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 }); }
  if (actor.role !== "Admin" && actor.role !== "Publisher") {
    return NextResponse.json({ error: "Publisher+ required" }, { status: 403 });
  }
  const record_id = req.nextUrl.searchParams.get("record_id");
  const backups = await listBackups(record_id);
  return NextResponse.json({ backups });
}

export const GET = withRequestLogging("api:description/backups", getHandler as never);
