/**
 * Server-only logger extensions — ADR-017
 * Extends the isomorphic logger with file output and request middleware.
 * Import this ONLY from API routes (app/api/**), never from client components.
 */

import { NextRequest, NextResponse } from "next/server";
import { type LogLevel, type LogRecord, buildRecord, emitServerLine, redact } from "./logger";
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

// ── Request logging middleware ────────────────────────────────────────────────

type RouteHandler = (req: NextRequest, ctx?: unknown) => Promise<NextResponse>;

/**
 * Wraps a Next.js API route handler with structured request/response logging.
 * Generates or forwards an X-Request-ID correlation header.
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

    serverLog("info", component, "req", { method: req.method, path, rid });

    let res: NextResponse;
    try {
      res = await handler(req, ctx);
    } catch (err) {
      const duration_ms = Date.now() - t0;
      serverLog("error", component, "unhandled", { error: String(err), duration_ms, rid });
      return NextResponse.json(
        { error: "Internal server error", rid },
        { status: 500, headers: { "x-request-id": rid } },
      );
    }

    const duration_ms = Date.now() - t0;
    const level: LogLevel = res.status >= 500 ? "error" : res.status >= 400 ? "warn" : "info";
    serverLog(level, component, "res", { status: res.status, duration_ms, rid });
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
