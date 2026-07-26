import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";

const OPUS_API_BASE = "https://api.opus.pro/api";

export interface OpusClip {
  /** Clip index within the job (0-based) */
  index: number;
  /** Suggested title for the clip */
  title: string;
  /** Virality score 0–100. The new API doesn't return one — kept for
   *  interface stability; always 0. */
  viralityScore: number;
  /** Start time in the source video (seconds) */
  startSeconds: number;
  /** End time in the source video (seconds) */
  endSeconds: number;
  /** Direct URL to the rendered clip MP4 */
  clipUrl: string;
  /** Thumbnail URL. Not returned by the new /api/exportable-clips
   *  endpoint — always null. */
  thumbnailUrl: string | null;
}

export interface ShortsStatusResponse {
  status: "processing" | "completed" | "failed";
  clips: OpusClip[];
  error?: string;
  /** Raw Opus stage. Exposed so the client can detect transitions
   *  (IMPORT → CURATE, → COMPLETE, etc.) and emit per-stage events
   *  into the catalog log. */
  stage?: "PENDING" | "QUEUED" | "IMPORT" | "CURATE" | "REFINE" | "RENDER" | "UPLOAD" | "COMPLETE" | "STALLED";
}

/**
 * Opus Clip v2 (2026): /api/clip-projects/{id} returns a
 * ClipProjectRepresentation. The status field is `stage`, with the
 * enum below. Clip metadata isn't returned here — a separate
 * /api/exportable-clips?q=findByProjectId call is needed once
 * stage === COMPLETE.
 */
interface ClipProjectRepresentation {
  id?: string;
  projectId?: string;
  stage?: "PENDING" | "QUEUED" | "IMPORT" | "CURATE" | "REFINE" | "RENDER" | "UPLOAD" | "COMPLETE" | "STALLED";
  error?: string;
  message?: string;
}

interface ExportableClipRepresentation {
  id?: string;
  title?: string;
  description?: string;
  /** [[startMs, endMs], ...] — per Opus's OpenAPI example, values are
   *  milliseconds despite the field description saying "seconds". */
  timeRanges?: number[][];
  uriForExport?: string;
  uriForPreview?: string;
}

async function handler(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  const apiKey = req.nextUrl.searchParams.get("apiKey");

  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });
  if (!apiKey) return NextResponse.json({ error: "apiKey required" }, { status: 400 });

  serverLog("debug", "shorts:status", "Polling Opus Clip project", { jobId });

  const opusRes = await fetch(`${OPUS_API_BASE}/clip-projects/${encodeURIComponent(jobId)}`, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
  });

  const proj = (await opusRes.json()) as ClipProjectRepresentation;

  if (!opusRes.ok) {
    const msg = proj.error ?? proj.message ?? `Opus Clip API error (${opusRes.status})`;
    serverLog("error", "shorts:status", "Opus Clip status check failed", { status: opusRes.status, msg });
    return NextResponse.json({ status: "failed", clips: [], error: msg } satisfies ShortsStatusResponse);
  }

  const stage = proj.stage;
  // STALLED = terminal failure. Everything except COMPLETE is either
  // in-flight or unknown — treat as "processing" so the client keeps
  // polling.
  if (stage === "STALLED") {
    return NextResponse.json({
      status: "failed",
      clips: [],
      error: proj.error ?? proj.message ?? "Job stalled",
      stage,
    } satisfies ShortsStatusResponse);
  }
  if (stage !== "COMPLETE") {
    return NextResponse.json({ status: "processing", clips: [], stage } satisfies ShortsStatusResponse);
  }

  // COMPLETE → fetch the actual clip list from /api/exportable-clips.
  const clipsRes = await fetch(
    `${OPUS_API_BASE}/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(jobId)}`,
    {
      headers: { "Authorization": `Bearer ${apiKey}` },
    },
  );

  if (!clipsRes.ok) {
    const text = await clipsRes.text().catch(() => "");
    serverLog("error", "shorts:status", "exportable-clips fetch failed", { status: clipsRes.status, body: text.slice(0, 300) });
    return NextResponse.json({
      status: "failed",
      clips: [],
      error: `Failed to load clips (${clipsRes.status})`,
    } satisfies ShortsStatusResponse);
  }

  const rawClips = (await clipsRes.json()) as ExportableClipRepresentation[];

  const clips: OpusClip[] = rawClips.map((c, i) => {
    // timeRanges is [[startMs, endMs], ...] — take the first range.
    const range = (c.timeRanges && c.timeRanges[0]) || [0, 0];
    return {
      index: i,
      title: c.title || `Clip ${i + 1}`,
      // Virality score removed from the v2 schema; keep the field for
      // API stability but zero it out. Consumers already handle missing.
      viralityScore: 0,
      startSeconds: Math.round((range[0] || 0) / 1000),
      endSeconds: Math.round((range[1] || 0) / 1000),
      clipUrl: c.uriForExport || c.uriForPreview || "",
      // Thumbnail is a separate endpoint in v2; not fetched here.
      thumbnailUrl: null,
    };
  });

  serverLog("info", "shorts:status", "Opus Clip project completed", { jobId, clipCount: clips.length });
  return NextResponse.json({ status: "completed", clips, stage } satisfies ShortsStatusResponse);
}

export const GET = withRequestLogging("api:shorts/status", handler);
