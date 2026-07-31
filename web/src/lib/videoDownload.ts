/**
 * ADR-062 slice 2 — shared source-video download helpers.
 *
 * Extracted verbatim from /api/youtube/upload/route.ts so both
 * the YouTube upload flow AND the ADR-062 stitched-source
 * builder can reach source recordings on Zoom / YouTube /
 * Fireflies / Kaltura / Loom / bare-HTTPS with one code path.
 *
 * All fetchers download to a caller-supplied absolute file path
 * and throw on any failure. Consumers are expected to `fs.unlink`
 * the file when done (or use a scoped tmp directory).
 */

import { execFile } from "child_process";
import { createWriteStream } from "fs";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

async function getZoomAccessToken(accountId: string, clientId: string, clientSecret: string): Promise<string> {
  const tokenUrl = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error(`Zoom token error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

/** Stream a fetch response body to a file on disk. */
export async function streamToFile(response: Response, filePath: string): Promise<void> {
  if (!response.body) throw new Error("Response has no body");
  const webStream = response.body as ReadableStream<Uint8Array>;
  const nodeStream = Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(nodeStream, createWriteStream(filePath));
}

export async function downloadZoomToFile(
  meetingUuid: string,
  accountId: string,
  clientId: string,
  clientSecret: string,
  outPath: string,
): Promise<void> {
  const zoomToken = await getZoomAccessToken(accountId, clientId, clientSecret);
  const encodedUuid = meetingUuid.includes("/")
    ? encodeURIComponent(encodeURIComponent(meetingUuid))
    : encodeURIComponent(meetingUuid);
  const recRes = await fetch(
    `https://api.zoom.us/v2/meetings/${encodedUuid}/recordings`,
    { headers: { Authorization: `Bearer ${zoomToken}` } },
  );
  if (!recRes.ok) throw new Error(`Zoom recordings API error (${recRes.status}): ${await recRes.text()}`);
  const recData = await recRes.json();
  const files = recData.recording_files ?? [];
  const mp4 = files.find(
    (f: { file_type: string; status: string }) => f.file_type === "MP4" && f.status === "completed",
  );
  if (!mp4?.download_url) throw new Error("No completed MP4 recording file found for this meeting");
  const videoUrl = `${mp4.download_url}?access_token=${zoomToken}`;
  const dlRes = await fetch(videoUrl);
  if (!dlRes.ok) throw new Error(`Zoom video download failed (${dlRes.status})`);
  await streamToFile(dlRes, outPath);
}

export function extractLoomVideoId(url: string): string | null {
  const match = url.match(/loom\.com\/(?:share|v)\/([a-f0-9]+)/i);
  return match ? match[1] : null;
}

export async function downloadLoomToFile(videoId: string, outPath: string): Promise<void> {
  const url = `https://www.loom.com/share/${videoId}`;
  await new Promise<void>((resolve, reject) => {
    execFile(
      "yt-dlp",
      ["--output", outPath, "--no-playlist", "--no-warnings", "--newline", url],
      { timeout: 3600000, maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          if (err.message.includes("ENOENT")) reject(new Error("yt-dlp is not installed."));
          else {
            const detail = (stderr || "").trim() || err.message;
            reject(new Error(`Loom download failed: ${detail.slice(0, 1500)}`));
          }
        } else resolve();
      },
    );
  });
}

export async function downloadYouTubeToFile(videoId: string, outPath: string, cookies?: string): Promise<void> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  let cookiesPath: string | null = null;
  if (cookies?.trim()) {
    cookiesPath = join(tmpdir(), `yt-cookies-${Date.now()}.txt`);
    await fs.writeFile(cookiesPath, cookies, "utf8");
  }
  const args = [
    "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "--output", outPath,
    "--no-playlist", "--quiet", "--no-warnings",
  ];
  if (cookiesPath) args.push("--cookies", cookiesPath);
  args.push(url);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("yt-dlp", args, { timeout: 3600000 }, (err, _stdout, stderr) => {
        if (err) {
          if (err.message.includes("ENOENT")) reject(new Error("yt-dlp is not installed."));
          else {
            const detail = (stderr || "").trim() || err.message;
            reject(new Error(`yt-dlp failed: ${detail.slice(0, 500)}`));
          }
        } else resolve();
      });
    });
  } finally {
    if (cookiesPath) fs.unlink(cookiesPath).catch(() => {});
  }
}

