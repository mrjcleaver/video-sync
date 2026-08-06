/**
 * POST /api/drive/ingest
 *
 * Body: { file_id: string, record_id: string, auth?: "public" | "service_account" }
 *
 * ADR-071 §3 — streams a Drive file to gs://.../videos/<record-id>.<ext>
 * on the FUSE mount. Fire-and-forget from the client's perspective:
 * the response returns immediately with a job handle; the caller polls
 * /api/drive/status?record_id=<id> for progress.
 *
 * Auth modes:
 *   - "public"          — GET files.get?alt=media with no token.
 *                          Only works if the file is shared publicly.
 *   - "service_account" — mint a token from the runtime SA at
 *                          drive.readonly scope. Only Publisher+ can
 *                          request this via the client (server-side
 *                          role gate).
 *
 * The endpoint is idempotent: a re-POST while a copy is in flight
 * returns 409; a re-POST after completion overwrites the FUSE file
 * (GCS Object Versioning retains the prior blob).
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getActor } from "../../../../lib/auth";
import { GoogleAuth } from "google-auth-library";
import { promises as fs, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { join } from "path";
import {
  beginJob, markCopying, reportProgress, finishJob,
  IngestAlreadyRunning,
} from "../../../../lib/driveIngestJobs";

const DRIVE_V3 = "https://www.googleapis.com/drive/v3";
const VIDEOS_DIR = join(process.cwd(), "data", "videos");

// mime → extension, best-effort. Falls back to .mp4.
function extForMime(mime: string, name: string): string {
  const nameExt = name.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1]?.toLowerCase();
  if (nameExt && ["mp4", "mov", "webm", "mkv", "avi", "m4v"].includes(nameExt)) {
    return nameExt;
  }
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/quicktime") return "mov";
  if (mime === "video/webm") return "webm";
  if (mime === "video/x-matroska") return "mkv";
  return "mp4";
}

interface IngestBody {
  file_id?: string;
  record_id?: string;
  auth?: "public" | "service_account";
}

async function tokenForServiceAccount(): Promise<string | null> {
  try {
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const client = await auth.getClient();
    const tokenResp = await client.getAccessToken();
    return tokenResp.token ?? null;
  } catch {
    return null;
  }
}

async function fetchFilesGetMeta(fileId: string, token: string | null): Promise<{ name: string; mimeType: string; size: string | null } | { error: string; status: number }> {
  const url = `${DRIVE_V3}/files/${encodeURIComponent(fileId)}?fields=name,mimeType,size&supportsAllDrives=true`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) return { error: `drive_${res.status}`, status: res.status };
  const j = (await res.json()) as { name: string; mimeType: string; size?: string };
  return { name: j.name, mimeType: j.mimeType, size: j.size ?? null };
}

async function handler(req: NextRequest) {
  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const fileId = (body.file_id ?? "").trim();
  const recordId = (body.record_id ?? "").trim();
  const authMode = body.auth ?? "public";
  if (!fileId || !recordId) {
    return NextResponse.json({ error: "file_id and record_id required" }, { status: 400 });
  }

  // Role gate — only Publisher+ can request service-account-backed
  // ingest. The contributor path uses auth=public and hits Drive
  // un-authenticated, so contributor identity doesn't matter here.
  if (authMode === "service_account") {
    const actor = await getActor(req.headers).catch(() => null);
    const role = actor?.role ?? "Viewer";
    if (role !== "Admin" && role !== "Publisher") {
      return NextResponse.json({ error: "service-account ingest requires Publisher role" }, { status: 403 });
    }
  }

  const token = authMode === "service_account" ? await tokenForServiceAccount() : null;
  if (authMode === "service_account" && !token) {
    return NextResponse.json({ error: "could not mint runtime service-account token" }, { status: 500 });
  }

  // Pre-flight metadata: gives us name (→ ext), size (→ progress bar).
  const meta = await fetchFilesGetMeta(fileId, token);
  if ("error" in meta) {
    return NextResponse.json({ error: `drive metadata fetch failed (${meta.error})` }, { status: meta.status });
  }
  const ext = extForMime(meta.mimeType, meta.name);
  const sizeTotal = meta.size ? Number(meta.size) : null;

  // Concurrency guard.
  let job;
  try {
    job = beginJob({
      record_id: recordId,
      file_id: fileId,
      ext,
      mime_type: meta.mimeType,
      bytes_total: sizeTotal,
    });
  } catch (err) {
    if (err instanceof IngestAlreadyRunning) {
      return NextResponse.json(
        { error: "ingest already running for this record", job: err.job },
        { status: 409 },
      );
    }
    throw err;
  }

  // Kick the copy in the background — do NOT await. The client polls
  // /api/drive/status. Errors update the job state and are picked up
  // on the next poll.
  void runIngest(recordId, fileId, ext, token).catch((err) => {
    serverLog("error", "api:drive/ingest", "background_ingest_failed", {
      record_id: recordId, file_id: fileId,
      error: err instanceof Error ? err.message : String(err),
    });
    finishJob(recordId, false, err instanceof Error ? err.message : String(err));
  });

  return NextResponse.json({
    ok: true,
    job: {
      record_id: job.record_id,
      state: job.state,
      bytes_total: job.bytes_total,
      ext: job.ext,
      mime_type: job.mime_type,
    },
  });
}

async function runIngest(recordId: string, fileId: string, ext: string, token: string | null): Promise<void> {
  await fs.mkdir(VIDEOS_DIR, { recursive: true });
  const destPath = join(VIDEOS_DIR, `${recordId}.${ext}`);

  const mediaUrl = `${DRIVE_V3}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const res = await fetch(mediaUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok || !res.body) {
    throw new Error(`drive media fetch failed (${res.status})`);
  }

  markCopying(recordId);

  // Wrap the WHATWG stream in a Node Readable so we can pipeline it
  // to the fs write stream and observe byte progress.
  const nodeStream = Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream<Uint8Array>);
  let bytesSeen = 0;
  nodeStream.on("data", (chunk: Buffer) => {
    bytesSeen += chunk.length;
    reportProgress(recordId, bytesSeen);
  });

  const out = createWriteStream(destPath);
  await pipeline(nodeStream, out);

  finishJob(recordId, true);
  serverLog("info", "api:drive/ingest", "complete", {
    record_id: recordId, file_id: fileId, bytes: bytesSeen, dest: destPath,
  });
}

export const POST = withRequestLogging("api:drive/ingest", handler);
