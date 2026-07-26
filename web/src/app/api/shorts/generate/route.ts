import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getSharedCredential } from "../../../../lib/sharedCredentials";

// Opus Clip API — see https://help.opus.pro/api-reference/overview
const OPUS_API_BASE = "https://api.opus.pro/api";

interface GenerateRequest {
  parentYouTubeUrl: string;
  videoTitle: string;
  captions: boolean | "srt";
  prompt?: string;
  apiKey: string;
}

// Opus Clip API v2 (2026 rewrite of /v1/create → /clip-projects)
// returns a flat ClipProjectRepresentation. Keep the older
// data.id/data.uid keys in the shape as fallbacks so a partial
// server-side proxy or beta gateway that still wraps the response
// doesn't break us — but the canonical field is `id`.
interface OpusClipJobResponse {
  data?: {
    id?: string;
    uid?: string;
  };
  id?: string;
  uid?: string;
  projectId?: string;
  error?: string;
  // NestJS validation-pipe errors return {message: string[], error, statusCode}.
  // Legacy responses used message: string. Support both.
  message?: string | string[];
  statusCode?: number;
}

async function handler(req: NextRequest) {
  if (req.method !== "POST") {
    return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: GenerateRequest;
  try {
    body = (await req.json()) as GenerateRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { videoTitle, captions, prompt } = body;
  let { parentYouTubeUrl } = body;

  if (!parentYouTubeUrl) {
    return NextResponse.json({ error: "parentYouTubeUrl is required" }, { status: 400 });
  }

  // Belt-and-suspenders: Origin locations on born-on-YouTube records
  // sometimes carry the internal `youtube://<id>` scheme URL. Opus
  // rejects that as "Unsupported video link". Rewrite here even if
  // the client forgot, so a stale UI still works after this fix
  // ships.
  if (parentYouTubeUrl.startsWith("youtube://")) {
    parentYouTubeUrl = `https://www.youtube.com/watch?v=${parentYouTubeUrl.slice("youtube://".length)}`;
  }

  // ADR-042: operator override (body) → shared secret → none. Trim
  // both sides so a whitespace-only body field doesn't shadow the
  // shared default (consistent with the other handlers).
  const sharedOC = (await getSharedCredential("opusclip")) ?? {};
  const apiKey = body.apiKey?.trim() || (sharedOC as { apiKey?: string }).apiKey?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "apiKey is required (set in Connections or shared by key admin)" }, { status: 400 });
  }

  serverLog("info", "shorts:generate", "Submitting clip job to Opus Clip", {
    url: parentYouTubeUrl,
    captions,
    hasPrompt: !!prompt,
  });

  // Submit clip project to Opus Clip.
  // POST /api/clip-projects — replaces the legacy /api/v1/create,
  // which was retired around 2026 and now returns HTTP 404
  // "Cannot POST /api/v1/create". The new schema is camelCase and
  // groups options under curationPref + renderPref instead of the
  // flat top-level fields. See help.opus.pro/api-reference/openapi.json.
  const opusPayload: Record<string, unknown> = {
    videoUrl: parentYouTubeUrl,
    // Portrait aspect ratio for Shorts / Reels (was: aspect_ratio "9:16").
    renderPref: {
      enableCaption: captions === true || captions === "srt",
      layoutAspectRatio: "portrait",
    },
    // Empty curationPref lets Opus decide clip count/durations, matching
    // the old num_clips: 0 semantics. Prompt maps to topicKeywords.
    ...(prompt
      ? { curationPref: { topicKeywords: [prompt] } }
      : {}),
  };
  // videoTitle is no longer settable via the create endpoint — kept
  // as a log-only breadcrumb so the server-side audit trail still
  // reflects which video the project was for.
  void videoTitle;

  const opusRes = await fetch(`${OPUS_API_BASE}/clip-projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(opusPayload),
  });

  // Read the response as text first so we can log it verbatim on
  // failure. Opus's error shape varies (top-level error/message,
  // NestJS-style {message: string|array, error, statusCode}, or a
  // plain string) — logging the raw body is the only reliable way
  // to diagnose a 422/400 from a strict validator.
  const opusText = await opusRes.text();
  let opusData: OpusClipJobResponse = {};
  try {
    opusData = JSON.parse(opusText) as OpusClipJobResponse;
  } catch {
    // Non-JSON response (rare); leave opusData empty, error path uses opusText.
  }

  // The new API returns 201 Created on success; keep the .ok check
  // (which accepts any 2xx) rather than a strict === 200 test.
  if (!opusRes.ok) {
    // NestJS-style validation errors come back as {message: string[]}.
    const nestMessage = opusData.message;
    const nestMessageStr = Array.isArray(nestMessage)
      ? nestMessage.join("; ")
      : (typeof nestMessage === "string" ? nestMessage : null);
    const msg =
      opusData.error
      ?? nestMessageStr
      ?? (opusText && opusText.length < 500 ? opusText : `Opus Clip API error (${opusRes.status})`);
    serverLog("error", "shorts:generate", "Opus Clip job submission failed", {
      status: opusRes.status,
      msg,
      body: opusText.slice(0, 800),
      request_body: opusPayload,
    });
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // Prefer top-level `id` (the new API's canonical field) with the
  // older data.id/data.uid/uid shapes as fallbacks.
  const jobId = opusData.id ?? opusData.projectId ?? opusData.data?.id ?? opusData.data?.uid ?? opusData.uid;

  if (!jobId) {
    serverLog("error", "shorts:generate", "No job ID in Opus Clip response", { opusData });
    return NextResponse.json({ error: "No job ID returned by Opus Clip" }, { status: 502 });
  }

  // Operator-facing Opus Clip project URL (clips-list view with
  // Opus's own progress meter). Opus's OpenAPI doesn't expose one,
  // so we construct from the project id. Per-clip edit URLs use a
  // different shape (see shorts/status/route.ts) and require the
  // per-clip id from ExportableClipRepresentation.id.
  const opusProjectUrl = `https://clip.opus.pro/clip/${encodeURIComponent(jobId)}`;

  serverLog("info", "shorts:generate", "Opus Clip job submitted", { jobId, opusProjectUrl });
  return NextResponse.json({ jobId, opusProjectUrl });
}

export const POST = withRequestLogging("api:shorts/generate", handler);
