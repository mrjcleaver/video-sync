import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";

const OPUS_API_BASE = "https://api.opus.pro/api";

export interface OpusClip {
  /** Clip index within the job (0-based) */
  index: number;
  /** Suggested title for the clip */
  title: string;
  /** Virality score 0–100 */
  viralityScore: number;
  /** Start time in the source video (seconds) */
  startSeconds: number;
  /** End time in the source video (seconds) */
  endSeconds: number;
  /** Direct URL to the rendered clip MP4 */
  clipUrl: string;
  /** Thumbnail URL */
  thumbnailUrl: string | null;
}

export interface ShortsStatusResponse {
  status: "processing" | "completed" | "failed";
  clips: OpusClip[];
  error?: string;
}

interface OpusClipJobData {
  status?: string;
  state?: string;
  clips?: Array<Record<string, unknown>>;
  result?: {
    clips?: Array<Record<string, unknown>>;
  };
  error?: string;
  message?: string;
}

async function handler(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  const apiKey = req.nextUrl.searchParams.get("apiKey");

  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });
  if (!apiKey) return NextResponse.json({ error: "apiKey required" }, { status: 400 });

  serverLog("debug", "shorts:status", "Polling Opus Clip job", { jobId });

  const opusRes = await fetch(`${OPUS_API_BASE}/v1/create/${encodeURIComponent(jobId)}`, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
  });

  const data = (await opusRes.json()) as OpusClipJobData;

  if (!opusRes.ok) {
    const msg = data.error ?? data.message ?? `Opus Clip API error (${opusRes.status})`;
    serverLog("error", "shorts:status", "Opus Clip status check failed", { status: opusRes.status, msg });
    return NextResponse.json({ status: "failed", clips: [], error: msg } satisfies ShortsStatusResponse);
  }

  // Normalise status — Opus Clip may use "completed", "done", "success", "finished"
  const rawStatus = (data.status ?? data.state ?? "").toLowerCase();
  const isFailed = rawStatus === "failed" || rawStatus === "error";
  const isDone = rawStatus === "completed" || rawStatus === "done" || rawStatus === "success" || rawStatus === "finished";

  if (isFailed) {
    return NextResponse.json({
      status: "failed",
      clips: [],
      error: data.error ?? data.message ?? "Job failed",
    } satisfies ShortsStatusResponse);
  }

  if (!isDone) {
    return NextResponse.json({ status: "processing", clips: [] } satisfies ShortsStatusResponse);
  }

  // Parse clips from response — normalise from Opus Clip's schema
  const rawClips: Array<Record<string, unknown>> = data.clips ?? data.result?.clips ?? [];

  const clips: OpusClip[] = rawClips.map((c, i) => ({
    index: i,
    title: (c.title as string) ?? (c.caption as string) ?? `Clip ${i + 1}`,
    viralityScore: (c.virality_score as number) ?? (c.score as number) ?? 0,
    startSeconds: (c.start_time as number) ?? (c.start as number) ?? 0,
    endSeconds: (c.end_time as number) ?? (c.end as number) ?? 0,
    clipUrl: (c.url as string) ?? (c.clip_url as string) ?? (c.download_url as string) ?? "",
    thumbnailUrl: (c.thumbnail as string) ?? (c.thumbnail_url as string) ?? null,
  }));

  // Sort by virality score descending
  clips.sort((a, b) => b.viralityScore - a.viralityScore);

  serverLog("info", "shorts:status", "Opus Clip job completed", { jobId, clipCount: clips.length });
  return NextResponse.json({ status: "completed", clips } satisfies ShortsStatusResponse);
}

export const GET = withRequestLogging("api:shorts/status", handler);
