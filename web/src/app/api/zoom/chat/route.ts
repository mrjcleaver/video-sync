/**
 * POST /api/zoom/chat
 * Fetches the in-meeting chat for a Zoom recording, normalises to markdown,
 * and returns it as a single text body (the caller is responsible for
 * writing it as an artifact via PUT /api/artifacts/:id/chat).
 *
 * Privacy (ADR-039): private chat lines (host-visible "(privately)" entries)
 * are stripped by default. Set INCLUDE_PRIVATE_CHATS=1 to retain them.
 *
 * Body: { accountId, clientId, clientSecret, meetingUuid }
 *
 * Response: { content: string, participants: string[], private_chats_stripped: boolean, lines: number }
 *   404 if no CHAT file is available for this recording (Zoom doesn't always
 *        produce one — recordings without in-meeting chat have no CHAT entry).
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";

interface RawChatLine {
  raw: string;
  isPrivate: boolean;
  sender?: string;
  recipient?: string;
  time?: string;
  message?: string;
}

const ZOOM_CHAT_LINE = /^(\d{2}:\d{2}:\d{2})\s+From\s+(.+?)\s+to\s+(.+?)(\s+\(privately\))?\s*:\s*(.*)$/;

function parseChatLine(raw: string): RawChatLine {
  const m = raw.match(ZOOM_CHAT_LINE);
  if (!m) return { raw, isPrivate: false };
  return {
    raw,
    isPrivate: !!m[4],
    time: m[1],
    sender: m[2].trim(),
    recipient: m[3].trim(),
    message: m[5],
  };
}

function normaliseChat(raw: string, options: { stripPrivate: boolean }): {
  body: string;
  participants: string[];
  lineCount: number;
  privateStripped: number;
} {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  const participants = new Set<string>();
  let privateStripped = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseChatLine(line);
    if (parsed.isPrivate && options.stripPrivate) {
      privateStripped++;
      continue;
    }
    if (parsed.sender) participants.add(parsed.sender);
    if (parsed.recipient && parsed.recipient !== "Everyone") participants.add(parsed.recipient);
    if (parsed.time && parsed.sender) {
      const recipientFmt = parsed.recipient && parsed.recipient !== "Everyone"
        ? `→ ${parsed.recipient}${parsed.isPrivate ? " (privately)" : ""}`
        : "→ Everyone";
      out.push(`- **[${parsed.time}] ${parsed.sender}** ${recipientFmt}: ${parsed.message ?? ""}`);
    } else {
      // Unparseable line — preserve verbatim
      out.push(`- ${line}`);
    }
  }

  return {
    body: out.join("\n"),
    participants: Array.from(participants).sort(),
    lineCount: out.length,
    privateStripped,
  };
}

async function handler(req: NextRequest) {
  let body: {
    accountId?: string;
    clientId?: string;
    clientSecret?: string;
    meetingUuid?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rid = req.headers.get("x-request-id") ?? "n/a";
  const accountId = body.accountId || process.env.ZOOM_ACCOUNT_ID;
  const clientId = body.clientId || process.env.ZOOM_CLIENT_ID;
  const clientSecret = body.clientSecret || process.env.ZOOM_CLIENT_SECRET;
  const { meetingUuid } = body;
  if (!accountId || !clientId || !clientSecret || !meetingUuid) {
    return NextResponse.json(
      { error: "accountId, clientId, clientSecret, and meetingUuid are required" },
      { status: 400 },
    );
  }

  // ── auth ───────────────────────────────────────────────
  const tokenUrl = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  let accessToken: string;
  try {
    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return NextResponse.json({ error: `Zoom token error (${tokenRes.status}): ${text}` }, { status: 502 });
    }
    const tokenData = await tokenRes.json();
    accessToken = tokenData.access_token;
  } catch (err) {
    return NextResponse.json({ error: `Zoom auth failed: ${String(err)}` }, { status: 502 });
  }

  // ── find CHAT file ─────────────────────────────────────
  const encodedUuid = meetingUuid.includes("/")
    ? encodeURIComponent(encodeURIComponent(meetingUuid))
    : encodeURIComponent(meetingUuid);

  let chatUrl: string;
  try {
    const recRes = await fetch(
      `https://api.zoom.us/v2/meetings/${encodedUuid}/recordings`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!recRes.ok) {
      const text = await recRes.text();
      return NextResponse.json({ error: `Zoom recordings API error (${recRes.status}): ${text}` }, { status: 502 });
    }
    const recData = await recRes.json();
    const files: Array<{ file_type: string; download_url?: string; status?: string }> = recData.recording_files ?? [];
    const chatFile = files.find(
      (f) => f.file_type === "CHAT" && f.status === "completed" && f.download_url,
    );
    if (!chatFile?.download_url) {
      return NextResponse.json({ error: "no chat file" }, { status: 404 });
    }
    chatUrl = chatFile.download_url;
  } catch (err) {
    return NextResponse.json({ error: `Failed to list recording files: ${String(err)}` }, { status: 502 });
  }

  // ── download and normalise ─────────────────────────────
  let raw: string;
  try {
    const chatRes = await fetch(`${chatUrl}?access_token=${accessToken}`);
    if (!chatRes.ok) {
      return NextResponse.json({ error: `Chat download failed (${chatRes.status})` }, { status: 502 });
    }
    raw = await chatRes.text();
  } catch (err) {
    return NextResponse.json({ error: `Chat fetch error: ${String(err)}` }, { status: 502 });
  }

  const includePrivate = process.env.INCLUDE_PRIVATE_CHATS === "1";
  const norm = normaliseChat(raw, { stripPrivate: !includePrivate });

  serverLog("info", "ext:zoom-chat", "fetched", {
    lines: norm.lineCount,
    private_stripped: norm.privateStripped,
    participants: norm.participants.length,
    rid,
  });

  return NextResponse.json({
    content: norm.body,
    participants: norm.participants,
    private_chats_stripped: !includePrivate,
    private_chats_stripped_count: norm.privateStripped,
    lines: norm.lineCount,
  });
}

export const POST = withRequestLogging("api:zoom/chat", handler);
