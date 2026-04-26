/**
 * Server-side helpers for downloading source media to a temp file.
 * Shared between /api/youtube/upload and /api/kaltura/upload (ADR-037).
 *
 * Server-only: do not import from client components.
 */

import { execFile } from "child_process";
import { createWriteStream, promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface SourceCreds {
  zoomAccountId?: string;
  zoomClientId?: string;
  zoomClientSecret?: string;
  firefliesApiKey?: string;
  ytCookies?: string;
}

/** Stream a fetch response body to a file on disk. */
async function streamToFile(response: Response, filePath: string): Promise<void> {
  if (!response.body) throw new Error("Response has no body");
  const webStream = response.body as ReadableStream<Uint8Array>;
  const nodeStream = Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(nodeStream, createWriteStream(filePath));
}

async function getZoomAccessToken(accountId: string, clientId: string, clientSecret: string): Promise<string> {
  const tokenUrl = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error(`Zoom token error (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

async function downloadZoomToFile(meetingUuid: string, creds: SourceCreds, outPath: string): Promise<void> {
  if (!creds.zoomAccountId || !creds.zoomClientId || !creds.zoomClientSecret) {
    throw new Error("Zoom credentials required for zoom:// download");
  }
  const zoomToken = await getZoomAccessToken(creds.zoomAccountId, creds.zoomClientId, creds.zoomClientSecret);
  const encodedUuid = meetingUuid.includes("/") ? encodeURIComponent(encodeURIComponent(meetingUuid)) : encodeURIComponent(meetingUuid);
  const recRes = await fetch(`https://api.zoom.us/v2/meetings/${encodedUuid}/recordings`, {
    headers: { Authorization: `Bearer ${zoomToken}` },
  });
  if (!recRes.ok) throw new Error(`Zoom recordings API error (${recRes.status}): ${await recRes.text()}`);
  const recData = await recRes.json();
  const mp4 = (recData.recording_files ?? []).find(
    (f: { file_type: string; status: string }) => f.file_type === "MP4" && f.status === "completed",
  );
  if (!mp4?.download_url) throw new Error("No completed MP4 recording file found for this meeting");
  const dlRes = await fetch(`${mp4.download_url}?access_token=${zoomToken}`);
  if (!dlRes.ok) throw new Error(`Zoom video download failed (${dlRes.status})`);
  await streamToFile(dlRes, outPath);
}

async function downloadFirefliesToFile(transcriptId: string, apiKey: string, outPath: string): Promise<void> {
  const query = `query GetTranscript($id: String!) { transcript(id: $id) { video_url audio_url } }`;
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
  if (!videoUrl) throw new Error("Fireflies returned no video/audio URL for this transcript.");
  const dlRes = await fetch(videoUrl);
  if (!dlRes.ok) throw new Error(`Fireflies video download failed (${dlRes.status})`);
  await streamToFile(dlRes, outPath);
}

function extractLoomVideoId(url: string): string | null {
  const m = url.match(/loom\.com\/(?:share|v)\/([a-f0-9]+)/i);
  return m ? m[1] : null;
}

async function downloadLoomToFile(videoId: string, outPath: string): Promise<void> {
  // Use yt-dlp for Loom — it handles Apollo state extraction reliably.
  const url = `https://www.loom.com/share/${videoId}`;
  await new Promise<void>((resolve, reject) => {
    execFile("yt-dlp", ["--output", outPath, "--no-playlist", "--quiet", "--no-warnings", url], { timeout: 3600000 }, (err, _o, stderr) => {
      if (err) {
        if (err.message.includes("ENOENT")) reject(new Error("yt-dlp not installed."));
        else reject(new Error(`Loom download failed: ${(stderr || err.message).slice(0, 500)}`));
      } else resolve();
    });
  });
}

async function downloadYouTubeToFile(videoId: string, outPath: string, cookies?: string): Promise<void> {
  let cookiesPath: string | null = null;
  if (cookies?.trim()) {
    cookiesPath = join(tmpdir(), `yt-cookies-${Date.now()}.txt`);
    await fs.writeFile(cookiesPath, cookies, "utf8");
  }
  const args = [
    "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "--output", outPath, "--no-playlist", "--quiet", "--no-warnings",
  ];
  if (cookiesPath) args.push("--cookies", cookiesPath);
  args.push(`https://www.youtube.com/watch?v=${videoId}`);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("yt-dlp", args, { timeout: 3600000 }, (err, _o, stderr) => {
        if (err) {
          if (err.message.includes("ENOENT")) reject(new Error("yt-dlp not installed."));
          else reject(new Error(`yt-dlp failed: ${(stderr || err.message).slice(0, 500)}`));
        } else resolve();
      });
    });
  } finally {
    if (cookiesPath) fs.unlink(cookiesPath).catch(() => {});
  }
  void BROWSER_UA;
}

/**
 * Dispatch by URL scheme. Writes the source media to outPath. Throws with a
 * useful message if creds or scheme don't match.
 */
export async function downloadFromSource(downloadUrl: string, creds: SourceCreds, outPath: string): Promise<void> {
  if (downloadUrl.startsWith("zoom://recording/")) {
    return downloadZoomToFile(downloadUrl.slice("zoom://recording/".length), creds, outPath);
  }
  if (downloadUrl.startsWith("fireflies://")) {
    if (!creds.firefliesApiKey) throw new Error("Fireflies API key required for fireflies:// download");
    return downloadFirefliesToFile(downloadUrl.slice("fireflies://".length), creds.firefliesApiKey, outPath);
  }
  if (downloadUrl.startsWith("youtube://")) {
    return downloadYouTubeToFile(downloadUrl.slice("youtube://".length), outPath, creds.ytCookies);
  }
  const loomId = extractLoomVideoId(downloadUrl);
  if (loomId) {
    return downloadLoomToFile(loomId, outPath);
  }
  if (downloadUrl.startsWith("http://") || downloadUrl.startsWith("https://")) {
    const dlRes = await fetch(downloadUrl);
    if (!dlRes.ok) throw new Error(`Source download failed (${dlRes.status})`);
    return streamToFile(dlRes, outPath);
  }
  throw new Error(`Unsupported source URL scheme: ${downloadUrl.slice(0, 40)}`);
}
