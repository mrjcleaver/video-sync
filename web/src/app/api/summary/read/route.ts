/**
 * GET /api/summary/read?docId=<summary_doc_id>
 *
 * Returns the current Show Notes content as markdown text. The Show
 * Notes (ADR-046) live as a native Google Doc — Drive's files.export
 * with `text/markdown` gives us the same source text summaryGenerate
 * wrote, timestamp markers intact. Falls back to `text/plain` when
 * the deployment's Drive API surface doesn't ship the markdown
 * mimeType (older accounts).
 *
 * Used by the description regenerator so the paragraph description
 * can be sourced from the already-curated Show Notes rather than the
 * raw transcript.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getDrive } from "../../../../lib/drive";
import { getActor } from "../../../../lib/auth";

export const dynamic = "force-dynamic";

async function handler(req: NextRequest) {
  try { await getActor(req); }
  catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }

  const docId = req.nextUrl.searchParams.get("docId");
  if (!docId) {
    return NextResponse.json({ error: "docId query param required" }, { status: 400 });
  }

  const drive = getDrive();
  let content = "";
  let mimeUsed = "text/markdown";
  try {
    const md = await drive.files.export({ fileId: docId, mimeType: "text/markdown" });
    if (typeof md.data === "string") content = md.data;
  } catch (err) {
    serverLog("warn", "api:summary/read", "markdown export failed, trying text/plain", { docId, error: String(err).slice(0, 200) });
  }
  if (!content) {
    try {
      const txt = await drive.files.export({ fileId: docId, mimeType: "text/plain" });
      if (typeof txt.data === "string") content = txt.data;
      mimeUsed = "text/plain";
    } catch (err) {
      serverLog("error", "api:summary/read", "both markdown and text export failed", { docId, error: String(err).slice(0, 200) });
      return NextResponse.json({ error: `Drive export failed for docId ${docId}` }, { status: 502 });
    }
  }
  if (!content) {
    return NextResponse.json({ error: "Show Notes doc empty or unreadable" }, { status: 404 });
  }

  return new NextResponse(content, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Source-Mime": mimeUsed,
      "Cache-Control": "private, max-age=60",
    },
  });
}

export const GET = withRequestLogging("api:summary/read", handler);
