/**
 * ADR-071 §3 — in-memory Drive ingest job registry.
 *
 * Shared between /api/drive/ingest (writer) and /api/drive/status
 * (reader). Small and process-local: on a Cloud Run cold start the
 * map empties; that's fine because the record itself (and the
 * partially-written file on FUSE) survive the restart, and a client
 * missing its poll gets a "no such job" response and can trigger a
 * re-ingest (idempotent — the FUSE file gets overwritten).
 */

export type DriveIngestState = "starting" | "copying" | "complete" | "failed";

export interface DriveIngestJob {
  record_id: string;
  file_id: string;
  ext: string;
  mime_type: string;
  state: DriveIngestState;
  bytes_copied: number;
  bytes_total: number | null;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
  error: string | null;
}

const jobs = new Map<string, DriveIngestJob>();

export function beginJob(init: Omit<DriveIngestJob, "state" | "bytes_copied" | "started_at" | "updated_at" | "finished_at" | "error">): DriveIngestJob {
  const existing = jobs.get(init.record_id);
  if (existing && (existing.state === "starting" || existing.state === "copying")) {
    throw new IngestAlreadyRunning(existing);
  }
  const now = Date.now();
  const job: DriveIngestJob = {
    ...init,
    state: "starting",
    bytes_copied: 0,
    started_at: now,
    updated_at: now,
    finished_at: null,
    error: null,
  };
  jobs.set(init.record_id, job);
  return job;
}

export function markCopying(record_id: string): void {
  const job = jobs.get(record_id);
  if (!job) return;
  job.state = "copying";
  job.updated_at = Date.now();
}

export function reportProgress(record_id: string, bytes_copied: number): void {
  const job = jobs.get(record_id);
  if (!job) return;
  job.bytes_copied = bytes_copied;
  job.updated_at = Date.now();
}

export function finishJob(record_id: string, ok: true): void;
export function finishJob(record_id: string, ok: false, error: string): void;
export function finishJob(record_id: string, ok: boolean, error?: string): void {
  const job = jobs.get(record_id);
  if (!job) return;
  job.state = ok ? "complete" : "failed";
  job.finished_at = Date.now();
  job.updated_at = job.finished_at;
  job.error = ok ? null : error ?? "unknown error";
}

export function getJob(record_id: string): DriveIngestJob | null {
  return jobs.get(record_id) ?? null;
}

export class IngestAlreadyRunning extends Error {
  constructor(public job: DriveIngestJob) {
    super(`ingest already running for ${job.record_id}`);
    this.name = "IngestAlreadyRunning";
  }
}
