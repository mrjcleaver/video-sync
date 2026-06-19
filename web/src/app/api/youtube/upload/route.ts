import { NextRequest, NextResponse } from "next/server";
import { serverLog } from "../../../../lib/serverLogger";
import { getSharedCredential } from "../../../../lib/sharedCredentials";
import { execFile } from "child_process";
import { createWriteStream, createReadStream } from "fs";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

interface UploadRequest {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  title: string;
  description?: string;
  tags?: string[];
  downloadUrl: string;
  privacyStatus?: "private" | "unlisted" | "public";
  recordedAt?: string;
  trimStartSeconds?: number;
  // Zoom credentials (needed when downloadUrl is zoom://recording/...)
  zoomAccountId?: string;
  zoomClientId?: string;
  zoomClientSecret?: string;
  // Fireflies credentials (needed when downloadUrl is fireflies://...)
  firefliesApiKey?: string;
  // Kaltura credentials (needed when downloadUrl is kaltura://entry/...).
  // Usually resolved server-side from Secret Manager; body fields are an
  // optional operator override.
  kalturaPartnerId?: string;
  kalturaAdminSecret?: string;
  // YouTube cookies in Netscape format (needed to bypass bot detection)
  ytCookies?: string;
}

async function getZoomAccessToken(accountId: string, clientId: string, clientSecret: string): Promise<string> {
  const tokenUrl = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zoom token error (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

/** Stream a fetch response body to a file on disk. */
async function streamToFile(response: Response, filePath: string): Promise<void> {
  if (!response.body) throw new Error("Response has no body");
  const webStream = response.body as ReadableStream<Uint8Array>;
  const nodeStream = Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(nodeStream, createWriteStream(filePath));
}

async function downloadZoomToFile(
  meetingUuid: string,
  accountId: string,
  clientId: string,
  clientSecret: string,
  outPath: string,
): Promise<void> {
  const zoomToken = await getZoomAccessToken(accountId, clientId, clientSecret);

  // Zoom UUIDs containing / or // must be double-URL-encoded
  const encodedUuid = meetingUuid.includes("/")
    ? encodeURIComponent(encodeURIComponent(meetingUuid))
    : encodeURIComponent(meetingUuid);

  // Get recording files for this meeting instance
  const recRes = await fetch(
    `https://api.zoom.us/v2/meetings/${encodedUuid}/recordings`,
    { headers: { Authorization: `Bearer ${zoomToken}` } },
  );

  if (!recRes.ok) {
    const text = await recRes.text();
    throw new Error(`Zoom recordings API error (${recRes.status}): ${text}`);
  }

  const recData = await recRes.json();
  const files = recData.recording_files ?? [];

  // Find the MP4 file
  const mp4 = files.find(
    (f: { file_type: string; status: string }) =>
      f.file_type === "MP4" && f.status === "completed",
  );

  if (!mp4?.download_url) {
    throw new Error("No completed MP4 recording file found for this meeting");
  }

  // Stream the video file to disk (Zoom requires access_token query param)
  const videoUrl = `${mp4.download_url}?access_token=${zoomToken}`;
  const dlRes = await fetch(videoUrl);

  if (!dlRes.ok) {
    throw new Error(`Zoom video download failed (${dlRes.status})`);
  }

  await streamToFile(dlRes, outPath);
}

function extractLoomVideoId(url: string): string | null {
  const match = url.match(/loom\.com\/(?:share|v)\/([a-f0-9]+)/i);
  return match ? match[1] : null;
}

async function downloadLoomToFile(videoId: string, outPath: string): Promise<void> {
  // yt-dlp handles Loom's Apollo-state extraction, MP4 vs HLS fallback,
  // and CloudFront-signed chunk downloads. The previous inline scraper
  // shelled out to ffmpeg for HLS, which silently failed on long videos
  // (empty stderr at -loglevel error masked the actual cause). yt-dlp is
  // already in the runtime image (Dockerfile installs ffmpeg + yt-dlp)
  // and is the canonical path used by lib/sourceDownload.ts.
  const url = `https://www.loom.com/share/${videoId}`;
  await new Promise<void>((resolve, reject) => {
    execFile(
      "yt-dlp",
      ["--output", outPath, "--no-playlist", "--no-warnings", "--newline", url],
      { timeout: 3600000, maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          if (err.message.includes("ENOENT")) {
            reject(new Error("yt-dlp is not installed."));
          } else {
            const detail = (stderr || "").trim() || err.message;
            reject(new Error(`Loom download failed: ${detail.slice(0, 1500)}`));
          }
        } else {
          resolve();
        }
      },
    );
  });
}

async function downloadYouTubeToFile(videoId: string, outPath: string, cookies?: string): Promise<void> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // Write cookies to a temp file if provided
  let cookiesPath: string | null = null;
  if (cookies?.trim()) {
    cookiesPath = join(tmpdir(), `yt-cookies-${Date.now()}.txt`);
    await fs.writeFile(cookiesPath, cookies, "utf8");
  }

  const args = [
    "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "--output", outPath,
    "--no-playlist",
    "--quiet",
    "--no-warnings",
  ];
  if (cookiesPath) args.push("--cookies", cookiesPath);
  args.push(url);

  try {
    await new Promise<void>((resolve, reject) => {
      execFile("yt-dlp", args, { timeout: 3600000 }, (err, _stdout, stderr) => {
        if (err) {
          if (err.message.includes("ENOENT")) {
            reject(new Error("yt-dlp is not installed. It must be present in the container (ADR-027)."));
          } else {
            const detail = (stderr || "").trim() || err.message;
            reject(new Error(`yt-dlp failed: ${detail.slice(0, 500)}`));
          }
        } else {
          resolve();
        }
      });
    });
  } finally {
    if (cookiesPath) fs.unlink(cookiesPath).catch(() => {});
  }
}

