/**
 * ADR-046 slice 4 — bulk regenerate unlocked summaries.
 *
 * POST /api/summary/regen  (SSE)
 * Body: {
 *   queue: Array<RecordContext & { estimated_cost_usd: number }>,
 *   cost_cap_usd: number,
 *   prompt_version: number,  // version the client built the queue against;
 *                            // server bails if the actual current version
 *                            // doesn't match (race guard)
 * }
 *
 * Streams Server-Sent Events:
 *   event: started  data: { total, cost_cap_usd, prompt_version }
 *   event: record_done  data: { record_id, doc_id, doc_url, counts,
 *                                prompt_version, cost_so_far_usd, index }
 *   event: record_failed  data: { record_id, error, index }
 *   event: paused  data: { reason: "cost_cap" | "cancelled", cost_so_far_usd }
 *   event: complete  data: { processed, failed, cost_so_far_usd }
 *
 * State is persisted to data/summary-regen-state.json after each record
 * so a refresh on the panel can show the current state, and so a
 * future Resume flow can pick up from where it stopped.
 *
 * Admin role required.
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getActor } from "../../../../lib/auth";
import { getCurrentPrompt } from "../../../../lib/summaryPrompt";
import { generateRecordSummary, GenerateError } from "../../../../lib/summaryGenerate";
import { estimatePerRecordCost } from "../../../../lib/llmCost";
import type { RecordContext } from "../../../../lib/driveArtifactStore";

export const dynamic = "force-dynamic";

const STATE_FILE = join(process.cwd(), "data", "summary-regen-state.json");

interface QueueItem extends RecordContext {
  estimated_cost_usd: number;
}

interface RegenBody {
  queue?: QueueItem[];
  cost_cap_usd?: number;
  prompt_version?: number;
}

interface RegenState {
  job_id: string;
  status: "running" | "paused" | "complete" | "cancelled" | "failed";
  prompt_version: number;
  cost_cap_usd: number;
  total: number;
  processed: number;
  failed: number;
  cost_so_far_usd: number;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  current_record_id?: string;
  /** Pending queue tail — survives so a Resume can pick it up. */
  remaining: QueueItem[];
  /** Last error message when status = failed. */
  last_error?: string;
}

async function writeState(state: RegenState): Promise<void> {
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function sse(type: string, data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handler(req: NextRequest) {
  let actor;
  try {
    actor = await getActor(req);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }
  if (actor.role !== "Admin") {
    return NextResponse.json({ error: "Admin role required to run bulk regeneration" }, { status: 403 });
  }

  let body: RegenBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const queue = Array.isArray(body.queue) ? body.queue : [];
  const costCap = typeof body.cost_cap_usd === "number" && body.cost_cap_usd > 0 ? body.cost_cap_usd : 5;
  const clientPromptVersion = typeof body.prompt_version === "number" ? body.prompt_version : null;
  if (queue.length === 0) {
    return NextResponse.json({ error: "queue must contain at least one record" }, { status: 400 });
  }

  const prompt = await getCurrentPrompt();
  if (clientPromptVersion !== null && clientPromptVersion !== prompt.version) {
    return NextResponse.json({ error: `Prompt version drifted (client v${clientPromptVersion}, server v${prompt.version}). Reload and try again.`, code: "prompt_version_mismatch" }, { status: 409 });
  }

  const rid = req.headers.get("x-request-id") ?? "n/a";
  const jobId = `regen-${Date.now()}`;

  const state: RegenState = {
    job_id: jobId,
    status: "running",
    prompt_version: prompt.version,
    cost_cap_usd: costCap,
    total: queue.length,
    processed: 0,
    failed: 0,
    cost_so_far_usd: 0,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    remaining: [...queue],
  };
  await writeState(state);

  serverLog("info", "ext:summary-regen", "starting", { rid, job_id: jobId, total: queue.length, cost_cap_usd: costCap, prompt_version: prompt.version });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = (type: string, data: Record<string, unknown>) => {
        try {
          controller.enqueue(sse(type, data));
        } catch {
          // controller closed (client cancelled) — surface via state
        }
      };

      enc("started", { total: queue.length, cost_cap_usd: costCap, prompt_version: prompt.version });

      let cancelled = false;
      // The Web Streams controller signals client disconnect through its
      // own abort; we also accept the AbortSignal from the request.
      req.signal.addEventListener("abort", () => { cancelled = true; });

      for (let i = 0; i < queue.length; i++) {
        if (cancelled) {
          state.status = "cancelled";
          state.updated_at = new Date().toISOString();
          await writeState(state);
          enc("paused", { reason: "cancelled", cost_so_far_usd: state.cost_so_far_usd });
          break;
        }
        // Cost cap: stop BEFORE running the next record if doing so would
        // push us past the cap. Avoids "one record put us $4 over".
        const item = queue[i];
        if (state.cost_so_far_usd + item.estimated_cost_usd > costCap) {
          state.status = "paused";
          state.updated_at = new Date().toISOString();
          await writeState(state);
          enc("paused", { reason: "cost_cap", cost_so_far_usd: state.cost_so_far_usd, cost_cap_usd: costCap });
          break;
        }

        state.current_record_id = item.record_id;
        state.updated_at = new Date().toISOString();
        await writeState(state);

        try {
          const result = await generateRecordSummary(
            { record_id: item.record_id, title: item.title, source_platform: item.source_platform, source_id: item.source_id, recorded_at: item.recorded_at },
            { rid, prompt },
          );
          state.processed++;
          state.cost_so_far_usd += item.estimated_cost_usd;
          state.remaining = queue.slice(i + 1);
          state.updated_at = new Date().toISOString();
          await writeState(state);
          enc("record_done", {
            record_id: item.record_id,
            title: item.title,
            doc_id: result.doc_id,
            doc_url: result.doc_url,
            counts: result.counts,
            prompt_version: result.prompt_version,
            generated_at: result.generated_at,
            cost_so_far_usd: state.cost_so_far_usd,
            index: i,
          });
        } catch (err) {
          state.failed++;
          state.updated_at = new Date().toISOString();
          await writeState(state);
          const message = err instanceof GenerateError ? err.message : (err instanceof Error ? err.message : String(err));
          enc("record_failed", { record_id: item.record_id, title: item.title, error: message, index: i });
          serverLog("warn", "ext:summary-regen", "record failed", { rid, record_id: item.record_id, error: message });
        }
      }

      if (state.status === "running") {
        state.status = "complete";
        state.completed_at = new Date().toISOString();
        state.updated_at = state.completed_at;
        state.current_record_id = undefined;
        state.remaining = [];
        await writeState(state);
        enc("complete", { processed: state.processed, failed: state.failed, cost_so_far_usd: state.cost_so_far_usd });
        serverLog("info", "ext:summary-regen", "complete", { rid, job_id: jobId, processed: state.processed, failed: state.failed, cost_so_far_usd: state.cost_so_far_usd });
      }

      try { controller.close(); } catch { /* already closed */ }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export const POST = withRequestLogging("api:summary/regen", handler);

// GET — return current job state so the panel can show progress on reload.
async function getHandler() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    return new NextResponse(raw, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "idle" });
  }
}
export const GET = withRequestLogging("api:summary/regen", getHandler);

// Keep helper reference so estimatePerRecordCost isn't tree-shaken from
// this route's transitive imports during edge bundling.
void estimatePerRecordCost;
