/**
 * Server-only logger extensions — ADR-017
 * Extends the isomorphic logger with file output and request middleware.
 * Import this ONLY from API routes (app/api/**), never from client components.
 */

import { NextRequest, NextResponse } from "next/server";
import { type LogLevel, type LogRecord, buildRecord, emitServerLine, redact } from "./logger";
import { getActor } from "./auth";
import { join } from "path";
import { appendFileSync, mkdirSync } from "fs";

const LOG_FILE = join(process.cwd(), "data", "server.log");
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
let _dirEnsured = false;

function writeToFile(line: string) {
  try {
    if (!_dirEnsured) {
      mkdirSync(join(process.cwd(), "data"), { recursive: true });
      _dirEnsured = true;
    }
    appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch {
    // Never crash the app due to a log write failure
  }
}

function maybeRotate() {
  try {
    const { statSync, renameSync } = require("fs") as typeof import("fs");
    const stat = statSync(LOG_FILE, { throwIfNoEntry: false });
    if (stat && stat.size > MAX_FILE_BYTES) {
      renameSync(LOG_FILE, LOG_FILE + ".1");
    }
  } catch { /* swallow */ }
}

let _rotateCheck = 0;

/**
 * Primary server-side log function. Writes JSON to stdout + disk file.
 */
export function serverLog(
  level: LogLevel,
  component: string,
  msg: string,
  fields: Omit<LogRecord, "ts" | "level" | "component" | "msg"> = {},
) {
  const record = buildRecord(level, component, msg, fields);
  emitServerLine(record);
  const line = JSON.stringify(record);
  if (++_rotateCheck % 200 === 0) maybeRotate();
  writeToFile(line);
}

// ── In-memory audit ring buffer (ADR-041) ────────────────────────────────────

export interface AuditEvent {
  id: string;             // monotonic per-instance id (ts-counter)
  ts: string;             // ISO timestamp of the response
  actor_email: string | null;
  actor_role: string | null;
  actor_error: string | null;
  audit: "access" | "mutation";
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  rid: string;
}

const AUDIT_BUFFER_MAX = 500;
const recentAudit: AuditEvent[] = [];
let _auditSeq = 0;

// Persistence — write the ring to FUSE periodically so a Cloud Run
// cold start / redeploy doesn't wipe it. File is small (~500 events *
// ~250 bytes ≈ 125KB), FUSE write is a few hundred ms; do it on a
// debounced timer, not per-event.
let _auditDirty = false;
let _auditFlushTimer: ReturnType<typeof setTimeout> | null = null;
const AUDIT_FLUSH_DEBOUNCE_MS = 3000;
const AUDIT_FILE = process.cwd() + "/data/audit-recent.json";

async function loadAuditFromDisk(): Promise<void> {
  try {
    const { promises: fs } = await import("fs");
    const raw = await fs.readFile(AUDIT_FILE, "utf-8");
    const parsed = JSON.parse(raw) as AuditEvent[];
    if (Array.isArray(parsed)) {
      recentAudit.push(...parsed.slice(-AUDIT_BUFFER_MAX));
    }
  } catch { /* first run: file absent, nothing to load */ }
}

async function flushAuditToDisk(): Promise<void> {
  if (!_auditDirty) return;
  _auditDirty = false;
  try {
    const { promises: fs } = await import("fs");
    const path = await import("path");
    await fs.mkdir(path.dirname(AUDIT_FILE), { recursive: true });
    await fs.writeFile(AUDIT_FILE, JSON.stringify(recentAudit), "utf-8");
  } catch { /* FUSE hiccup — retry on next dirty flag */ }
}

function scheduleAuditFlush(): void {
  _auditDirty = true;
  if (_auditFlushTimer) return;
  _auditFlushTimer = setTimeout(() => {
    _auditFlushTimer = null;
    void flushAuditToDisk();
  }, AUDIT_FLUSH_DEBOUNCE_MS);
}

// Fire-and-forget load on module init — the ring re-populates from
// disk within a few ms of the container starting.
let _auditHydrated = false;
function ensureAuditHydrated(): void {
  if (_auditHydrated) return;
  _auditHydrated = true;
  void loadAuditFromDisk();
}

function pushAudit(entry: Omit<AuditEvent, "id" | "ts">): void {
  // Skip the polling endpoint to prevent feedback noise — every poll
  // would otherwise immediately re-appear in the next poll.
  if (entry.path === "/api/audit/recent") return;
  ensureAuditHydrated();
  const event: AuditEvent = {
    ...entry,
    id: `${Date.now()}-${++_auditSeq}`,
    ts: new Date().toISOString(),
  };
  recentAudit.push(event);
  if (recentAudit.length > AUDIT_BUFFER_MAX) {
    recentAudit.splice(0, recentAudit.length - AUDIT_BUFFER_MAX);
  }
  scheduleAuditFlush();
}

/**
 * Read recent audit events. `sinceIso` filters to events strictly later
 * than the given ISO timestamp (used by the client poll to dedupe).
 * Without `sinceIso` returns the last `limit` entries.
 *
 * Buffer is per-Cloud-Run-instance; multi-instance deployments will
 * have per-instance views. ADR-041 §risks documents this.
 */
export function getRecentAudit(sinceIso?: string, limit = 100): AuditEvent[] {
  if (sinceIso) {
    return recentAudit.filter(e => e.ts > sinceIso);
  }
  return recentAudit.slice(-limit);
}

// ── Request logging middleware ────────────────────────────────────────────────

type RouteHandler = (req: NextRequest, ctx?: unknown) => Promise<NextResponse>;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Best-effort actor resolution for audit logging. Doesn't throw — the
 * wrapper logs the request even when auth is missing/invalid (those
 * become explicit `actor_error` entries, which IS the access-attempt
 * audit trail for unauthenticated requests).
 */
async function resolveActorForAudit(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const actor = await getActor(req);
    // ADR-076 §8.b — machine tokens carry a `token_name` that we want
    // in the audit log INSTEAD of the token-minter's email. The
    // internal actor_email is retained under actor_owner_email so
    // revocation flows still tie a token back to who minted it.
    const isMachine = !!actor.token_name;
    return {
      actor_display: isMachine ? actor.token_name : actor.email,
      actor_role: actor.role,
      actor_user_id: actor.user_id,
      // Keep actor_email pointing at the audit-primary identity.
      // For humans: their own email. For machine tokens: the token
      // name. This preserves grep-ability of "who did this" without
      // per-consumer log-parser changes on our side.
      actor_email: isMachine ? actor.token_name : actor.email,
      ...(isMachine ? { actor_owner_email: actor.email } : {}),
      // ADR-076 §8.c — free-text consumer attribution label.
      ...(actor.consumer_ua ? { consumer_ua: actor.consumer_ua } : {}),
    };
  } catch (err) {
    return { actor_error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Wraps a Next.js API route handler with structured request/response logging.
 * Generates or forwards an X-Request-ID correlation header.
 *
 * Each request emits two log lines (req + res). Both carry:
 *   - audit: "access" (GET/HEAD/OPTIONS) or "mutation" (POST/PUT/PATCH/DELETE)
 *   - actor_email / actor_role / actor_user_id  when IAP-authenticated
 *   - actor_error                                when unauthenticated/invalid
 *
 * Filter the structured log stream:
 *   `audit=mutation`  → who-did-what trail for state-changing ops
 *   `audit=access`    → who-read-what trail
 *   `actor_error`     → unauthenticated access attempts
 *
 * Usage:
 *   async function handler(req) { ... }
 *   export const POST = withRequestLogging("api:zoom/recordings", handler);
 */
export function withRequestLogging(component: string, handler: RouteHandler): RouteHandler {
  return async (req, ctx) => {
    const rid = req.headers.get("x-request-id") ?? crypto.randomUUID().slice(0, 8);
    const t0 = Date.now();
    const path = new URL(req.url).pathname;
    const audit = MUTATING_METHODS.has(req.method.toUpperCase()) ? "mutation" : "access";
    const actorFields = await resolveActorForAudit(req);

    serverLog("info", component, "req", { method: req.method, path, rid, audit, ...actorFields });

    let res: NextResponse;
    try {
      res = await handler(req, ctx);
    } catch (err) {
      const duration_ms = Date.now() - t0;
      serverLog("error", component, "unhandled", { error: String(err), duration_ms, rid, audit, ...actorFields });
      return NextResponse.json(
        { error: "Internal server error", rid },
        { status: 500, headers: { "x-request-id": rid } },
      );
    }

    const duration_ms = Date.now() - t0;
    const level: LogLevel = res.status >= 500 ? "error" : res.status >= 400 ? "warn" : "info";
    serverLog(level, component, "res", { status: res.status, duration_ms, rid, audit, ...actorFields });
    pushAudit({
      actor_email: (actorFields.actor_email as string | undefined) ?? null,
      actor_role: (actorFields.actor_role as string | undefined) ?? null,
      actor_error: (actorFields.actor_error as string | undefined) ?? null,
      audit,
      method: req.method,
      path,
      status: res.status,
      duration_ms,
      rid,
    });
    res.headers.set("x-request-id", rid);
    return res;
  };
}

// ── External API call timer ───────────────────────────────────────────────────

/**
 * Wraps an async fetch-like call with timing + structured logging.
 * Logs info on success, error on failure (and re-throws).
 *
 * Usage:
 *   const data = await timedFetch("ext:zoom-token", rid, () => fetch(...));
 */
export async function timedFetch<T>(
  component: string,
  rid: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    serverLog("info", component, label, { duration_ms: Date.now() - t0, rid });
    return result;
  } catch (err) {
    serverLog("error", component, label, { error: String(err), duration_ms: Date.now() - t0, rid });
    throw err;
  }
}

/** Re-export redact for use in routes that need to log request bodies safely. */
export { redact };