async function downloadYouTubeToFile(videoId: string, outPath: string, cookies?: string): Promise<void> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // Write cookies to a temp file if provided
  let cookiesPath: string | null = null;
  if (cookies?.trim()) {
    cookiesPath = join(tmpdir(), `yt-cookies-${Date.now()}.txt`);
    await fs.writeFile(cookiesPath, cookies, "utf8");
  }

  const args = [
    "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "--output", outPath,
    "--no-playlist",
    "--quiet",
    "--no-warnings",
  ];
  if (cookiesPath) args.push("--cookies", cookiesPath);
  args.push(url);

  try {
    await new Promise<void>((resolve, reject) => {
      execFile("yt-dlp", args, { timeout: 3600000 }, (err, _stdout, stderr) => {
        if (err) {
          if (err.message.includes("ENOENT")) {
            reject(new Error("yt-dlp is not installed. It must be present in the container (ADR-027)."));
          } else {
            const detail = (stderr || "").trim() || err.message;
            reject(new Error(`yt-dlp failed: ${detail.slice(0, 500)}`));
          }
        } else {
          resolve();
        }
      });
    });
  } finally {
    if (cookiesPath) fs.unlink(cookiesPath).catch(() => {});
  }
}

async function downloadFirefliesToFile(
  transcriptId: string,
  apiKey: string,
  outPath: string,
): Promise<void> {
  // Re-query Fireflies GraphQL to get a fresh, non-expired video URL.
  const query = `
    query GetTranscript($id: String!) {
      transcript(id: $id) {
        video_url
        audio_url
      }
    }
  `;
  const res = await fetch("https://api.fireflies.ai/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { id: transcriptId } }),
  });

  if (!res.ok) {
    throw new Error(`Fireflies API error (${res.status})`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Fireflies GraphQL error: ${json.errors[0]?.message}`);
  }

  const t = json.data?.transcript;
  const videoUrl: string | null = t?.video_url || t?.audio_url || null;
  if (!videoUrl) {
    throw new Error("Fireflies returned no video or audio URL for this transcript. The recording may not be available.");
  }

  const dlRes = await fetch(videoUrl);
  if (!dlRes.ok) {
    throw new Error(`Fireflies video download failed (${dlRes.status})`);
  }
  await streamToFile(dlRes, outPath);
}

async function downloadKalturaToFile(
  entryId: string,
  partnerId: string,
  adminSecret: string,
  outPath: string,
): Promise<void> {
  // 1. Mint an admin Kaltura Session (KS) so the download URL is authorized.
  const sessForm = new URLSearchParams();
  sessForm.set("format", "1"); // JSON
  sessForm.set("partnerId", partnerId);
  sessForm.set("secret", adminSecret);
  sessForm.set("type", "2"); // ADMIN
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
  if (!ks || ks.length < 10) throw new Error(`Kaltura session.start returned no usable KS: ${JSON.stringify(sessJson).slice(0, 120)}`);

  // 2. playManifest "format/download" serves the source/highest flavor as a
  //    direct file. The KS authorizes access to the entry.
  const downloadUrl = `https://cdnapisec.kaltura.com/p/${partnerId}/sp/${partnerId}00/playManifest/entryId/${entryId}/format/download/protocol/https/ks/${ks}`;
  const dlRes = await fetch(downloadUrl, { redirect: "follow" });
  if (!dlRes.ok) throw new Error(`Kaltura download failed (${dlRes.status}) for entry ${entryId}`);
  // Guard against Kaltura returning an HTML error page instead of media.
  const ctype = dlRes.headers.get("content-type") ?? "";
  if (ctype.includes("text/html") || ctype.includes("application/xml")) {
    throw new Error(`Kaltura returned ${ctype} instead of media for entry ${entryId} — entry may not be downloadable or KS lacks permission`);
  }
  await streamToFile(dlRes, outPath);
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

function sseEvent(type: string, data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── Main upload handler (SSE streaming) ──────────────────────────────────────
// Returns a text/event-stream response so the full upload lifecycle runs in a
// single HTTP connection — no cross-instance job-store lookup, no polling.
// Events: progress { phase }, complete { videoId, videoUrl }, error { message }

async function handler(req: NextRequest) {
  let body: UploadRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const refreshToken = body.refreshToken || process.env.YOUTUBE_REFRESH_TOKEN;
  const clientId = body.clientId || process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = body.clientSecret || process.env.YOUTUBE_CLIENT_SECRET;

  // Source credentials. The client only forwards local overrides; per
  // ADR-042 Zoom/Fireflies/Kaltura live shared in Secret Manager. Resolve
  // the shared copy for whichever scheme this download uses so a
  // cross-platform re-publish (e.g. Kaltura entry → YouTube) works without
  // the operator pasting platform creds locally.
  const dl = body.downloadUrl ?? "";
  let zoomAccountId = body.zoomAccountId || process.env.ZOOM_ACCOUNT_ID;
  let zoomClientId = body.zoomClientId || process.env.ZOOM_CLIENT_ID;
  let zoomClientSecret = body.zoomClientSecret || process.env.ZOOM_CLIENT_SECRET;
  let firefliesApiKey = body.firefliesApiKey || process.env.FIREFLIES_API_KEY;
  let kalturaPartnerId = body.kalturaPartnerId || process.env.KALTURA_PARTNER_ID;
  let kalturaAdminSecret = body.kalturaAdminSecret || process.env.KALTURA_ADMIN_SECRET;

  if (dl.startsWith("zoom://") && (!zoomAccountId || !zoomClientId || !zoomClientSecret)) {
    const s = (await getSharedCredential("zoom")) as { accountId?: string; clientId?: string; clientSecret?: string } | null;
    if (s) { zoomAccountId ||= s.accountId; zoomClientId ||= s.clientId; zoomClientSecret ||= s.clientSecret; }
  }
  if (dl.startsWith("fireflies://") && !firefliesApiKey) {
    const s = (await getSharedCredential("fireflies")) as { apiKey?: string } | null;
    if (s?.apiKey) firefliesApiKey = s.apiKey;
  }
  if (dl.startsWith("kaltura://") && (!kalturaPartnerId || !kalturaAdminSecret)) {
    const s = (await getSharedCredential("kaltura")) as { partnerId?: string; adminSecret?: string; apiKey?: string } | null;
    if (s) { kalturaPartnerId ||= s.partnerId; kalturaAdminSecret ||= s.adminSecret || s.apiKey; }
  }

  if (!refreshToken || !clientId || !clientSecret || !body.title || !body.downloadUrl) {
    return NextResponse.json(
      { error: "refreshToken, clientId, clientSecret, title, and downloadUrl are required" },
      { status: 400 },
    );
  }

  const { title, description = "", tags = [], downloadUrl, privacyStatus = "unlisted", recordedAt } = body;

  const stream = new ReadableStream({
    async start(controller) {
      let tmpPath: string | null = null;

      const send = (type: string, data: Record<string, unknown>) => {
        try { controller.enqueue(sseEvent(type, data)); } catch { /* client disconnected */ }
      };

      try {
        // Step 1: Refresh YouTube token
        send("progress", { phase: "Refreshing YouTube token…" });
        serverLog("info", "ext:youtube-upload", "token-refresh-start", { title });
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId!,
            client_secret: clientSecret!,
            refresh_token: refreshToken!,
            grant_type: "refresh_token",
          }),
        });
        if (!tokenRes.ok) {
          const text = await tokenRes.text();
          throw new Error(`YouTube token refresh failed (${tokenRes.status}): ${text}`);
        }
        const { access_token: ytAccessToken } = await tokenRes.json();
        serverLog("info", "ext:youtube-upload", "token-refresh-ok", { title });

        // Step 2: Download source to temp file
        tmpPath = join(tmpdir(), `video-upload-${Date.now()}.mp4`);
        send("progress", { phase: "Downloading source video…" });
        serverLog("info", "ext:youtube-upload", "download-start", { title, downloadUrl });

        if (downloadUrl.startsWith("youtube://")) {
          await downloadYouTubeToFile(downloadUrl.replace("youtube://", ""), tmpPath, body.ytCookies);
        } else if (downloadUrl.startsWith("zoom://recording/")) {
          if (!zoomAccountId || !zoomClientId || !zoomClientSecret) throw new Error("Zoom credentials required");
          await downloadZoomToFile(downloadUrl.replace("zoom://recording/", ""), zoomAccountId, zoomClientId, zoomClientSecret, tmpPath);
        } else if (downloadUrl.startsWith("fireflies://")) {
          if (!firefliesApiKey) throw new Error("Fireflies API key required");
          await downloadFirefliesToFile(downloadUrl.replace("fireflies://", ""), firefliesApiKey, tmpPath);
        } else if (downloadUrl.startsWith("kaltura://entry/")) {
          if (!kalturaPartnerId || !kalturaAdminSecret) throw new Error("Kaltura credentials required (shared credential not configured)");
          await downloadKalturaToFile(downloadUrl.replace("kaltura://entry/", ""), kalturaPartnerId, kalturaAdminSecret, tmpPath);
        } else {
          const loomId = extractLoomVideoId(downloadUrl);
          if (loomId) {
            await downloadLoomToFile(loomId, tmpPath);
          } else {
            const dlRes = await fetch(downloadUrl);
            if (!dlRes.ok) throw new Error(`Source download failed (${dlRes.status})`);
            await streamToFile(dlRes, tmpPath);
          }
        }
        serverLog("info", "ext:youtube-upload", "download-ok", { title });

        // Step 2b: Trim if requested
        if (body.trimStartSeconds && body.trimStartSeconds > 0) {
          send("progress", { phase: `Trimming first ${body.trimStartSeconds}s…` });
          serverLog("info", "ext:youtube-upload", "trim-start", { title, trimStartSeconds: body.trimStartSeconds });
          const trimmedPath = join(tmpdir(), `video-trimmed-${Date.now()}.mp4`);
          await new Promise<void>((resolve, reject) => {
            execFile(
              "ffmpeg",
              ["-ss", String(body.trimStartSeconds), "-i", tmpPath!, "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", "-y", trimmedPath],
              { timeout: 300000 },
              (err, _stdout, stderr) => {
                if (err) reject(new Error(`ffmpeg trim failed: ${(stderr || err.message).slice(0, 300)}`));
                else resolve();
              },
            );
          });
          fs.unlink(tmpPath).catch(() => {});
          tmpPath = trimmedPath;
          serverLog("info", "ext:youtube-upload", "trim-ok", { title });
        }

        // Step 3: Initiate resumable upload
        send("progress", { phase: "Initiating YouTube upload…" });
        serverLog("info", "ext:youtube-upload", "upload-init-start", { title });
        const videoSize = (await fs.stat(tmpPath)).size;
        const metadata: Record<string, unknown> = {
          snippet: { title, description, tags },
          status: { privacyStatus, selfDeclaredMadeForKids: false },
        };
        const parts = ["snippet", "status"];
        if (recordedAt) { metadata.recordingDetails = { recordingDate: recordedAt }; parts.push("recordingDetails"); }

        const initRes = await fetch(
          `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=${parts.join(",")}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${ytAccessToken}`,
              "Content-Type": "application/json",
              "X-Upload-Content-Length": videoSize.toString(),
              "X-Upload-Content-Type": "video/mp4",
            },
            body: JSON.stringify(metadata),
          },
        );
        if (!initRes.ok) {
          const text = await initRes.text();
          throw new Error(`YouTube upload init failed (${initRes.status}): ${text}`);
        }
        const uploadUrl = initRes.headers.get("Location");
        if (!uploadUrl) throw new Error("YouTube did not return an upload URL");
        serverLog("info", "ext:youtube-upload", "upload-init-ok", { title, videoSize });

        // Step 4: Stream video to YouTube
        send("progress", { phase: "Uploading to YouTube…" });
        serverLog("info", "ext:youtube-upload", "upload-stream-start", { title, videoSize });
        const fileStream = createReadStream(tmpPath);
        const nodeReadable = Readable.toWeb(fileStream) as ReadableStream;
        const uploadRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "video/mp4", "Content-Length": videoSize.toString() },
          body: nodeReadable,
          // @ts-expect-error duplex required for streaming body in Node fetch
          duplex: "half",
        });
        if (!uploadRes.ok) {
          const text = await uploadRes.text();
          throw new Error(`YouTube upload failed (${uploadRes.status}): ${text}`);
        }

        const result = await uploadRes.json();
        const videoId = result.id as string;
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        serverLog("info", "ext:youtube-upload", "published", { title, videoId, videoUrl });
        send("complete", { videoId, videoUrl });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        serverLog("error", "ext:youtube-upload", "failed", { title, error: message });
        send("error", { message });
      } finally {
        if (tmpPath) fs.unlink(tmpPath).catch(() => {});
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

// Cloud Run: --timeout=3600 in cloudbuild.yaml.
export const maxDuration = 3600;

// withRequestLogging wraps in NextResponse which isn't compatible with the plain
// Response(stream) needed for SSE — log manually inside the handler instead.
export async function POST(req: NextRequest) {
  const rid = req.headers.get("x-request-id") ?? crypto.randomUUID().slice(0, 8);
  serverLog("info", "api:youtube/upload", "req", { method: "POST", path: new URL(req.url).pathname, rid });
  const res = await handler(req);
  const headers = new Headers(res.headers);
  headers.set("x-request-id", rid);
  return new Response(res.body, { status: res.status, headers });
}
