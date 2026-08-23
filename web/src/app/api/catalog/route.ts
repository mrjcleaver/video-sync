import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { withRequestLogging, serverLog } from "../../../lib/serverLogger";
import { getActor } from "../../../lib/auth";
import { readCatalog, writeCatalog, withLock, type CatalogStore } from "../../../lib/catalogStore";

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

async function getHandler(req: NextRequest) {
  const store = await readCatalog();
  // ADR-065 — role-scoped catalog. When the caller is a Contributor,
  // return only records whose contributor_email matches their own.
  // Publisher / Admin / Viewer see the full catalog (existing behaviour).
  let actor;
  try { actor = await getActor(req); }
  catch { return NextResponse.json(store); }  // no actor → return unfiltered; upstream IAP already gated the origin
  if (actor.role !== "Contributor") return NextResponse.json(store);
  const filteredRecords: Record<string, string> = {};
  const filteredLastModified: Record<string, string> = {};
  for (const [id, json] of Object.entries(store.records)) {
    try {
      const parsed = JSON.parse(json) as { contributor_email?: string | null };
      if (parsed.contributor_email && parsed.contributor_email === actor.email) {
        filteredRecords[id] = json;
        if (store.lastModified[id]) filteredLastModified[id] = store.lastModified[id];
      }
    } catch { /* skip malformed */ }
  }
  return NextResponse.json({ records: filteredRecords, lastModified: filteredLastModified });
}

async function postHandler(req: NextRequest) {
  // ADR-065 — Contributor may only write records they own (contributor_email
  // === actor.email). Publisher / Admin unrestricted; Viewer blocked.
  let actor;
  try { actor = await getActor(req); }
  catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }
  if (actor.role === "Viewer") {
    return NextResponse.json({ error: "Contributor+ required to write records" }, { status: 403 });
  }
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
  const isContributor = actor.role === "Contributor";
  for (const it of items) {
    if (!it.id || typeof it.id !== "string") {
      return NextResponse.json({ error: "id required for each record" }, { status: 400 });
    }
    if (!it.json || typeof it.json !== "string") {
      return NextResponse.json({ error: "json required for each record" }, { status: 400 });
    }
    try {
      const parsed = JSON.parse(it.json) as { id?: string; contributor_email?: string | null };
      if (parsed.id !== it.id) {
        return NextResponse.json({ error: `id mismatch on record ${it.id}` }, { status: 400 });
      }
      // ADR-065 — Contributor may only write records with their own attribution.
      // Blocks a contributor from tampering with someone else's record by id.
      if (isContributor && parsed.contributor_email !== actor.email) {
        return NextResponse.json(
          { error: `Contributor may only write records with contributor_email === "${actor.email}" (record ${it.id} has "${parsed.contributor_email ?? "null"}")` },
          { status: 403 },
        );
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
