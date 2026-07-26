/**
 * ADR-058 Option D — server-persisted import bookkeeping.
 *
 * Records the last date range checked per source-platform. Used by
 * the Overview / Calendar to distinguish "empty because we checked
 * and nothing was there" from "empty because we haven't looked at
 * that day yet."
 *
 * Storage (data/import-state.json), ADR-031 pattern:
 *   {
 *     sources: {
 *       Zoom:      { last_checked_at: ISO, last_range_from: YYYY-MM-DD, last_range_to: YYYY-MM-DD },
 *       Fireflies: { ... },
 *       YouTube:   { ... },
 *       Kaltura:   { ... }
 *     }
 *   }
 *
 * GET  → whole state
 * POST → { source, from, to } — merges one source's entry with
 *   last_checked_at=now(). Widens (from,to) to cover the widest
 *   range the operator has ever queried, so an operator who did a
 *   narrow probe doesn't erase the confidence gained from a
 *   previous wide sweep.
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { withRequestLogging } from "../../../lib/serverLogger";

const STATE_FILE = join(process.cwd(), "data", "import-state.json");

interface SourceState {
  last_checked_at: string;
  last_range_from: string;
  last_range_to: string;
}

interface ImportState {
  sources: Record<string, SourceState>;
}

async function readState(): Promise<ImportState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ImportState>;
    return { sources: parsed.sources && typeof parsed.sources === "object" ? parsed.sources : {} };
  } catch {
    return { sources: {} };
  }
}

async function writeState(store: ImportState) {
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(store, null, 2), "utf-8");
}

async function getHandler() {
  return NextResponse.json(await readState());
}

async function postHandler(req: NextRequest) {
  let body: { source?: string; from?: string; to?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { source, from, to } = body;
  if (!source || typeof source !== "string") {
    return NextResponse.json({ error: "source (string) required" }, { status: 400 });
  }
  if (!from || typeof from !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    return NextResponse.json({ error: "from must be YYYY-MM-DD" }, { status: 400 });
  }
  if (!to || typeof to !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: "to must be YYYY-MM-DD" }, { status: 400 });
  }

  const current = await readState();
  const existing = current.sources[source];
  // Widen to the union of previously-known + this-check ranges.
  const nextFrom = existing && existing.last_range_from && existing.last_range_from < from
    ? existing.last_range_from
    : from;
  const nextTo = existing && existing.last_range_to && existing.last_range_to > to
    ? existing.last_range_to
    : to;
  current.sources[source] = {
    last_checked_at: new Date().toISOString(),
    last_range_from: nextFrom,
    last_range_to: nextTo,
  };
  await writeState(current);
  return NextResponse.json(current);
}

export const GET = withRequestLogging("api:import-state", getHandler);
export const POST = withRequestLogging("api:import-state", postHandler);