export async function downloadFirefliesToFile(
  transcriptId: string, apiKey: string, outPath: string,
): Promise<void> {
  const query = `
    query GetTranscript($id: String!) {
      transcript(id: $id) { video_url audio_url }
    }
  `;
  const res = await fetch("https://api.fireflies.ai/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { id: transcriptId } }),
  });
  if (!res.ok) throw new Error(`Fireflies API error (${res.status})`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`Fireflies GraphQL error: ${json.errors[0]?.message}`);
  const t = json.data?.transcript;
  const videoUrl: string | null = t?.video_url || t?.audio_url || null;
  if (!videoUrl) throw new Error("Fireflies returned no video or audio URL for this transcript.");
  const dlRes = await fetch(videoUrl);
  if (!dlRes.ok) throw new Error(`Fireflies video download failed (${dlRes.status})`);
  await streamToFile(dlRes, outPath);
}

export async function downloadKalturaToFile(
  entryId: string, partnerId: string, adminSecret: string, outPath: string,
): Promise<void> {
  const sessForm = new URLSearchParams();
  sessForm.set("format", "1");
  sessForm.set("partnerId", partnerId);
  sessForm.set("secret", adminSecret);
  sessForm.set("type", "2");
  sessForm.set("userId", "video-sync");
  sessForm.set("expiry", "3600");
  const sessRes = await fetch("https://www.kaltura.com/api_v3/?service=session&action=start", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: sessForm,
  });
  if (!sessRes.ok) throw new Error(`Kaltura session.start HTTP ${sessRes.status}`);
  const sessJson = await sessRes.json();
  const ks: string = typeof sessJson === "string" ? sessJson : (sessJson?.result ?? "");
  if (!ks || ks.length < 10) throw new Error(`Kaltura session.start returned no usable KS`);
  const downloadUrl = `https://cdnapisec.kaltura.com/p/${partnerId}/sp/${partnerId}00/playManifest/entryId/${entryId}/format/download/protocol/https/ks/${ks}`;
  const dlRes = await fetch(downloadUrl, { redirect: "follow" });
  if (!dlRes.ok) throw new Error(`Kaltura download failed (${dlRes.status})`);
  const ctype = dlRes.headers.get("content-type") ?? "";
  if (ctype.includes("text/html") || ctype.includes("application/xml")) {
    throw new Error(`Kaltura returned ${ctype} instead of media`);
  }
  await streamToFile(dlRes, outPath);
}

/**
 * ADR-062 — dispatch to the right downloader given the record's
 * `download_url` scheme + optional per-platform credentials.
 * Same routing that /api/youtube/upload uses; centralised here.
 */
export async function downloadSourceToFile(
  downloadUrl: string,
  outPath: string,
  creds: {
    zoom?: { accountId: string; clientId: string; clientSecret: string };
    fireflies?: { apiKey: string };
    kaltura?: { partnerId: string; adminSecret: string };
    youtubeCookies?: string;
  } = {},
): Promise<void> {
  if (downloadUrl.startsWith("youtube://")) {
    await downloadYouTubeToFile(downloadUrl.replace("youtube://", ""), outPath, creds.youtubeCookies);
    return;
  }
  if (downloadUrl.startsWith("zoom://recording/")) {
    if (!creds.zoom) throw new Error("Zoom credentials required for zoom:// source");
    await downloadZoomToFile(downloadUrl.replace("zoom://recording/", ""), creds.zoom.accountId, creds.zoom.clientId, creds.zoom.clientSecret, outPath);
    return;
  }
  if (downloadUrl.startsWith("fireflies://")) {
    if (!creds.fireflies) throw new Error("Fireflies API key required for fireflies:// source");
    await downloadFirefliesToFile(downloadUrl.replace("fireflies://", ""), creds.fireflies.apiKey, outPath);
    return;
  }
  if (downloadUrl.startsWith("kaltura://entry/")) {
    if (!creds.kaltura) throw new Error("Kaltura credentials required for kaltura:// source");
    await downloadKalturaToFile(downloadUrl.replace("kaltura://entry/", ""), creds.kaltura.partnerId, creds.kaltura.adminSecret, outPath);
    return;
  }
  const loomId = extractLoomVideoId(downloadUrl);
  if (loomId) {
    await downloadLoomToFile(loomId, outPath);
    return;
  }
  const dlRes = await fetch(downloadUrl);
  if (!dlRes.ok) throw new Error(`Source download failed (${dlRes.status})`);
  await streamToFile(dlRes, outPath);
}
