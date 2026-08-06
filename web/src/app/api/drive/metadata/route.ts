/**
 * POST /api/drive/metadata
 *
 * Body: { file_id: string }
 *
 * ADR-071 §1 contributor path — resolve a public-share Drive file
 * without an access token. Two tiers:
 *
 *   1. Un-authenticated Drive v3 `files.get` — works when the file is
 *      shared "anyone with the link" and returns metadata directly.
 *   2. Fallback via the Cloud Run runtime service account (ADR-039).
 *      Works when the SA has been granted access to the file (org
 *      Shared Drive membership, or file explicitly shared with the SA).
 *
 * If both fail we return `{ requires_auth: true }` — the client uses
 * that as the signal to route the submission into the ADR-071 §2
 * pending-curator queue.
 *
 * mimeType guard rejects Google-native docs (Docs / Sheets / Slides)
 * — those are not videos and would fail the ingest step downstream.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { GoogleAuth } from "google-auth-library";

export interface DriveVideoMetadata {
  file_id: string;
  name: string;
  mime_type: string;
  size_bytes: number | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  created_time: string | null;
  modified_time: string | null;
  thumbnail_link: string | null;
  web_view_link: string | null;
  owner_email: string | null;
  owner_name: string | null;
  /** Which auth path resolved the metadata. Informational for the
   *  client — the ingest endpoint will pick its own auth path. */
  resolved_via: "public" | "service_account";
}

export interface DriveMetadataRequiresAuth {
  requires_auth: true;
  /** Human-readable hint the client can surface. */
  reason: string;
}

const DRIVE_V3 = "https://www.googleapis.com/drive/v3";
// videoMediaMetadata gives us durationMillis / width / height for
// actual video files; requesting it on a non-video is safe (Drive
// just omits the field).
const FIELDS = [
  "id", "name", "mimeType", "size",
  "videoMediaMetadata",
  "createdTime", "modifiedTime",
  "thumbnailLink", "webViewLink",
  "owners(emailAddress,displayName)",
].join(",");

interface DriveFileResponse {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  videoMediaMetadata?: {
    durationMillis?: string;
    width?: number;
    height?: number;
  };
  createdTime?: string;
  modifiedTime?: string;
  thumbnailLink?: string;
  webViewLink?: string;
  owners?: Array<{ emailAddress?: string; displayName?: string }>;
}

function normalize(file: DriveFileResponse, via: DriveVideoMetadata["resolved_via"]): DriveVideoMetadata {
  const durMs = file.videoMediaMetadata?.durationMillis;
  return {
    file_id: file.id,
    name: file.name,
    mime_type: file.mimeType,
    size_bytes: file.size ? Number(file.size) : null,
    duration_seconds: durMs ? Math.round(Number(durMs) / 1000) : null,
    width: file.videoMediaMetadata?.width ?? null,
    height: file.videoMediaMetadata?.height ?? null,
    created_time: file.createdTime ?? null,
    modified_time: file.modifiedTime ?? null,
    thumbnail_link: file.thumbnailLink ?? null,
    web_view_link: file.webViewLink ?? null,
    owner_email: file.owners?.[0]?.emailAddress ?? null,
    owner_name: file.owners?.[0]?.displayName ?? null,
    resolved_via: via,
  };
}

function isVideoMime(mime: string): boolean {
  // Accept video/*. Explicitly reject Google-native docs (application/
  // vnd.google-apps.*) even if some future variant claims to be a
  // "video": those would need files.export not files.get?alt=media.
  if (mime.startsWith("application/vnd.google-apps.")) return false;
  return mime.startsWith("video/");
}

async function fetchPublic(fileId: string): Promise<DriveFileResponse | { status: number }> {
  const url = `${DRIVE_V3}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return { status: res.status };
  return (await res.json()) as DriveFileResponse;
}

async function fetchWithServiceAccount(fileId: string): Promise<DriveFileResponse | { status: number; reason: string }> {
  try {
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const client = await auth.getClient();
    const tokenResp = await client.getAccessToken();
    const token = tokenResp.token;
    if (!token) return { status: 401, reason: "no_service_account_token" };
    const url = `${DRIVE_V3}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return { status: res.status, reason: `drive_${res.status}` };
    return (await res.json()) as DriveFileResponse;
  } catch (err) {
    return { status: 500, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function handler(req: NextRequest) {
  let body: { file_id?: string };
  try {
    body = (await req.json()) as { file_id?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const fileId = (body.file_id ?? "").trim();
  if (!fileId || !/^[A-Za-z0-9_-]{10,}$/.test(fileId)) {
    return NextResponse.json({ error: "file_id required (Drive file ID, 10+ chars)" }, { status: 400 });
  }

  // Tier 1 — public
  const pub = await fetchPublic(fileId);
  if ("id" in pub) {
    if (!isVideoMime(pub.mimeType)) {
      return NextResponse.json(
        { error: `File is not a video (mimeType=${pub.mimeType}). Google Docs / Sheets / Slides can't be ingested; export to MP4 first if needed.` },
        { status: 415 },
      );
    }
    return NextResponse.json(normalize(pub, "public"));
  }

  // Tier 2 — service account fallback
  const sa = await fetchWithServiceAccount(fileId);
  if ("id" in sa) {
    if (!isVideoMime(sa.mimeType)) {
      return NextResponse.json(
        { error: `File is not a video (mimeType=${sa.mimeType}).` },
        { status: 415 },
      );
    }
    return NextResponse.json(normalize(sa, "service_account"));
  }

  // Both tiers failed → curator handoff
  serverLog("info", "api:drive/metadata", "requires_auth", {
    file_id: fileId,
    public_status: pub.status,
    sa_status: sa.status,
    sa_reason: sa.reason,
  });
  const body429: DriveMetadataRequiresAuth = {
    requires_auth: true,
    reason:
      pub.status === 404
        ? "Drive returned 404 to un-authenticated read. If this file is private, a curator with org Drive access will need to pull it."
        : `Drive returned ${pub.status} public / ${sa.status} SA. A curator with org Drive access will need to pull it.`,
  };
  // 200 with requires_auth (not 4xx) — the client uses the JSON body to
  // switch behaviour, not the HTTP status. Keeps the /api/drive/status
  // polling logic uniform.
  return NextResponse.json(body429);
}

export const POST = withRequestLogging("api:drive/metadata", handler);
