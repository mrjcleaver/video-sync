import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getSharedCredential } from "../../../../lib/sharedCredentials";

async function handler(req: NextRequest) {
  let body: { accountId?: string; clientId?: string; clientSecret?: string; from?: string; to?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ADR-042 resolution: operator override (body) → shared secret → env-var legacy.
  const shared = (await getSharedCredential("zoom")) ?? {};
  const accountId = (body.accountId || (shared as { accountId?: string }).accountId) || process.env.ZOOM_ACCOUNT_ID;
  const clientId = (body.clientId || (shared as { clientId?: string }).clientId) || process.env.ZOOM_CLIENT_ID;
  const clientSecret = (body.clientSecret || (shared as { clientSecret?: string }).clientSecret) || process.env.ZOOM_CLIENT_SECRET;
  if (!accountId || !clientId || !clientSecret) {
    return NextResponse.json(
      { error: "accountId, clientId, and clientSecret are required" },
      { status: 400 },
    );
  }

  // Exchange credentials for access token (Server-to-Server OAuth)
  const rid = req.headers.get("x-request-id") ?? "n/a";
  const tokenUrl = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  let accessToken: string;
  try {
    const t0 = Date.now();
    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    serverLog("info", "ext:zoom-token", "fetch", { duration_ms: Date.now() - t0, status: tokenRes.status, rid });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      serverLog("error", "ext:zoom-token", "auth failed", { status: tokenRes.status, rid });
      return NextResponse.json(
        { error: `Zoom token error (${tokenRes.status}): ${text}` },
        { status: 502 },
      );
    }
    const tokenData = await tokenRes.json();
    accessToken = tokenData.access_token;
  } catch (err) {
    serverLog("error", "ext:zoom-token", "unreachable", { error: String(err), rid });
    return NextResponse.json(
      { error: `Failed to reach Zoom auth: ${String(err)}` },
      { status: 502 },
    );
  }

  // Fetch recordings — use caller-provided dates or fall back to last 30 days
  // Zoom API limits: max 30 days per request, so paginate across date windows
  const toDate = body.to || new Date().toISOString().slice(0, 10);
  const fromDate = body.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  try {
    const allMeetings: unknown[] = [];
    const MS_PER_DAY = 86400000;
    const MAX_SPAN_DAYS = 30;
    let windowFrom = new Date(fromDate);
    const finalTo = new Date(toDate);

    // Walk through the date range in 30-day windows
    while (windowFrom <= finalTo) {
      const windowTo = new Date(Math.min(
        windowFrom.getTime() + MAX_SPAN_DAYS * MS_PER_DAY,
        finalTo.getTime(),
      ));
      const wFrom = windowFrom.toISOString().slice(0, 10);
      const wTo = windowTo.toISOString().slice(0, 10);

      // Paginate within each window
      let nextPageToken = "";
      do {
        const params = new URLSearchParams({
          from: wFrom,
          to: wTo,
          page_size: "300",
        });
        if (nextPageToken) params.set("next_page_token", nextPageToken);

        const recRes = await fetch(
          `https://api.zoom.us/v2/users/me/recordings?${params}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (!recRes.ok) {
          const text = await recRes.text();
          return NextResponse.json(
            { error: `Zoom API error (${recRes.status}): ${text}` },
            { status: 502 },
          );
        }
        const data = await recRes.json();
        allMeetings.push(...(data.meetings ?? []));
        nextPageToken = data.next_page_token || "";
      } while (nextPageToken);

      // Move to next window (day after current windowTo)
      windowFrom = new Date(windowTo.getTime() + MS_PER_DAY);
    }

    serverLog("info", "ext:zoom-recordings", "done", { count: allMeetings.length, rid });
    return NextResponse.json({
      meetings: allMeetings,
      total: allMeetings.length,
    });
  } catch (err) {
    serverLog("error", "ext:zoom-recordings", "failed", { error: String(err), rid });
    return NextResponse.json(
      { error: `Failed to fetch recordings: ${String(err)}` },
      { status: 502 },
    );
  }
}

export const POST = withRequestLogging("api:zoom/recordings", handler);
