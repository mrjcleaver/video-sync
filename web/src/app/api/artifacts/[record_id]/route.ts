import { NextRequest, NextResponse } from "next/server";
import { getMeta } from "../../../../lib/driveArtifactStore";
import { withRequestLogging } from "../../../../lib/serverLogger";

// Skip static-pre-render at build time — dynamic by definition; saves
// memory in the build worker (Next 15 OOMs in low-memory devcontainers).
export const dynamic = "force-dynamic";

// GET /api/artifacts/:record_id
// Returns the .meta.json index for this record's Drive folder.
async function getHandler(_req: NextRequest, ctx: { params: Promise<{ record_id: string }> }) {
  const { record_id } = await ctx.params;
  if (!record_id) return NextResponse.json({ error: "record_id required" }, { status: 400 });
  try {
    const meta = await getMeta(record_id);
    if (!meta) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(meta);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export const GET = withRequestLogging("api:artifacts/meta", getHandler as never);
