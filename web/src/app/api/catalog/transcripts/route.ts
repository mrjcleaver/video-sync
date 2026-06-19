import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getArtifact, getMeta } from "../../../../lib/driveArtifactStore";

// ADR-039: this endpoint is being phased out.
//
//   - GET (no id):       enumerates Drive — returns the same `{ id: text }` shape
//                         existing browsers expect on boot.
//   - GET (with ?id=X):  reads the single transcript from Drive.
//   - POST:              410 Gone — clients should PUT to /api/artifacts/:id/transcript.
//   - DELETE:            410 Gone — clients should DELETE /api/artifacts/:id/transcript.
//
// All responses include Deprecation + Sunset headers. Once videoStore on
// every active browser has migrated to /api/artifacts/..., this whole
// route is removed.

const CATALOG_FILE = join(process.cwd(), "data", "catalog.json");
const SUNSET_DATE = "Fri, 30 May 2026 00:00:00 GMT";

const DEPRECATION_HEADERS: Record<string, string> = {
  Deprecation: "true",
  Sunset: SUNSET_DATE,
  Link: '</api/artifacts>; rel="successor-version"',
};

interface CatalogStore {
  records: Record<string, string>;
  lastModified?: Record<string, string>;
}

async function listRecordIds(): Promise<string[]> {
  try {
    const raw = await fs.readFile(CATALOG_FILE, "utf-8");
    const c = JSON.parse(raw) as CatalogStore;
    return Object.keys(c.records ?? {});
  } catch {
    return [];
  }
}

function stripFrontmatter(md: string): string {
  if (!md.startsWith("---\n")) return md;
  const end = md.indexOf("\n---\n", 4);
  if (end < 0) return md;
  return md.slice(end + 5).replace(/^\n+/, "");
}

async function getHandler(req: NextRequest) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id) {
    try {
      const r = await getArtifact(id, "transcript");
      if (!r) return NextResponse.json({ error: "not found" }, { status: 404, headers: DEPRECATION_HEADERS });
      return NextResponse.json({ id, text: stripFrontmatter(r.content) }, { headers: DEPRECATION_HEADERS });
    } catch (err) {
      serverLog("warn", "api:catalog/transcripts", "drive read failed", { error: String(err) });
      return NextResponse.json({ error: "drive unavailable" }, { status: 503, headers: DEPRECATION_HEADERS });
    }
  }

  // Bulk enumeration — slow but used by old browsers' boot sync.
  // For each known record, fetch the transcript artifact (if any).
  const ids = await listRecordIds();
  const result: Record<string, string> = {};
  await Promise.all(
    ids.map(async (rid) => {
      try {
        // getMeta is cheap (cached) — skip getArtifact when no transcript exists
        const meta = await getMeta(rid);
        if (!meta?.artifacts.transcript) return;
        const r = await getArtifact(rid, "transcript");
        if (r) result[rid] = stripFrontmatter(r.content);
      } catch {
        // skip individual failures
      }
    }),
  );
  return NextResponse.json(result, { headers: DEPRECATION_HEADERS });
}

async function gone() {
  return NextResponse.json(
    { error: "endpoint removed; use /api/artifacts/:record_id/:kind" },
    { status: 410, headers: DEPRECATION_HEADERS },
  );
}

export const GET = withRequestLogging("api:catalog/transcripts", getHandler);
export const POST = withRequestLogging("api:catalog/transcripts", gone);
export const DELETE = withRequestLogging("api:catalog/transcripts", gone);
