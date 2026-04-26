import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";

/**
 * GET /api/kaltura/status?entryId=<id>
 *
 * Headers: x-kaltura-partner-id, x-kaltura-admin-secret (or env vars).
 * Returns: { status, mediaType, accessControlId, viewCount, plays }.
 *
 * Status values mirror the YouTube path: "Live" | "Processing" |
 * "ProcessingFailed" | "Removed" | <raw>.
 */

const KALTURA_BASE = "https://www.kaltura.com/api_v3";

const STATUS_MAP: Record<string, string> = {
  "1": "Live",                // READY
  "2": "Processing",          // IMPORT
  "3": "Processing",          // PRECONVERT
  "4": "Live",                // READY (legacy)
  "5": "ProcessingFailed",    // ERROR_CONVERTING
  "6": "Removed",             // ERROR_IMPORTING
  "7": "Processing",          // MODERATE
  "8": "Removed",             // BLOCKED
  "9": "Removed",             // DELETED
};

async function handler(req: NextRequest) {
  const entryId = req.nextUrl.searchParams.get("entryId");
  if (!entryId) {
    return NextResponse.json({ error: "entryId query param required" }, { status: 400 });
  }

  const partnerId = req.headers.get("x-kaltura-partner-id") || process.env.KALTURA_PARTNER_ID;
  const adminSecret = req.headers.get("x-kaltura-admin-secret") || process.env.KALTURA_ADMIN_SECRET;
  if (!partnerId || !adminSecret) {
    return NextResponse.json({ error: "Kaltura credentials required" }, { status: 400 });
  }

  // Mint a short-lived admin KS
  const ksRes = await fetch(`${KALTURA_BASE}/?service=session&action=start&format=1`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      partnerId,
      secret: adminSecret,
      type: "2",
      expiry: "300",
      userId: "video-sync-status",
    }),
  });
  if (!ksRes.ok) return NextResponse.json({ error: `KS mint failed (${ksRes.status})` }, { status: 502 });
  const ks = await ksRes.text();
  // session.start returns a bare quoted string when format=1
  const ksValue = ks.replace(/^"|"$/g, "");
  if (!ksValue || ksValue.length < 10) {
    return NextResponse.json({ error: "Kaltura returned no usable KS" }, { status: 502 });
  }

  // Fetch the media entry
  const getRes = await fetch(`${KALTURA_BASE}/?service=media&action=get&format=1`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ks: ksValue, entryId }),
  });
  if (!getRes.ok) {
    return NextResponse.json({ error: `media.get failed (${getRes.status})` }, { status: 502 });
  }
  const data = await getRes.json() as Record<string, unknown>;
  if ("code" in data) {
    const code = (data as { code: string; message: string }).code;
    if (code === "ENTRY_ID_NOT_FOUND") {
      return NextResponse.json({ error: "Entry not found on Kaltura" }, { status: 404 });
    }
    return NextResponse.json({ error: `Kaltura error: ${code}` }, { status: 502 });
  }

  const rawStatus = String((data as { status?: string | number }).status ?? "");
  const friendly = STATUS_MAP[rawStatus] ?? rawStatus;

  return NextResponse.json({
    status: friendly,
    rawStatus,
    mediaType: (data as { mediaType?: number }).mediaType,
    accessControlId: (data as { accessControlId?: number }).accessControlId,
    plays: (data as { plays?: number }).plays,
    views: (data as { views?: number }).views,
  });
}

export const GET = withRequestLogging("api:kaltura/status", handler);
