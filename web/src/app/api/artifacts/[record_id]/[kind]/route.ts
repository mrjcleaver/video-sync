import { NextRequest, NextResponse } from "next/server";
import {
  ARTIFACT_KINDS,
  type ArtifactKind,
  getArtifact,
  setArtifact,
  deleteArtifact,
} from "../../../../../lib/driveArtifactStore";
import { withRequestLogging } from "../../../../../lib/serverLogger";

function isKind(s: string): s is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(s);
}

async function getHandler(req: NextRequest, ctx: { params: Promise<{ record_id: string; kind: string }> }) {
  const { record_id, kind } = await ctx.params;
  if (!isKind(kind)) return NextResponse.json({ error: "invalid kind" }, { status: 400 });
  const forPublish = req.nextUrl.searchParams.get("for_publish") === "1";
  try {
    const result = await getArtifact(record_id, kind, { forPublishPath: forPublish });
    if (!result) return NextResponse.json({ error: "not found" }, { status: 404 });
    return new NextResponse(result.content, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Last-Modified": result.modified,
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

interface PutBody {
  content?: string;
  // Required on first write for a record (when no folder/.meta.json exists yet)
  title?: string;
  source_platform?: string;
  source_id?: string;
  recorded_at?: string;
}

async function putHandler(req: NextRequest, ctx: { params: Promise<{ record_id: string; kind: string }> }) {
  const { record_id, kind } = await ctx.params;
  if (!isKind(kind)) return NextResponse.json({ error: "invalid kind" }, { status: 400 });

  let body: PutBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  if (!body.title || !body.source_platform || !body.source_id || !body.recorded_at) {
    return NextResponse.json({ error: "title, source_platform, source_id, recorded_at required" }, { status: 400 });
  }

  try {
    const entry = await setArtifact(
      {
        record_id,
        title: body.title,
        source_platform: body.source_platform,
        source_id: body.source_id,
        recorded_at: body.recorded_at,
      },
      kind,
      body.content,
    );
    return NextResponse.json({ ok: true, entry });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

async function deleteHandler(_req: NextRequest, ctx: { params: Promise<{ record_id: string; kind: string }> }) {
  const { record_id, kind } = await ctx.params;
  if (!isKind(kind)) return NextResponse.json({ error: "invalid kind" }, { status: 400 });
  try {
    await deleteArtifact(record_id, kind);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export const GET = withRequestLogging("api:artifacts", getHandler as never);
export const PUT = withRequestLogging("api:artifacts", putHandler as never);
export const DELETE = withRequestLogging("api:artifacts", deleteHandler as never);
