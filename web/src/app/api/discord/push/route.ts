import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";

/**
 * ADR-055 follow-up — push a message to a series-specific Discord
 * channel via the operator-configured webhook.
 *
 * The webhook URL lives on the SeriesRegistryEntry.discord_channel
 * field (set on the Config page). The client resolves it per record
 * by pattern-matching and passes it in the body — this route just
 * proxies a plain POST so the operator's browser doesn't have to
 * make cross-origin calls to discord.com.
 *
 * Body: { webhook_url, content?, embeds? }
 */
async function handler(req: NextRequest) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const { webhook_url, content, embeds, username } = body as {
    webhook_url?: string;
    content?: string;
    embeds?: unknown;
    username?: string;
  };

  if (!webhook_url || typeof webhook_url !== "string") {
    return NextResponse.json({ error: "webhook_url required" }, { status: 400 });
  }
  if (!/^https:\/\/(?:.*\.)?discord(?:app)?\.com\//i.test(webhook_url)) {
    return NextResponse.json({ error: "webhook_url must be a Discord webhook URL" }, { status: 400 });
  }
  if (!content && !embeds) {
    return NextResponse.json({ error: "content or embeds required" }, { status: 400 });
  }

  const payload: Record<string, unknown> = {};
  if (content) payload.content = String(content).slice(0, 2000);
  if (embeds) payload.embeds = embeds;
  if (username) payload.username = String(username).slice(0, 80);

  const res = await fetch(webhook_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    serverLog("error", "discord:push", "webhook-failed", { status: res.status, body: txt.slice(0, 400) });
    return NextResponse.json(
      { error: `Discord webhook failed (${res.status}): ${txt.slice(0, 200)}` },
      { status: res.status === 401 || res.status === 403 || res.status === 404 ? res.status : 502 },
    );
  }
  serverLog("info", "discord:push", "webhook-ok", { status: res.status });
  return NextResponse.json({ ok: true });
}

export const POST = withRequestLogging("api:discord/push", handler);
