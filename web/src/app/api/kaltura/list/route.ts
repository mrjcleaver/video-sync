/**
 * POST /api/kaltura/list
 * Lists media entries from a Kaltura account between two dates.
 * Used by KalturaImport to surface entries the operator can pull into
 * the catalog as records with source_platform: "Kaltura".
 *
 * Body: { partnerId, adminSecret, from?: "YYYY-MM-DD", to?: "YYYY-MM-DD" }
 *
 * Response: { entries: KalturaEntry[], total: number }
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getSharedCredential } from "../../../../lib/sharedCredentials";

// Dynamic — calls Kaltura API.
export const dynamic = "force-dynamic";

const KALTURA_BASE = "https://www.kaltura.com/api_v3";

interface KalturaEntry {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;        // ISO from createdAt epoch
  duration_seconds: number;
  tags: string[];
  thumbnail_url: string | null;
  player_url: string;
  is_live: boolean;
}

async function kalturaCall(
  service: string,
  action: string,
  params: Record<string, string | number | object>,
): Promise<unknown> {
  const body = new URLSearchParams();
  body.set("format", "1");
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "object" && v !== null) {
      for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
        body.set(`${k}:${kk}`, String(vv));
      }
    } else {
      body.set(k, String(v));
    }
  }
  const res = await fetch(`${KALTURA_BASE}/?service=${service}&action=${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Kaltura ${service}.${action} ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

async function handler(req: NextRequest) {
  let body: { partnerId?: string; adminSecret?: string; from?: string; to?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const shared = (await getSharedCredential("kaltura")) ?? {};
  const sharedAny = shared as { partnerId?: string; adminSecret?: string; apiKey?: string };
  const partnerId = body.partnerId || sharedAny.partnerId || process.env.KALTURA_PARTNER_ID;
  // Accept both `adminSecret` (current convention) and `apiKey` (legacy
  // shape from earlier Phase-2 saves) when reading the shared payload.
  const adminSecret = body.adminSecret || sharedAny.adminSecret || sharedAny.apiKey || process.env.KALTURA_ADMIN_SECRET;
  if (!partnerId || !adminSecret) {
    return NextResponse.json({ error: "partnerId and adminSecret are required" }, { status: 400 });
  }
  const rid = req.headers.get("x-request-id") ?? "n/a";

  // 1. Mint admin KS
  let ks: string;
  try {
    const sessRes = await kalturaCall("session", "start", {
      partnerId,
      secret: adminSecret,
      type: 2,
      userId: "video-sync",
      expiry: 3600,
    });
    if (typeof sessRes === "string") ks = sessRes;
    else if (sessRes && typeof sessRes === "object" && "result" in sessRes) {
      ks = String((sessRes as { result?: string }).result ?? "");
    } else {
      throw new Error(`session.start returned ${JSON.stringify(sessRes).slice(0, 200)}`);
    }
    if (!ks || ks.length < 10) throw new Error("session.start returned empty KS");
  } catch (err) {
    serverLog("error", "ext:kaltura-session", "auth failed", { error: String(err), rid });
    return NextResponse.json({ error: `Kaltura auth: ${String(err)}` }, { status: 502 });
  }

  // 2. media.list with optional date filter
  // filter:createdAtGreaterThanOrEqual / createdAtLessThanOrEqual are unix seconds.
  const filter: Record<string, string | number> = {
    statusEqual: 2, // READY
    objectType: "KalturaMediaEntryFilter",
  };
  if (body.from) filter.createdAtGreaterThanOrEqual = Math.floor(new Date(body.from).getTime() / 1000);
  if (body.to) filter.createdAtLessThanOrEqual = Math.floor(new Date(body.to + "T23:59:59Z").getTime() / 1000);

  let raw: unknown;
  try {
    raw = await kalturaCall("media", "list", {
      ks,
      filter,
      pager: { pageSize: 200, pageIndex: 1, objectType: "KalturaFilterPager" },
    });
  } catch (err) {
    serverLog("error", "ext:kaltura-list", "media.list failed", { error: String(err), rid });
    return NextResponse.json({ error: `Kaltura list: ${String(err)}` }, { status: 502 });
  }

  // Kaltura responses come as either { objects: [...], totalCount } at the
  // top level or wrapped in { result: { objects, totalCount } } depending on
  // KS context. Tolerant unwrap.
  function unwrap(v: unknown): { objects?: unknown[]; totalCount?: number } {
    if (!v || typeof v !== "object") return {};
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.objects)) return o as { objects: unknown[]; totalCount?: number };
    if (o.result && typeof o.result === "object") return unwrap(o.result);
    return {};
  }
  const { objects = [], totalCount = 0 } = unwrap(raw);

  const entries: KalturaEntry[] = objects.map((o): KalturaEntry => {
    const e = o as Record<string, unknown>;
    const id = String(e.id ?? "");
    const createdAtSecs = Number(e.createdAt ?? 0);
    // Kaltura may report fractional seconds; the WASM IndexVideo command
    // needs an integer (u32). Round here so every consumer gets a clean int.
    const duration = Math.max(0, Math.round(Number(e.duration ?? 0)));
    const tagsRaw = String(e.tags ?? "");
    const playerUrl = `https://cdnapisec.kaltura.com/p/${partnerId}/sp/${partnerId}00/embedIframeJs/uiconf_id/0/partner_id/${partnerId}?iframeembed=true&entry_id=${id}`;
    return {
      id,
      name: String(e.name ?? "Untitled"),
      description: e.description != null ? String(e.description) : null,
      createdAt: createdAtSecs > 0 ? new Date(createdAtSecs * 1000).toISOString() : new Date().toISOString(),
      duration_seconds: duration,
      tags: tagsRaw ? tagsRaw.split(",").map(s => s.trim()).filter(Boolean) : [],
      thumbnail_url: e.thumbnailUrl != null ? String(e.thumbnailUrl) : null,
      player_url: playerUrl,
      is_live: Number(e.mediaType) === 7 || Number(e.mediaType) === 201,
    };
  });

  serverLog("info", "ext:kaltura-list", "done", { count: entries.length, totalCount, rid });
  return NextResponse.json({ entries, total: totalCount || entries.length });
}

export const POST = withRequestLogging("api:kaltura/list", handler);
