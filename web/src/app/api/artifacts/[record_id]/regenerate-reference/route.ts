/**
 * POST /api/artifacts/:record_id/regenerate-reference
 *
 * ADR-074 §3 — regenerate reference.md for a single record. Called
 * manually from the /maintain regenerate-artifact-bags card (§6) and
 * lazily from MCP's get_reference miss path.
 *
 * Fails legibly (200 { ok: false, reason }) if the record isn't in
 * the catalog or doesn't yet have an artifact folder.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../../lib/serverLogger";
import { readCatalog } from "../../../../../lib/catalogStore";
import { generateAndStoreReference } from "../../../../../lib/referenceRenderer";
import type { VideoRecordJSON } from "../../../../../lib/wasm";

export const dynamic = "force-dynamic";

async function handler(_req: NextRequest, ctx: { params: Promise<{ record_id: string }> }) {
  const { record_id } = await ctx.params;
  if (!record_id) return NextResponse.json({ error: "record_id required" }, { status: 400 });

  const store = await readCatalog();
  const raw = store.records[record_id];
  if (!raw) return NextResponse.json({ ok: false, reason: "record not in catalog" });
  const rec = JSON.parse(raw) as VideoRecordJSON;

  const result = await generateAndStoreReference(rec);
  return NextResponse.json(result);
}

export const POST = withRequestLogging("api:artifacts/regenerate-reference", handler as never);
