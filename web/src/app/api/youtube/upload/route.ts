import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
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

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function downloadLoomToFile(videoId: string, outPath: string): Promise<void> {
  // Scrape the Loom share page to extract video URL (same approach as loom-dl)
  const shareUrl = `https://www.loom.com/share/${videoId}`;
  const pageRes = await fetch(shareUrl, {
    headers: {
      "User-Agent": BROWSER_UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!pageRes.ok) {
    throw new Error(`Loom page fetch failed (${pageRes.status}). Is the share link correct and public?`);
  }

  const html = await pageRes.text();

  // Extract Apollo state containing video URLs
  const apolloMatch = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]+?\});?\s*<\/script>/);

  let hlsUrl: string | null = null;
  let hlsCreds: { policy: string; signature: string; keyPairId: string } | null = null;

  if (apolloMatch) {
    try {
      const apolloData = JSON.parse(apolloMatch[1]);
      for (const key of Object.keys(apolloData)) {
        const obj = apolloData[key];
        if (!obj || typeof obj !== "object") continue;
        const m3u8Key = Object.keys(obj).find((k) => k.includes("M3U8") && obj[k]?.url);
        if (m3u8Key && obj[m3u8Key]?.url) {
          hlsUrl = obj[m3u8Key].url;
          const creds = obj[m3u8Key]?.credentials;
          if (creds) {
            hlsCreds = { policy: creds.Policy, signature: creds.Signature, keyPairId: creds.KeyPairId };
          }
        }
      }
    } catch { /* JSON parse failed, try MP4 fallback */ }
  }

  // Try direct MP4 URL (some older videos have this)
  const mp4Match = html.match(/https:\/\/cdn\.loom\.com\/sessions\/(?:transcoded|raw)\/[^"'\s\\]+\.mp4/);
  if (mp4Match) {
    const dlRes = await fetch(mp4Match[0], {
      headers: { Referer: "https://www.loom.com/", "User-Agent": BROWSER_UA },
    });
    if (dlRes.ok) {
      await streamToFile(dlRes, outPath);
      return;
    }
  }

  // Use ffmpeg to convert HLS stream to MP4
  if (hlsUrl) {
    const finalHlsUrl = hlsUrl;
    await new Promise<void>((resolve, reject) => {
      let headers = "Referer: https://www.loom.com/\r\n";
      if (hlsCreds) {
        headers += `Cookie: CloudFront-Policy=${hlsCreds.policy}; CloudFront-Signature=${hlsCreds.signature}; CloudFront-Key-Pair-Id=${hlsCreds.keyPairId}\r\n`;
      }
      const args = [
        "-loglevel", "error",
        "-headers", headers,
        "-i", finalHlsUrl,
        "-c", "copy",
        "-bsf:a", "aac_adtstoasc",
        "-movflags", "+faststart",
        "-y", outPath,
      ];
      execFile("ffmpeg", args, { timeout: 600000 }, (err, _stdout, stderr) => {
        if (err) {
          if (err.message.includes("ENOENT")) {
            reject(new Error("ffmpeg is not installed. Required to download Loom HLS videos."));
          } else {
            // With -loglevel error, stderr contains only the actual error (no banner)
            const detail = (stderr || "").trim() || err.message;
            reject(new Error(`ffmpeg failed: ${detail.slice(0, 500)}`));
          }
        } else {
          resolve();
        }
      });
    });
    return;
  }

  throw new Error("Could not find a downloadable video URL on the Loom page. The video may be private or password-protected.");
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

// ── Async job store ──────────────────────────────────────────────────────────
// Keeps upload jobs in memory so the POST can return immediately and the
// client can poll GET /api/youtube/upload?jobId=XXX for status.
// Lost on process restart, which is acceptable for a dev server.

interface UploadJob {
  status: "processing" | "completed" | "failed";
  videoId?: string;
  videoUrl?: string;
  error?: string;
  phase?: string;
  startedAt: number;
}

const jobStore = new Map<string, UploadJob>();

function newJobId(): string {
  return `yt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Clean up jobs older than 2 hours
function pruneJobs() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobStore) {
    if (job.startedAt < cutoff) jobStore.delete(id);
  }
}

// Status polling endpoint
async function getHandler(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });
  const job = jobStore.get(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json(job);
}

export const GET = withRequestLogging("api:youtube/upload:status", getHandler);

// ── Main upload handler ───────────────────────────────────────────────────────

async function runUpload(jobId: string, body: UploadRequest & {
  refreshToken: string; clientId: string; clientSecret: string;
  zoomAccountId?: string; zoomClientId?: string; zoomClientSecret?: string;
  firefliesApiKey?: string;
}): Promise<void> {
  const job = jobStore.get(jobId)!;
  const {
    refreshToken, clientId, clientSecret,
    title, description = "", tags = [], downloadUrl,
    privacyStatus = "unlisted", recordedAt,
    zoomAccountId, zoomClientId, zoomClientSecret, firefliesApiKey,
  } = body;

  try {
    // Step 1: Refresh YouTube token
    job.phase = "Refreshing YouTube token…";
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new Error(`YouTube token refresh failed (${tokenRes.status}): ${text}`);
    }
    const { access_token: ytAccessToken } = await tokenRes.json();

    // Step 2: Download source to temp file
    job.phase = "Downloading source video…";
    let tmpPath = join(tmpdir(), `video-upload-${Date.now()}.mp4`);

    if (downloadUrl.startsWith("youtube://")) {
      await downloadYouTubeToFile(downloadUrl.replace("youtube://", ""), tmpPath, body.ytCookies);
    } else if (downloadUrl.startsWith("zoom://recording/")) {
      if (!zoomAccountId || !zoomClientId || !zoomClientSecret) throw new Error("Zoom credentials required");
      await downloadZoomToFile(downloadUrl.replace("zoom://recording/", ""), zoomAccountId, zoomClientId, zoomClientSecret, tmpPath);
    } else if (downloadUrl.startsWith("fireflies://")) {
      if (!firefliesApiKey) throw new Error("Fireflies API key required");
      await downloadFirefliesToFile(downloadUrl.replace("fireflies://", ""), firefliesApiKey, tmpPath);
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

    // Step 2b: Trim if requested
    if (body.trimStartSeconds && body.trimStartSeconds > 0) {
      job.phase = "Trimming…";
      const trimmedPath = join(tmpdir(), `video-trimmed-${Date.now()}.mp4`);
      await new Promise<void>((resolve, reject) => {
        execFile("ffmpeg", ["-ss", String(body.trimStartSeconds), "-i", tmpPath, "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", "-y", trimmedPath],
          { timeout: 300000 }, (err, _stdout, stderr) => {
            if (err) reject(new Error(`ffmpeg trim failed: ${(stderr || err.message).slice(0, 300)}`));
            else resolve();
          });
      });
      fs.unlink(tmpPath).catch(() => {});
      tmpPath = trimmedPath;
    }

    // Step 3: Initiate resumable upload
    job.phase = "Initiating YouTube upload…";
    const videoSize = (await fs.stat(tmpPath)).size;
    const metadata: Record<string, unknown> = {
      snippet: { title, description, tags },
      status: { privacyStatus, selfDeclaredMadeForKids: false },
    };
    const parts = ["snippet", "status"];
    if (recordedAt) { metadata.recordingDetails = { recordingDate: recordedAt }; parts.push("recordingDetails"); }

    const initRes = await fetch(`https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=${parts.join(",")}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ytAccessToken}`,
        "Content-Type": "application/json",
        "X-Upload-Content-Length": videoSize.toString(),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify(metadata),
    });
    if (!initRes.ok) {
      const text = await initRes.text();
      throw new Error(`YouTube upload init failed (${initRes.status}): ${text}`);
    }
    const uploadUrl = initRes.headers.get("Location");
    if (!uploadUrl) throw new Error("YouTube did not return an upload URL");

    // Step 4: Stream to YouTube
    job.phase = "Uploading to YouTube…";
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
    const videoId = result.id;
    job.status = "completed";
    job.videoId = videoId;
    job.videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    job.phase = undefined;
    serverLog("info", "ext:youtube-upload", "published", { jobId, videoId });
    fs.unlink(tmpPath).catch(() => {});
  } catch (err) {
    job.status = "failed";
    job.error = String(err);
    job.phase = undefined;
    serverLog("error", "ext:youtube-upload", "failed", { jobId, error: String(err) });
  }
}

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
  const zoomAccountId = body.zoomAccountId || process.env.ZOOM_ACCOUNT_ID;
  const zoomClientId = body.zoomClientId || process.env.ZOOM_CLIENT_ID;
  const zoomClientSecret = body.zoomClientSecret || process.env.ZOOM_CLIENT_SECRET;
  const firefliesApiKey = body.firefliesApiKey || process.env.FIREFLIES_API_KEY;

  if (!refreshToken || !clientId || !clientSecret || !body.title || !body.downloadUrl) {
    return NextResponse.json(
      { error: "refreshToken, clientId, clientSecret, title, and downloadUrl are required" },
      { status: 400 },
    );
  }

  pruneJobs();
  const jobId = newJobId();
  jobStore.set(jobId, { status: "processing", phase: "Starting…", startedAt: Date.now() });

  // Fire-and-forget — response returns immediately, client polls for status
  runUpload(jobId, { ...body, refreshToken, clientId, clientSecret, zoomAccountId, zoomClientId, zoomClientSecret, firefliesApiKey }).catch(() => {});

  return NextResponse.json({ jobId }, { status: 202 });
}

// Cloud Run: --timeout=3600 in cloudbuild.yaml.
export const maxDuration = 3600;

export const POST = withRequestLogging("api:youtube/upload", handler);
