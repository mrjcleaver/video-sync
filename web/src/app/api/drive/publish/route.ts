/**
 * POST /api/drive/publish
 *
 * ADR-075 Phase 2 §Follow-up #4 — Drive folder as a first-class
 * publish destination. Downloads the record's source media into a
 * temp file and uploads it to the target Drive folder using the
 * runtime service account (ADR-042).
 *
 * Body:
 *   record_id: string    — catalog record uuid
 *   folder_id: string    — target Drive folder id (raw id or full URL)
 *
 * Uses the same sourceDownload helper as /api/kaltura/upload and
 * /api/youtube/upload so every source scheme (zoom / fireflies /
 * youtube / loom / drive / http) works uniformly.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { readCatalog } from "../../catalog/route";
import { downloadFromSource, type SourceCreds } from "../../../../lib/sourceDownload";
import { getDrive } from "../../../../lib/drive";
import { getSharedCredential } from "../../../../lib/sharedCredentials";
import { promises as fs, createReadStream } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { VideoRecordJSON } from "../../../../lib/wasm";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

/**
 * Google Drive folder ids are 25+ chars of URL-safe base64. Series
 * config sometimes stores the whole "https://drive.google.com/drive/…
 * /folders/<id>" URL; this normalises both shapes to the bare id.
 */
export function extractDriveFolderId(input: string): string {
  const s = (input ?? "").trim();
  if (!s) return "";
  const m1 = s.match(/\/folders\/([A-Za-z0-9_-]{20,})/);
  if (m1) return m1[1];
  const m2 = s.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  if (m2) return m2[1];
  // Bare-id fallback: alphanumeric + _ + - only, ≥ 20 chars.
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  return s; // leave anything else alone; Drive API will 404 loudly
}

interface Body {
  record_id?: string;
  folder_id?: string;
  // yt-dlp cookies for YouTube-sourced records — passed through the
  // same way /api/kaltura/upload accepts them.
  ytCookies?: string;
  // Zoom / Fireflies credentials for source download.
  zoomAccountId?: string;
  zoomClientId?: string;
  zoomClientSecret?: string;
  firefliesApiKey?: string;
}

async function handler(req: NextRequest) {
  let body: Body;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 400 }); }

  const recordId = (body.record_id ?? "").trim();
  const folderId = extractDriveFolderId(body.folder_id ?? "");
  if (!recordId) return NextResponse.json({ error: "record_id required" }, { status: 400 });
  if (!folderId || folderId.length < 20) {
    return NextResponse.json({ error: `folder_id could not be parsed (got "${body.folder_id}")` }, { status: 400 });
  }

  const store = await readCatalog();
  const raw = store.records[recordId];
  if (!raw) return NextResponse.json({ error: "record not in catalog" }, { status: 404 });
  const rec = JSON.parse(raw) as VideoRecordJSON;

  // Sanitise filename — Drive is fine with most punctuation but a
  // clean, dated title makes the folder browsable.
  const safeTitle = (rec.title || "video").replace(/[\\/]/g, "-").slice(0, 120);
  const filename = `${safeTitle}.mp4`;

  const creds: SourceCreds = {
    ytCookies: body.ytCookies,
    zoomAccountId: body.zoomAccountId,
    zoomClientId: body.zoomClientId,
    zoomClientSecret: body.zoomClientSecret,
    firefliesApiKey: body.firefliesApiKey,
  };
  // ADR-042 — fill missing creds from the shared vault, mirroring the
  // pattern used by /api/kaltura/upload. Client-side ConnectionsPanel
  // stores platforms in SHARED_PLATFORM_NAMES server-side only, so the
  // client's fetch body will typically NOT carry firefliesApiKey /
  // zoom* — the fallback below is the actual source of these values.
  const scheme = rec.download_url.startsWith("zoom://") ? "zoom"
    : rec.download_url.startsWith("fireflies://") ? "fireflies"
    : rec.download_url.startsWith("youtube://") ? "youtube"
    : "other";
  if (scheme === "zoom" && (!creds.zoomAccountId || !creds.zoomClientId || !creds.zoomClientSecret)) {
    const sharedZ = (await getSharedCredential("zoom")) as { accountId?: string; clientId?: string; clientSecret?: string } | null;
    if (sharedZ) {
      creds.zoomAccountId    = creds.zoomAccountId    ?? sharedZ.accountId;
      creds.zoomClientId     = creds.zoomClientId     ?? sharedZ.clientId;
      creds.zoomClientSecret = creds.zoomClientSecret ?? sharedZ.clientSecret;
    }
  }
  if (scheme === "fireflies" && !creds.firefliesApiKey) {
    const sharedFf = (await getSharedCredential("fireflies")) as { apiKey?: string } | null;
    if (sharedFf?.apiKey) creds.firefliesApiKey = sharedFf.apiKey;
  }
  // yt-dlp cookies live in the youtube shared cred as `ytCookies`
  // (matching the ConnectionsPanel field key). Fetched only when the
  // source is YouTube — most Drive publishes won't hit this.
  if (scheme === "youtube" && !creds.ytCookies) {
    const sharedYt = (await getSharedCredential("youtube")) as { ytCookies?: string } | null;
    if (sharedYt?.ytCookies) creds.ytCookies = sharedYt.ytCookies;
  }

  const tmpPath = join(tmpdir(), `drive-publish-${recordId}-${Date.now()}.mp4`);
  try {
    // Stage 1 — pull the source. This uses the same download shim
    // as YouTube / Kaltura publish so every source scheme works.
    await downloadFromSource(rec.download_url, creds, tmpPath);
    const st = await fs.stat(tmpPath);
    serverLog("info", "api:drive/publish", "source-downloaded", {
      record_id: recordId, bytes: st.size, source: rec.source_platform,
    });

    // Stage 2 — upload to Drive. supportsAllDrives handles the org
    // Shared Drive that folder_id might live in.
    const drive = getDrive();
    const uploadRes = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [folderId],
        appProperties: { video_sync_record_id: recordId },
      },
      media: {
        mimeType: "video/mp4",
        body: createReadStream(tmpPath),
      },
      fields: "id, name, webViewLink, size",
      supportsAllDrives: true,
    });

    const fileId = uploadRes.data.id ?? "";
    const webViewLink = uploadRes.data.webViewLink ?? `https://drive.google.com/file/d/${fileId}/view`;
    serverLog("info", "api:drive/publish", "complete", {
      record_id: recordId, drive_file_id: fileId, bytes: uploadRes.data.size,
    });
    return NextResponse.json({
      ok: true,
      drive_file_id: fileId,
      web_view_link: webViewLink,
      filename,
      bytes: Number(uploadRes.data.size ?? 0),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    serverLog("error", "api:drive/publish", "failed", { record_id: recordId, error: msg });
    return NextResponse.json({ error: msg }, { status: 502 });
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

export const POST = withRequestLogging("api:drive/publish", handler);
