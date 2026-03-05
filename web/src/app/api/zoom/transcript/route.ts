/**
 * POST /api/zoom/transcript
 * Fetches the VTT transcript for a Zoom meeting and returns it as plain text.
 *
 * Body: { accountId, clientId, clientSecret, meetingUuid }
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";

/** Parse WebVTT to plain text, stripping timestamps and cue metadata. */
function vttToPlainText(vtt: string): string {
  return vtt
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (t === "WEBVTT") return false;
      // Timestamp lines: 00:00:01.000 --> 00:00:04.000
      if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+/.test(t)) return false;
      // Cue identifiers (numeric or NOTE lines)
      if (/^\d+$/.test(t)) return false;
      if (t.startsWith("NOTE")) return false;
      return true;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
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
  const { accountId, clientId, clientSecret, meetingUuid } = body;
  if (!accountId || !clientId || !clientSecret || !meetingUuid) {
    return NextResponse.json(
      { error: "accountId, clientId, clientSecret, and meetingUuid are required" },
      { status: 400 },
    );
  }

  // Get Zoom access token
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
      return NextResponse.json(
        { error: `Zoom token error (${tokenRes.status}): ${text}` },
        { status: 502 },
      );
    }
    const tokenData = await tokenRes.json();
    accessToken = tokenData.access_token;
  } catch (err) {
    return NextResponse.json(
      { error: `Zoom auth failed: ${String(err)}` },
      { status: 502 },
    );
  }

  // Fetch recording files for the meeting to find the TRANSCRIPT file
  const encodedUuid = meetingUuid.includes("/")
    ? encodeURIComponent(encodeURIComponent(meetingUuid))
    : encodeURIComponent(meetingUuid);

  let transcriptUrl: string;
  try {
    const recRes = await fetch(
      `https://api.zoom.us/v2/meetings/${encodedUuid}/recordings`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!recRes.ok) {
      const text = await recRes.text();
      return NextResponse.json(
        { error: `Zoom recordings API error (${recRes.status}): ${text}` },
        { status: 502 },
      );
    }
    const recData = await recRes.json();
    const files: Array<{ file_type: string; download_url?: string; status?: string }> =
      recData.recording_files ?? [];

    const transcriptFile = files.find(
      (f) => f.file_type === "TRANSCRIPT" && f.status === "completed" && f.download_url,
    );
    if (!transcriptFile?.download_url) {
      return NextResponse.json(
        { error: "No completed TRANSCRIPT file found for this recording. Zoom may not have generated one yet." },
        { status: 404 },
      );
    }
    transcriptUrl = transcriptFile.download_url;
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch recording files: ${String(err)}` },
      { status: 502 },
    );
  }

  // Download the VTT file (Zoom requires access_token as query param)
  try {
    const vttRes = await fetch(`${transcriptUrl}?access_token=${accessToken}`);
    if (!vttRes.ok) {
      return NextResponse.json(
        { error: `Transcript download failed (${vttRes.status})` },
        { status: 502 },
      );
    }
    const vtt = await vttRes.text();
    const plainText = vttToPlainText(vtt);

    if (!plainText) {
      return NextResponse.json(
        { error: "Transcript file was empty or contained no speakable text" },
        { status: 422 },
      );
    }

    serverLog("info", "ext:zoom-transcript", "fetched", { chars: plainText.length, rid });
    return NextResponse.json({ transcript: plainText, chars: plainText.length });
  } catch (err) {
    serverLog("error", "ext:zoom-transcript", "vtt download failed", { error: String(err), rid });
    return NextResponse.json(
      { error: `Transcript fetch error: ${String(err)}` },
      { status: 502 },
    );
  }
}

export const POST = withRequestLogging("api:zoom/transcript", handler);
