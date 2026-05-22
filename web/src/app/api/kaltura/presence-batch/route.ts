/**
 * POST /api/kaltura/presence-batch
 *
 * Per ADR-044: resolve Kaltura presence for a batch of catalog record IDs
 * without requiring the operator to have previously published any of them
 * from this app.
 *
 * Body:  { recordIds: string[] }
 * Returns: {
 *   presence: Record<recordId, {
 *     state: "ready" | "processing" | "live" | "absent",
 *     entryId?: string,
 *     playerUrl?: string,
 *     matchedBy: "referenceId" | "footer",
 *     checkedAt: ISO,
 *   }>;
 *   missing: string[];   // recordIds we asked about and did not find on Kaltura
 * }
 *
 * Strategy (in order):
 *   1. media.list with filter[referenceIdIn] — definitive, one call per batch
 *      (Kaltura's IN filter takes a comma-separated list)
 *   2. For unmatched ids, parse ADR-022 provenance footer markers
 *      ("catalog:<uuid>") out of entry descriptions. This requires a second
 *      pass with a freeText filter — we issue one call per remaining id,
 *      capped to 10 ids per batch to keep quota bounded.
 *
 * Fuzzy title+date matching is an Open Question in the ADR and deferred.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getSharedCredential } from "../../../../lib/sharedCredentials";

export const dynamic = "force-dynamic";

const KALTURA_BASE = "https://www.kaltura.com/api_v3";
const FOOTER_LOOKUP_CAP = 10;

// Kaltura entry status enum (https://developer.kaltura.com/api-docs/General_Objects/Enums/KalturaEntryStatus)
//   2 = READY, 4 = MODERATE, 5 = BLOCKED, 0/1 = ERROR_IMPORTING / IMPORT, 7 = NO_CONTENT,
//   -1 = ERROR_CONVERTING, -2 = ERROR_IMPORTING, 3 = PRECONVERT
const READY_STATUS = 2;
const PRECONVERT_STATUS = 3;

// mediaType values: 1 = VIDEO, 7 = LIVE_STREAM_FLASH, 201 = LIVE_STREAM_QUICKTIME
const LIVE_MEDIA_TYPES = new Set([7, 201]);

type MatchedBy = "referenceId" | "footer";
type PresenceState = "ready" | "processing" | "live" | "absent";

interface PresenceEntry {
  state: PresenceState;
  entryId?: string;
  playerUrl?: string;
  matchedBy: MatchedBy;
  checkedAt: string;
}

interface KalturaMediaEntry {
  id?: string;
  referenceId?: string;
  description?: string;
  status?: number;
  mediaType?: number;
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

function unwrapObjects(v: unknown): KalturaMediaEntry[] {
  if (!v || typeof v !== "object") return [];
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.objects)) return o.objects as KalturaMediaEntry[];
  if (o.result && typeof o.result === "object") return unwrapObjects(o.result);
  return [];
}

function classify(entry: KalturaMediaEntry): PresenceState {
  const status = Number(entry.status ?? 0);
  const mediaType = Number(entry.mediaType ?? 0);
  if (LIVE_MEDIA_TYPES.has(mediaType)) return "live";
  if (status === READY_STATUS) return "ready";
  if (status === PRECONVERT_STATUS || status === 0 || status === 1) return "processing";
  // Errored / blocked / no content all surface to the operator as "absent"
  // (the entry exists on Kaltura but isn't playable). Treating these as
  // absent invites a re-publish; a future refinement could distinguish.
  return "absent";
}

function playerUrlFor(entryId: string, partnerId: string): string {
  return `https://cdnapisec.kaltura.com/p/${partnerId}/sp/${partnerId}00/embedIframeJs/uiconf_id/0/partner_id/${partnerId}?iframeembed=true&entry_id=${entryId}`;
}

// Parse the ADR-022 footer marker "catalog:<uuid>" out of an entry description.
// The footer format is:
//   \n---\nvideo-sync provenance\ncatalog_id: <uuid>\n...
// or the compact form:
//   ... | catalog:<uuid> | ...
// Match both.
function extractCatalogId(description: string | undefined): string | null {
  if (!description) return null;
  const verbose = description.match(/catalog_id:\s*([0-9a-f-]{36})/i);
  if (verbose) return verbose[1].toLowerCase();
  const compact = description.match(/catalog:([0-9a-f-]{36})/i);
  if (compact) return compact[1].toLowerCase();
  return null;
}

async function handler(req: NextRequest) {
  let body: { recordIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const recordIds = Array.isArray(body.recordIds)
    ? body.recordIds.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{8,40}$/i.test(x))
    : [];
  if (recordIds.length === 0) {
    return NextResponse.json({ presence: {}, missing: [] });
  }

  const shared = (await getSharedCredential("kaltura")) ?? {};
  const sharedAny = shared as { partnerId?: string; adminSecret?: string; apiKey?: string };
  const partnerId = sharedAny.partnerId || process.env.KALTURA_PARTNER_ID;
  const adminSecret = sharedAny.adminSecret || sharedAny.apiKey || process.env.KALTURA_ADMIN_SECRET;
  if (!partnerId || !adminSecret) {
    return NextResponse.json({ error: "Kaltura shared credential not configured" }, { status: 400 });
  }

  const rid = req.headers.get("x-request-id") ?? "n/a";

  // Mint admin KS
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

  const presence: Record<string, PresenceEntry> = {};
  const checkedAt = new Date().toISOString();
  const stillUnmatched = new Set(recordIds);

  // Strategy 1: filter[referenceIdIn]
  try {
    const raw = await kalturaCall("media", "list", {
      ks,
      filter: {
        objectType: "KalturaMediaEntryFilter",
        referenceIdIn: recordIds.join(","),
      },
      pager: { pageSize: 500, pageIndex: 1, objectType: "KalturaFilterPager" },
    });
    const objects = unwrapObjects(raw);
    for (const entry of objects) {
      const refId = (entry.referenceId ?? "").toLowerCase();
      if (!refId || !stillUnmatched.has(refId)) continue;
      const entryId = entry.id;
      if (!entryId) continue;
      presence[refId] = {
        state: classify(entry),
        entryId,
        playerUrl: playerUrlFor(entryId, String(partnerId)),
        matchedBy: "referenceId",
        checkedAt,
      };
      stillUnmatched.delete(refId);
    }
  } catch (err) {
    serverLog("error", "ext:kaltura-presence", "referenceIdIn lookup failed", { error: String(err), rid });
    // Fall through — we'll still try the footer path for those we have.
  }

  // Strategy 2: ADR-022 footer fallback. Issue one media.list per
  // unmatched id, capped, with filter[descriptionLike]=<short uuid prefix>.
  // We don't pass the full UUID because Kaltura's freeText/descriptionLike
  // filters tokenise; an 8-char prefix is enough to uniquely identify a
  // catalog id in the description in practice.
  const footerCandidates = [...stillUnmatched].slice(0, FOOTER_LOOKUP_CAP);
  for (const recordId of footerCandidates) {
    try {
      const raw = await kalturaCall("media", "list", {
        ks,
        filter: {
          objectType: "KalturaMediaEntryFilter",
          freeText: `catalog:${recordId.slice(0, 8)}`,
        },
        pager: { pageSize: 5, pageIndex: 1, objectType: "KalturaFilterPager" },
      });
      const objects = unwrapObjects(raw);
      for (const entry of objects) {
        const extracted = extractCatalogId(entry.description);
        if (extracted === recordId.toLowerCase() && entry.id) {
          presence[recordId] = {
            state: classify(entry),
            entryId: entry.id,
            playerUrl: playerUrlFor(entry.id, String(partnerId)),
            matchedBy: "footer",
            checkedAt,
          };
          stillUnmatched.delete(recordId);
          break;
        }
      }
    } catch (err) {
      serverLog("warn", "ext:kaltura-presence", "footer lookup failed", { recordId, error: String(err), rid });
    }
  }

  // Anything still unmatched after both passes is "missing" — the caller
  // should cache as `absent` so we don't keep hammering Kaltura for it.
  const missing = [...stillUnmatched];

  serverLog("info", "ext:kaltura-presence", "done", {
    requested: recordIds.length,
    matched: Object.keys(presence).length,
    missing: missing.length,
    rid,
  });

  return NextResponse.json({ presence, missing });
}

export const POST = withRequestLogging("api:kaltura/presence-batch", handler);
