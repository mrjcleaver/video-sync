/**
 * Isomorphic structured logger — ADR-017
 *
 * Browser: appends JSON records to localStorage circular buffer + console.
 * Server:  writes JSON lines to stdout (captured by process supervisor).
 *          File output is handled by serverLogger.ts.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  rid?: string;
  duration_ms?: number;
  status?: number;
  video_id?: string;
  platform?: string;
  count?: number;
  error?: string;
  [key: string]: unknown;
}

export const EVENTLOG_KEY = "video-sync:eventlog";
const MAX_ENTRIES = 500;

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function minLevel(): LogLevel {
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "production") return "info";
  return "debug";
}

// ── PII redaction ─────────────────────────────────────────────────────────────

const REDACT_KEYS = new Set([
  "apiKey", "refreshToken", "clientSecret", "access_token",
  "password", "authorization", "basicAuth", "token",
  // ADR-036: identity claims must not appear in structured logs
  "email", "sub",
  "x-goog-iap-jwt-assertion",
  "iapJwt", "jwt",
]);

const REDACT_VALUE_PATTERNS = [
  /^sk-[a-zA-Z0-9\-_]{10,}/,       // OpenRouter/OpenAI keys
  /^[A-Za-z0-9+/]{40,}={0,2}$/,    // long base64 tokens
  /^ya29\./,                         // Google access tokens
  /^eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\./,  // JWT shape (header.payload.sig)
];

export function redact(obj: unknown, depth = 0): unknown {
  if (depth > 6 || obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (REDACT_KEYS.has(k)) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "string" && REDACT_VALUE_PATTERNS.some((p) => p.test(v))) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

// ── Core build ────────────────────────────────────────────────────────────────

export function buildRecord(
  level: LogLevel,
  component: string,
  msg: string,
  fields: Omit<LogRecord, "ts" | "level" | "component" | "msg"> = {},
): LogRecord {
  const raw: LogRecord = { ts: new Date().toISOString(), level, component, msg, ...fields };
  return redact(raw) as LogRecord;
}

function consoleMethod(level: LogLevel) {
  if (level === "error") return console.error;
  if (level === "warn") return console.warn;
  if (level === "debug") return console.debug;
  return console.log;
}

// ── Browser client logger ─────────────────────────────────────────────────────

function isBrowser() {
  return typeof window !== "undefined";
}

/** Append a log record to the localStorage circular buffer. */
export function appendClientLog(record: LogRecord) {
  if (!isBrowser()) return;
  try {
    const raw = localStorage.getItem(EVENTLOG_KEY);
    const entries: LogRecord[] = raw ? (JSON.parse(raw) as LogRecord[]) : [];
    entries.push(record);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    localStorage.setItem(EVENTLOG_KEY, JSON.stringify(entries));
  } catch {
    // localStorage full or unavailable — swallow
  }
}

/** Load all stored log records from the browser buffer. */
export function loadClientLog(): LogRecord[] {
  if (!isBrowser()) return [];
  try {
    const raw = localStorage.getItem(EVENTLOG_KEY);
    return raw ? (JSON.parse(raw) as LogRecord[]) : [];
  } catch {
    return [];
  }
}

/** Clear the browser log buffer. */
export function clearClientLog() {
  if (!isBrowser()) return;
  try { localStorage.removeItem(EVENTLOG_KEY); } catch { /* swallow */ }
}

/**
 * Client-side log call. Safe to import in "use client" components.
 * Skips below minLevel. Writes to localStorage + console.
 */
export function clientLog(
  level: LogLevel,
  component: string,
  msg: string,
  fields: Omit<LogRecord, "ts" | "level" | "component" | "msg"> = {},
) {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel()]) return;
  const record = buildRecord(level, component, msg, fields);
  appendClientLog(record);
  const method = consoleMethod(level);
  if (process.env.NODE_ENV !== "production") {
    method(`[${record.level.toUpperCase()}] ${record.component}: ${record.msg}`, fields);
  }
}

// ── Server-side console logger (stdout JSON) ──────────────────────────────────
// File output is in serverLogger.ts to avoid importing 'fs' in browser bundles.

/**
 * Emit a JSON log line to stdout. Server-side only — do not call from client components.
 */
export function emitServerLine(record: LogRecord) {
  const line = JSON.stringify(record);
  if (process.env.NODE_ENV !== "production") {
    // Pretty in dev
    const method = consoleMethod(record.level);
    method(`[${record.level.toUpperCase()}] ${record.component}: ${record.msg}`, record);
  } else {
    process.stdout.write(line + "\n");
  }
}
