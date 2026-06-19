/**
 * GET /api/backfill/profiles  → BackfillProfile[]
 * POST /api/backfill/profiles → replace whole list (ADR-043)
 *
 * Storage: data/backfill-profiles.json on FUSE-mounted GCS bucket.
 * Whole-list replace, last-writer-wins (matches /api/rules pattern).
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { withRequestLogging } from "../../../../lib/serverLogger";

export const dynamic = "force-dynamic";

const FILE = join(process.cwd(), "data", "backfill-profiles.json");

async function readList(): Promise<unknown[]> {
  try {
    const raw = await fs.readFile(FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeList(list: unknown[]): Promise<void> {
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(list, null, 2), "utf-8");
}

async function getHandler() {
  return NextResponse.json(await readList());
}

async function postHandler(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body)) {
    return NextResponse.json({ error: "Array body required" }, { status: 400 });
  }
  await writeList(body);
  return NextResponse.json({ ok: true, count: body.length });
}

export const GET = withRequestLogging("api:backfill/profiles", getHandler);
export const POST = withRequestLogging("api:backfill/profiles", postHandler);
