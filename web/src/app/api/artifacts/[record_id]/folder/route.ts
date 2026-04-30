import { NextRequest, NextResponse } from "next/server";
import { getMeta } from "../../../../../lib/driveArtifactStore";
import { withRequestLogging } from "../../../../../lib/serverLogger";

// Dynamic — performs Drive I/O.
export const dynamic = "force-dynamic";

// GET /api/artifacts/:record_id/folder
//   302 → Drive folder web URL for this record's meeting folder.
//   404 → no Drive folder exists yet (no artifacts written for this record).
//
// Used by the Overview "Drive" lozenge so a single click opens the folder
// in Drive without the client needing to fetch and parse .meta.json itself.
async function getHandler(_req: NextRequest, ctx: { params: Promise<{ record_id: string }> }) {
  const { record_id } = await ctx.params;
  if (!record_id) return NextResponse.json({ error: "record_id required" }, { status: 400 });
  try {
    const meta = await getMeta(record_id);
    if (!meta?.folder_drive_web_url) {
      return NextResponse.json({ error: "no Drive folder for this record" }, { status: 404 });
    }
    return NextResponse.redirect(meta.folder_drive_web_url, 302);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export const GET = withRequestLogging("api:artifacts/folder", getHandler as never);
