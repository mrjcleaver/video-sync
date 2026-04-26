import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";
import { downloadFromSource } from "../../../../lib/sourceDownload";
import { promises as fs, openAsBlob, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Kaltura publish — single-shot blocking upload (ADR-037 Phase 1).
 *
 * Flow:
 *   1. Mint Kaltura Session (KS) from partnerId + adminSecret
 *   2. Stream source media to a temp file
 *   3. Add upload token, upload file, create media entry, attach content
 *   4. Return { entryId, playerUrl, uploadStatus }
 *
 * No SSE in v1 — clients see an indeterminate spinner. Future Phase 2.
 */

interface KalturaUploadRequest {
  partnerId: string;
  adminSecret: string;
  title: string;
  description?: string;
  tags?: string[];
  downloadUrl: string;
  // Source-specific creds (forwarded to sourceDownload)
  zoomAccountId?: string;
  zoomClientId?: string;
  zoomClientSecret?: string;
  firefliesApiKey?: string;
  ytCookies?: string;
  // Kaltura-specific
  categoryIds?: number[];
  uiConfId?: number;
}

const KALTURA_BASE = "https://www.kaltura.com/api_v3";

async function kalturaCall(
  service: string,
  action: string,
  params: Record<string, string | number | object>,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  body.set("format", "1"); // 1 = JSON
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "object" && v !== null) {
      // Kaltura's "objectType" pattern: flatten nested objects with dotted keys
      for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
        body.set(`${k}:${kk}`, String(vv));
      }
    } else {
      body.set(k, String(v));
    }
  }
  const res = await fetch(`${KALTURA_BASE}/?service=${service}&action=${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Kaltura ${service}.${action} HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json() as Record<string, unknown>;
  if (typeof data === "object" && data && "code" in data && "message" in data) {
    throw new Error(`Kaltura ${service}.${action} error: ${(data as { code: string; message: string }).code} — ${(data as { code: string; message: string }).message}`);
  }
  return data;
}

async function uploadFileToToken(ks: string, uploadTokenId: string, filePath: string): Promise<void> {
  const sizeMb = statSync(filePath).size / (1024 * 1024);
  const form = new FormData();
  form.set("ks", ks);
  form.set("uploadTokenId", uploadTokenId);
  form.set("resume", "0");
  form.set("finalChunk", "1");
  form.set("resumeAt", "-1");

  // openAsBlob() returns a lazy Blob backed by the file — undici reads it
  // chunk-by-chunk when serialising the multipart body, so peak memory is
  // ~64 KB rather than the full file size. Required to avoid OOM (503 from
  // Cloud Run) on multi-GB livestreams. ADR-037 Phase 2 will move to
  // Kaltura's chunked upload (resumeAt=N) for resumability.
  const fileBlob = await openAsBlob(filePath, { type: "video/mp4" });
  form.set("fileData", fileBlob, "video.mp4");

  const res = await fetch(`${KALTURA_BASE}/?service=uploadToken&action=upload&format=1`, {
    method: "POST",
    body: form,
    // duplex: 'half' is required when the body is a stream
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!res.ok) throw new Error(`Kaltura upload HTTP ${res.status} (${sizeMb.toFixed(1)} MB): ${await res.text()}`);
  const data = await res.json() as Record<string, unknown>;
  if ("code" in data) {
    throw new Error(`Kaltura upload error: ${(data as { code: string; message: string }).code} — ${(data as { code: string; message: string }).message}`);
  }
}

async function handler(req: NextRequest): Promise<NextResponse> {
  let body: KalturaUploadRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const partnerId = body.partnerId || process.env.KALTURA_PARTNER_ID;
  const adminSecret = body.adminSecret || process.env.KALTURA_ADMIN_SECRET;
  if (!partnerId || !adminSecret || !body.title || !body.downloadUrl) {
    return NextResponse.json(
      { error: "partnerId, adminSecret, title, and downloadUrl are required" },
      { status: 400 },
    );
  }

  const tempPath = join(tmpdir(), `kaltura-upload-${Date.now()}.mp4`);

  try {
    // 1. Mint admin Kaltura Session
    const sessionRes = await kalturaCall("session", "start", {
      partnerId,
      secret: adminSecret,
      type: 2, // ADMIN session
      userId: "video-sync",
      expiry: 86400,
    });
    // session.start returns the KS as a bare string in JSON
    const ks = typeof sessionRes === "string" ? sessionRes : (sessionRes as { result?: string }).result || "";
    // Some Kaltura responses wrap the string at the top level — handle both.
    const ksValue: string = typeof sessionRes === "string"
      ? sessionRes
      : ((sessionRes as Record<string, unknown>)["objectType"] === "KalturaAPIException"
        ? (() => { throw new Error(`KS mint failed: ${JSON.stringify(sessionRes)}`); })()
        : ks || JSON.stringify(sessionRes));
    if (!ksValue || ksValue.length < 10) {
      throw new Error("Kaltura session.start returned no usable KS");
    }

    // 2. Download source media
    await downloadFromSource(body.downloadUrl, body, tempPath);

    // 3. Add upload token
    const tokenRes = await kalturaCall("uploadToken", "add", { ks: ksValue });
    const uploadTokenId = (tokenRes as { id?: string }).id;
    if (!uploadTokenId) throw new Error(`uploadToken.add returned no id: ${JSON.stringify(tokenRes)}`);

    // 4. Upload file
    await uploadFileToToken(ksValue, uploadTokenId, tempPath);

    // 5. Create media entry
    const mediaEntry: Record<string, string | number> = {
      objectType: "KalturaMediaEntry",
      mediaType: 1, // VIDEO
      name: body.title,
      description: body.description ?? "",
      tags: (body.tags ?? []).join(","),
    };
    if (body.categoryIds && body.categoryIds.length > 0) {
      mediaEntry.categoriesIds = body.categoryIds.join(",");
    }
    const entryRes = await kalturaCall("media", "add", { ks: ksValue, entry: mediaEntry });
    const entryId = (entryRes as { id?: string }).id;
    if (!entryId) throw new Error(`media.add returned no id: ${JSON.stringify(entryRes)}`);

    // 6. Attach the upload to the entry
    await kalturaCall("media", "addContent", {
      ks: ksValue,
      entryId,
      resource: {
        objectType: "KalturaUploadedFileTokenResource",
        token: uploadTokenId,
      },
    });

    const uiConfId = body.uiConfId ?? 0;
    const playerUrl = uiConfId > 0
      ? `https://cdnapisec.kaltura.com/p/${partnerId}/sp/${partnerId}00/embedIframeJs/uiconf_id/${uiConfId}/partner_id/${partnerId}?iframeembed=true&entry_id=${entryId}`
      : `https://www.kaltura.com/index.php/extwidget/preview/partner_id/${partnerId}/uiconf_id/0/entry_id/${entryId}/embed/iframe`;

    return NextResponse.json({
      entryId,
      playerUrl,
      uploadStatus: "ready",
    });
  } catch (err) {
    return NextResponse.json(
      { error: String(err instanceof Error ? err.message : err) },
      { status: 502 },
    );
  } finally {
    fs.unlink(tempPath).catch(() => {});
  }
}

export const POST = withRequestLogging("api:kaltura/upload", handler);
