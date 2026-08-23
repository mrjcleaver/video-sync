/**
 * Server-side catalog store (ADR-035 Level 2).
 *
 * Extracted from app/api/catalog/route.ts: a Next.js route module may only
 * export request handlers and a fixed set of config values, so exporting
 * readCatalog from there violated the route contract and failed the
 * generated route-type check — which is what blocked `deploy.sh`'s
 * pre-flight. Five modules import readCatalog, so it belongs in lib.
 *
 * Server-only — never import from a client component.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { serverLog } from "./serverLogger";

const CATALOG_FILE = join(process.cwd(), "data", "catalog.json");

export interface CatalogStore {
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
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn);
  writeQueue = next.then(() => undefined, () => undefined);
  return next;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function readCatalog(): Promise<CatalogStore> {
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
      serverLog("warn", "lib:catalogStore", "records-shape-corrupt", { actualType: typeof parsed.records, coercedTo: "{}" });
    }
    let lastModified: Record<string, string> = {};
    if (isPlainObject(parsed.lastModified)) {
      lastModified = parsed.lastModified as Record<string, string>;
    } else if (parsed.lastModified !== undefined) {
      serverLog("warn", "lib:catalogStore", "lastModified-shape-corrupt", { actualType: typeof parsed.lastModified, coercedTo: "{}" });
    }
    return { records, lastModified };
  } catch {
    return { records: {}, lastModified: {} };
  }
}

export async function writeCatalog(store: CatalogStore) {
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  await fs.writeFile(CATALOG_FILE, JSON.stringify(store), "utf-8");
}

