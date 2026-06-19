/**
 * GET /api/kaltura/captions?entryId=<entryId>
 *
 * Fetch captions for a Kaltura entry and return them as plain-text
 * transcript ready to populate VideoRecord.transcript_text (and, via
 * the store push, the Drive transcript.md artifact).
 *
 * Flow:
 *   1. Mint admin KS from shared Kaltura credential (ADR-042).
 *   2. caption.captionAsset.list filter[entryIdEqual]=<entryId>
 *      filter[statusEqual]=2 (READY) — returns caption assets attached
 *      to the entry.
 *   3. Pick the best track: English first, else the entry-default,
 *      else first available.
 *   4. caption.captionAsset.serve&captionAssetId=<assetId> returns the
 *      raw caption file (SRT or WebVTT).
 *   5. captionsToTranscript() converts to `[HH:MM:SS] line` per cue.
 *
 * Response: { text, language, captionAssetId, format } or
 *           { error, code } when no usable caption exists.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getSharedCredential } from "../../../../lib/sharedCredentials";
import { captionsToTranscript } from "../../../../lib/srtConverter";

export const dynamic = "force-dynamic";

const KALTURA_BASE = "https://www.kaltura.com/api_v3";

// Kaltura caption format enum
//   1 = SRT, 2 = DFXP/TTML, 3 = WEBVTT, 4 = CAP
const KALTURA_FORMAT: Record<number, string> = { 1: "srt", 2: "dfxp", 3: "vtt", 4: "cap" };

interface KalturaCaptionAsset {
  id?: string;
  language?: string;       // ISO code like "en", "es", "en-US"
  languageCode?: string;
  label?: string;
  format?: number;
  isDefault?: number;      // 1 / 0
  status?: number;
}

async function kalturaPost(service: string, action: string, params: Record<string, string | number | object>): Promise<unknown> {
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
  if (!res.ok) throw new Error(`Kaltura ${service}.${action} ${res.status}`);
  return res.json();
}

function unwrapObjects(v: unknown): KalturaCaptionAsset[] {
  if (!v || typeof v !== "object") return [];
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.objects)) return o.objects as KalturaCaptionAsset[];
  if (o.result && typeof o.result === "object") return unwrapObjects(o.result);
  return [];
}

function pickBest(assets: KalturaCaptionAsset[]): KalturaCaptionAsset | null {
  const ready = assets.filter(a => a.id && (a.status === undefined || a.status === 2));
  if (ready.length === 0) return null;
  // Preference: english → default → first
  const english = ready.find(a => /^en/i.test(a.language ?? "") || /^en/i.test(a.languageCode ?? ""));
  if (english) return english;
  const def = ready.find(a => a.isDefault === 1);
  if (def) return def;
  return ready[0];
}

async function handler(req: NextRequest) {
  const url = new URL(req.url);
  const entryId = url.searchParams.get("entryId")?.trim();
  if (!entryId) {
    return NextResponse.json({ error: "entryId query parameter required" }, { status: 400 });
  }

  const shared = (await getSharedCredential("kaltura")) ?? {};
  const sharedAny = shared as { partnerId?: string; adminSecret?: string; apiKey?: string };
  const partnerId = sharedAny.partnerId || process.env.KALTURA_PARTNER_ID;
  const adminSecret = sharedAny.adminSecret || sharedAny.apiKey || process.env.KALTURA_ADMIN_SECRET;
  if (!partnerId || !adminSecret) {
    return NextResponse.json({ error: "Kaltura shared credential not configured" }, { status: 400 });
  }

  const rid = req.headers.get("x-request-id") ?? "n/a";
  serverLog("info", "ext:kaltura-captions", "starting", { rid, entryId });

  // 1. KS
  let ks: string;
  try {
    const sessRes = await kalturaPost("session", "start", {
      partnerId, secret: adminSecret, type: 2, userId: "video-sync", expiry: 3600,
    });
    if (typeof sessRes === "string") ks = sessRes;
    else if (sessRes && typeof sessRes === "object" && "result" in sessRes) ks = String((sessRes as { result?: string }).result ?? "");
    else throw new Error(`session.start returned ${JSON.stringify(sessRes).slice(0, 200)}`);
    if (!ks || ks.length < 10) throw new Error("session.start returned empty KS");
  } catch (err) {
    serverLog("error", "ext:kaltura-captions", "session failed", { rid, error: String(err) });
    return NextResponse.json({ error: `Kaltura auth: ${String(err)}` }, { status: 502 });
  }

  // 2. List caption assets for this entry.
  let assets: KalturaCaptionAsset[];
  try {
    const raw = await kalturaPost("caption_captionasset", "list", {
      ks,
      filter: {
        objectType: "KalturaAssetFilter",
        entryIdEqual: entryId,
      },
      pager: { pageSize: 50, pageIndex: 1, objectType: "KalturaFilterPager" },
    });
    assets = unwrapObjects(raw);
  } catch (err) {
    serverLog("error", "ext:kaltura-captions", "list failed", { rid, entryId, error: String(err) });
    return NextResponse.json({ error: `Kaltura caption list: ${String(err)}` }, { status: 502 });
  }

  if (assets.length === 0) {
    serverLog("info", "ext:kaltura-captions", "no captions", { rid, entryId });
    return NextResponse.json({ error: "No captions exist on this Kaltura entry", code: "no_captions" }, { status: 404 });
  }

  const picked = pickBest(assets);
  if (!picked || !picked.id) {
    serverLog("info", "ext:kaltura-captions", "no ready captions", { rid, entryId, count: assets.length });
    return NextResponse.json({ error: "Kaltura has caption assets but none are READY", code: "no_ready_captions" }, { status: 409 });
  }

  // 3. Serve the caption file. Returns the raw bytes (SRT or VTT or DFXP).
  let serveRaw: string;
  try {
    const serveRes = await fetch(`${KALTURA_BASE}/?service=caption_captionasset&action=serve&captionAssetId=${encodeURIComponent(picked.id)}&ks=${encodeURIComponent(ks)}`, { method: "GET", redirect: "follow" });
    if (!serveRes.ok) throw new Error(`HTTP ${serveRes.status}`);
    const ctype = serveRes.headers.get("content-type") ?? "";
    if (ctype.includes("text/html") || ctype.includes("application/xml") && !ctype.includes("dfxp")) {
      const peek = (await serveRes.text()).slice(0, 200);
      throw new Error(`Kaltura returned ${ctype} not media; preview: ${peek}`);
    }
    serveRaw = await serveRes.text();
  } catch (err) {
    serverLog("error", "ext:kaltura-captions", "serve failed", { rid, entryId, assetId: picked.id, error: String(err) });
    return NextResponse.json({ error: `Kaltura caption serve: ${String(err)}` }, { status: 502 });
  }

  const format = KALTURA_FORMAT[picked.format ?? 0] ?? "unknown";
  if (format === "dfxp" || format === "cap" || format === "unknown") {
    // Not handled by the SRT/VTT converter; return raw so the client can
    // at least see something, but flag it.
    serverLog("warn", "ext:kaltura-captions", "unconverted format", { rid, entryId, format });
    return NextResponse.json(
      { error: `Caption format '${format}' is not yet supported — only SRT and WebVTT are converted to transcript`, code: "unsupported_format", format },
      { status: 415 },
    );
  }

  const text = captionsToTranscript(serveRaw);
  if (!text || text.length < 10) {
    serverLog("warn", "ext:kaltura-captions", "empty after conversion", { rid, entryId, rawLen: serveRaw.length });
    return NextResponse.json({ error: "Caption file converted to empty transcript", code: "empty_conversion" }, { status: 422 });
  }

  serverLog("info", "ext:kaltura-captions", "done", { rid, entryId, assetId: picked.id, format, language: picked.language ?? picked.languageCode, lineCount: text.split("\n").length });
  return NextResponse.json({
    text,
    language: picked.language ?? picked.languageCode ?? "unknown",
    captionAssetId: picked.id,
    format,
  });
}

export const GET = withRequestLogging("api:kaltura/captions", handler);
