import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { withRequestLogging, serverLog } from "../../../lib/serverLogger";

// ADR-035 Level 2 — server-side catalog. Records persisted as
// WASM-serialised JSON strings, keyed by record id, with a sidecar
// lastModified map (ISO timestamps) used by clients for per-record
// last-writer-wins merge on boot.
//
// Storage shape (data/catalog.json):
//   { records: { [id]: <wasm-json-string> },
//     lastModified: { [id]: <ISO> } }
//
// Persistence is currently ephemeral on Cloud Run (FUSE mount blocked
// on IAM — ADR-035 Level 1). Clients re-push from localStorage on boot
// after cold starts; same self-seeding pattern as data/rules.json.

const CATALOG_FILE = join(process.cwd(), "data", "catalog.json");

interface CatalogStore {
  records: Record<string, string>;
  lastModified: Record<string, string>;
}

// In-process mutex. Node's event loop is single-threaded but the
// read-merge-write cycle awaits between steps, so two concurrent
// requests can interleave and overwrite each other. Serializing
// ensures the bulk initial push from a fresh browser doesn't lose
// records. (Limitation: across Cloud Run instances this lock is
// per-instance — multi-instance race remains until ADR-035 Tier 2 SQLite.)
let writeQueue: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn);
  writeQueue = next.then(() => undefined, () => undefined);
  return next;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readCatalog(): Promise<CatalogStore> {
  try {
    const raw = await fs.readFile(CATALOG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CatalogStore>;
    // Defensive: an out-of-band script could clobber these fields to
    // the wrong type and every subsequent write would TypeError on
    // property assignment. Coerce wrong-type values to {} and warn —
    // the route then self-heals on the next successful write.
    // See ADR-035; incident 2026-06-07 (`lastModified` clobbered to
    // a string by a Python migration → all POSTs 500'd silently).
    let records: Record<string, string> = {};
    if (isPlainObject(parsed.records)) {
      records = parsed.records as Record<string, string>;
    } else if (parsed.records !== undefined) {
      serverLog("warn", "api:catalog", "records-shape-corrupt", { actualType: typeof parsed.records, coercedTo: "{}" });
    }
    let lastModified: Record<string, string> = {};
    if (isPlainObject(parsed.lastModified)) {
      lastModified = parsed.lastModified as Record<string, string>;
    } else if (parsed.lastModified !== undefined) {
      serverLog("warn", "api:catalog", "lastModified-shape-corrupt", { actualType: typeof parsed.lastModified, coercedTo: "{}" });
    }
    return { records, lastModified };
  } catch {
    return { records: {}, lastModified: {} };
  }
}

async function writeCatalog(store: CatalogStore) {
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  await fs.writeFile(CATALOG_FILE, JSON.stringify(store), "utf-8");
}

async function getHandler() {
  return NextResponse.json(await readCatalog());
}

async function postHandler(req: NextRequest) {
  interface Item { id?: string; json?: string; lastModified?: string }
  let body: Item & { records?: Item[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  // Accept either single-record shape (legacy) or a `records` array.
  // Batching collapses N pushes into one read-merge-write cycle, so
  // a burst of client mutations doesn't stack against the serialized
  // writeQueue and time out at Cloud Run's 30s request cap.
  const items: Item[] = Array.isArray(body.records) ? body.records : [body];
  const validated: Array<{ id: string; json: string; ts: string }> = [];
  for (const it of items) {
    if (!it.id || typeof it.id !== "string") {
      return NextResponse.json({ error: "id required for each record" }, { status: 400 });
    }
    if (!it.json || typeof it.json !== "string") {
      return NextResponse.json({ error: "json required for each record" }, { status: 400 });
    }
    try {
      const parsed = JSON.parse(it.json) as { id?: string };
      if (parsed.id !== it.id) {
        return NextResponse.json({ error: `id mismatch on record ${it.id}` }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: `json malformed on record ${it.id}` }, { status: 400 });
    }
    validated.push({ id: it.id, json: it.json, ts: it.lastModified ?? new Date().toISOString() });
  }
  return withLock(async () => {
    const current = await readCatalog();
    for (const v of validated) {
      current.records[v.id] = v.json;
      current.lastModified[v.id] = v.ts;
    }
    await writeCatalog(current);
    return NextResponse.json({ ok: true, count: validated.length });
  });
}

async function deleteHandler(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id query param required" }, { status: 400 });
  }
  return withLock(async () => {
    const current = await readCatalog();
    delete current.records[id];
    delete current.lastModified[id];
    await writeCatalog(current);
    return NextResponse.json({ ok: true, id });
  });
}

export const GET = withRequestLogging("api:catalog", getHandler);
export const POST = withRequestLogging("api:catalog", postHandler);
export const DELETE = withRequestLogging("api:catalog", deleteHandler);
