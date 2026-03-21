import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";

// Opus Clip API — see https://help.opus.pro/api-reference/overview
const OPUS_API_BASE = "https://api.opus.pro/api";

interface GenerateRequest {
  parentYouTubeUrl: string;
  videoTitle: string;
  captions: boolean | "srt";
  prompt?: string;
  apiKey: string;
}

interface OpusClipJobResponse {
  data?: {
    id?: string;
    uid?: string;
  };
  id?: string;
  uid?: string;
  error?: string;
  message?: string;
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

  const { parentYouTubeUrl, videoTitle, captions, prompt, apiKey } = body;

  if (!parentYouTubeUrl) {
    return NextResponse.json({ error: "parentYouTubeUrl is required" }, { status: 400 });
  }
  if (!apiKey) {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }

  serverLog("info", "shorts:generate", "Submitting clip job to Opus Clip", {
    url: parentYouTubeUrl,
    captions,
    hasPrompt: !!prompt,
  });

  // Submit clip generation job to Opus Clip
  // POST /v1/create — creates a new clip project
  const opusPayload: Record<string, unknown> = {
    video_url: parentYouTubeUrl,
    video_name: videoTitle,
    // caption_switch: true burns captions into the clip
    caption_switch: captions === true || captions === "srt",
    // aspect_ratio: 9:16 for Shorts/Reels
    aspect_ratio: "9:16",
    // Let Opus Clip AI decide clip count
    num_clips: 0, // 0 = AI decides
  };

  if (prompt) {
    opusPayload.prompt = prompt;
  }

  const opusRes = await fetch(`${OPUS_API_BASE}/v1/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(opusPayload),
  });

  const opusData = (await opusRes.json()) as OpusClipJobResponse;

  if (!opusRes.ok) {
    const msg = opusData.error ?? opusData.message ?? `Opus Clip API error (${opusRes.status})`;
    serverLog("error", "shorts:generate", "Opus Clip job submission failed", { status: opusRes.status, msg });
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // Job ID may be at data.id, data.uid, id, or uid depending on API version
  const jobId = opusData.data?.id ?? opusData.data?.uid ?? opusData.id ?? opusData.uid;

  if (!jobId) {
    serverLog("error", "shorts:generate", "No job ID in Opus Clip response", { opusData });
    return NextResponse.json({ error: "No job ID returned by Opus Clip" }, { status: 502 });
  }

  serverLog("info", "shorts:generate", "Opus Clip job submitted", { jobId });
  return NextResponse.json({ jobId });
}

export const POST = withRequestLogging("api:shorts/generate", handler);
