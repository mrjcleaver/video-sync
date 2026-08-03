/**
 * ADR-066 — MCP (Model Context Protocol) server for video-sync.
 *
 * Implements the JSON-RPC method surface an MCP client expects,
 * scoped to the caller's role from ADR-036 + ADR-065. Transport is
 * plain HTTP request/response — Streamable HTTP without the SSE
 * stream, which is a valid subset the current spec calls out for
 * stateless request/response flows.
 *
 * Methods implemented:
 *   initialize                — handshake + capability advertisement
 *   notifications/initialized — no-op ack
 *   ping                       — health
 *   resources/list             — Show Notes + descriptions per catalog record (role-scoped)
 *   resources/read             — fetch a resource's content
 *   tools/list                 — advertise the six tools ADR-066 §3 defined
 *   tools/call                 — dispatch to the tool implementation
 *
 * Notification frames (no `id` on the request) return no body.
 */

import { readCatalog } from "../app/api/catalog/route";
import { getDrive } from "./drive";
import type { Actor } from "./types/actor";
import type { VideoRecordJSON } from "./wasm";
import { serverLog } from "./serverLogger";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "video-sync";
const SERVER_VERSION = process.env.NEXT_PUBLIC_BUILD_SHA ?? "0.2.0";

const CATALOG_DEEP_LINK_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://video-sync.agentics.org";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponseOk {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export interface JsonRpcResponseError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcResponseOk | JsonRpcResponseError;

// JSON-RPC 2.0 standard error codes.
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

function ok(id: number | string, result: unknown): JsonRpcResponseOk {
  return { jsonrpc: "2.0", id, result };
}
function err(id: number | string | null, code: number, message: string, data?: unknown): JsonRpcResponseError {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

/** Load the record list an actor is allowed to see, mirroring the
 *  role-scoped view /api/catalog GET applies. */
async function loadVisibleRecords(actor: Actor): Promise<VideoRecordJSON[]> {
  const store = await readCatalog();
  const out: VideoRecordJSON[] = [];
  for (const json of Object.values(store.records)) {
    try {
      const rec = JSON.parse(json) as VideoRecordJSON;
      if (actor.role === "Contributor") {
        if (rec.contributor_email !== actor.email) continue;
      }
      out.push(rec);
    } catch { /* skip malformed */ }
  }
  return out;
}

async function readShowNotesMarkdown(docId: string): Promise<string | null> {
  try {
    const drive = getDrive();
    // Prefer markdown export; fall back to plain text if Drive doesn't
    // offer markdown for this file (older docs).
    const md = await drive.files.export({ fileId: docId, mimeType: "text/markdown" });
    if (typeof md.data === "string" && md.data.length > 0) return md.data;
  } catch { /* fall through */ }
  try {
    const drive = getDrive();
    const txt = await drive.files.export({ fileId: docId, mimeType: "text/plain" });
    if (typeof txt.data === "string" && txt.data.length > 0) return txt.data;
  } catch { /* fall through */ }
  return null;
}

// ── Resource URI helpers ────────────────────────────────────────

function showNotesUri(id: string) { return `vsync://records/${id}/show-notes`; }
function descriptionUri(id: string) { return `vsync://records/${id}/description`; }
function parseVsyncUri(uri: string): { record_id: string; kind: "show-notes" | "description" } | null {
  const m = uri.match(/^vsync:\/\/records\/([0-9a-f-]+)\/(show-notes|description)$/i);
  if (!m) return null;
  return { record_id: m[1], kind: m[2] as "show-notes" | "description" };
}

// ── Method: initialize ──────────────────────────────────────────

function methodInitialize() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      resources: { listChanged: false, subscribe: false },
      tools: { listChanged: false },
      logging: {},
    },
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    instructions:
      "video-sync exposes curated Show Notes (chapter-oriented markdown breakdowns of recorded sessions), " +
      "plain-text descriptions, transcripts, and provenance. Use `search_records` to find records by title / " +
      "date / series; `search_chapter_moments` to search chapter-level bullets across every Show Notes doc " +
      "with time-linked deep-links; `get_show_notes` / `get_transcript` to pull specific content. Every record " +
      "resource follows the URI shape `vsync://records/<id>/{show-notes,description}`.",
  };
}

// ── Method: resources/list ──────────────────────────────────────

async function methodResourcesList(actor: Actor) {
  const records = await loadVisibleRecords(actor);
  const resources: Array<{ uri: string; name: string; description?: string; mimeType: string }> = [];
  for (const r of records) {
    if (r.source_platform === "OpusClip") continue;   // clips excluded — not a session
    const dateStr = r.recorded_at
      ? new Date(r.recorded_at).toISOString().slice(0, 10)
      : "unknown-date";
    const durationMin = Math.round((r.duration_seconds ?? 0) / 60);
    const meta = `${dateStr} · ${durationMin}min · ${r.source_platform}`;
    if (r.summary_doc_id) {
      resources.push({
        uri: showNotesUri(r.id),
        name: `${r.title} — Show Notes`,
        description: `${meta}${r.summary_prompt_version ? ` · prompt v${r.summary_prompt_version}` : ""}`,
        mimeType: "text/markdown",
      });
    }
    if (r.description) {
      resources.push({
        uri: descriptionUri(r.id),
        name: `${r.title} — Description`,
        description: meta,
        mimeType: "text/plain",
      });
    }
  }
  return { resources };
}

// ── Method: resources/read ──────────────────────────────────────

async function methodResourcesRead(actor: Actor, params: unknown) {
  const { uri } = (params ?? {}) as { uri?: string };
  if (typeof uri !== "string") throw new McpError(ERR_INVALID_PARAMS, "uri required");
  const parsed = parseVsyncUri(uri);
  if (!parsed) throw new McpError(ERR_INVALID_PARAMS, `unrecognised uri: ${uri}`);
  const records = await loadVisibleRecords(actor);
  const rec = records.find(r => r.id === parsed.record_id);
  if (!rec) throw new McpError(ERR_INVALID_PARAMS, "record not found (or not visible to your role)");
  if (parsed.kind === "show-notes") {
    if (!rec.summary_doc_id) throw new McpError(ERR_INVALID_PARAMS, "record has no Show Notes yet");
    const md = await readShowNotesMarkdown(rec.summary_doc_id);
    if (!md) throw new McpError(ERR_INTERNAL, "Drive export failed for Show Notes doc");
    return {
      contents: [{ uri, mimeType: "text/markdown", text: md }],
    };
  }
  // description
  return {
    contents: [{ uri, mimeType: "text/plain", text: rec.description ?? "" }],
  };
}

// ── Method: tools/list ──────────────────────────────────────────

const TOOLS = [
  {
    name: "list_series",
    description: "Enumerate the series in the registry (name, pattern, Discord channel, schedule fields).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_records",
    description:
      "Full-text search across catalog records (title / description / participants / tags). " +
      "Returns record ids + titles + dates + Show Notes availability + a deep-link to the record's card.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match, case-insensitive." },
        from: { type: "string", description: "ISO date lower bound (inclusive). Optional." },
        to: { type: "string", description: "ISO date upper bound (inclusive). Optional." },
        series: { type: "string", description: "Restrict to a series name (matches series_name from list_series). Optional." },
        limit: { type: "number", description: "Max results; default 25, cap 100." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_show_notes",
    description: "Return the Show Notes markdown for a specific record id. Same content as the vsync://records/<id>/show-notes resource.",
    inputSchema: {
      type: "object",
      properties: { record_id: { type: "string" } },
      required: ["record_id"],
    },
  },
  {
    name: "get_transcript",
    description:
      "Return the transcript for a specific record. When `trim` is true (default), pre/post-show " +
      "content outside the scheduled window is dropped.",
    inputSchema: {
      type: "object",
      properties: {
        record_id: { type: "string" },
        trim: { type: "boolean", description: "Apply ADR-060 pre/post-show trim before returning. Default true." },
      },
      required: ["record_id"],
    },
  },
  {
    name: "get_provenance",
    description: "Return upstream_links, locations, and (when applicable) broadcast-pair siblings for a record.",
    inputSchema: {
      type: "object",
      properties: { record_id: { type: "string" } },
      required: ["record_id"],
    },
  },
  {
    name: "search_chapter_moments",
    description:
      "Search bullet-level `[HH:MM:SS] Text` lines across every Show Notes doc. Returns tuples of " +
      "{record_id, title, timestamp, text, chapter_title, deep_link} so a client can cite specific moments.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        limit: { type: "number", description: "Max results; default 25, cap 100." },
      },
      required: ["query"],
    },
  },
] as const;

function methodToolsList() {
  return { tools: TOOLS };
}

// ── Method: tools/call ──────────────────────────────────────────

async function methodToolsCall(actor: Actor, params: unknown) {
  const { name, arguments: args } = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  if (typeof name !== "string") throw new McpError(ERR_INVALID_PARAMS, "name required");
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "list_series":       return toolListSeries();
    case "search_records":    return toolSearchRecords(actor, a);
    case "get_show_notes":    return toolGetShowNotes(actor, a);
    case "get_transcript":    return toolGetTranscript(actor, a);
    case "get_provenance":    return toolGetProvenance(actor, a);
    case "search_chapter_moments": return toolSearchChapterMoments(actor, a);
    default:
      throw new McpError(ERR_METHOD_NOT_FOUND, `unknown tool: ${name}`);
  }
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function readSeriesRegistry(): Promise<Array<{ series_name: string; pattern: string; discord_channel?: string; scheduled_start_local?: string; scheduled_end_local?: string; scheduled_timezone?: string }>> {
  const { promises: fs } = await import("fs");
  const path = await import("path");
  try {
    const raw = await fs.readFile(path.join(process.cwd(), "data", "series-registry.json"), "utf-8");
    const parsed = JSON.parse(raw) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? (parsed.entries as never) : [];
  } catch { return []; }
}

async function toolListSeries() {
  const entries = await readSeriesRegistry();
  return textResult(JSON.stringify({ series: entries }, null, 2));
}

async function toolSearchRecords(actor: Actor, args: Record<string, unknown>) {
  const query = String(args.query ?? "").trim().toLowerCase();
  if (!query) throw new McpError(ERR_INVALID_PARAMS, "query required");
  const from = typeof args.from === "string" ? args.from : null;
  const to = typeof args.to === "string" ? args.to : null;
  const series = typeof args.series === "string" ? args.series : null;
  const limit = Math.min(100, Math.max(1, Number(args.limit ?? 25) | 0));

  const records = await loadVisibleRecords(actor);
  const seriesReg = series ? await readSeriesRegistry() : [];
  const seriesPattern = series
    ? (() => {
        const entry = seriesReg.find(e => e.series_name === series);
        if (!entry) return null;
        try { return new RegExp(entry.pattern, "i"); } catch { return null; }
      })()
    : null;

  const hits: Array<{ id: string; title: string; recorded_at: string | null; source_platform: string; source_id: string; has_show_notes: boolean; deep_link: string }> = [];
  for (const r of records) {
    if (r.source_platform === "OpusClip") continue;
    if (from && r.recorded_at && r.recorded_at < from) continue;
    if (to && r.recorded_at && r.recorded_at > to + "T23:59:59Z") continue;
    if (seriesPattern && !seriesPattern.test(r.title)) continue;
    const hay = [
      r.title, r.description ?? "",
      ...(r.participants ?? []),
      ...(r.tags ?? []),
    ].join(" ").toLowerCase();
    if (!hay.includes(query)) continue;
    hits.push({
      id: r.id,
      title: r.title,
      recorded_at: r.recorded_at ?? null,
      source_platform: r.source_platform,
      source_id: r.source_id,
      has_show_notes: !!r.summary_doc_id,
      deep_link: `${CATALOG_DEEP_LINK_ORIGIN}/catalog?just=${r.id}`,
    });
    if (hits.length >= limit) break;
  }
  return textResult(JSON.stringify({ query, count: hits.length, results: hits }, null, 2));
}

async function toolGetShowNotes(actor: Actor, args: Record<string, unknown>) {
  const id = String(args.record_id ?? "");
  const records = await loadVisibleRecords(actor);
  const rec = records.find(r => r.id === id);
  if (!rec) throw new McpError(ERR_INVALID_PARAMS, "record not found (or not visible to your role)");
  if (!rec.summary_doc_id) return textResult("(no Show Notes yet for this record)", true);
  const md = await readShowNotesMarkdown(rec.summary_doc_id);
  if (!md) throw new McpError(ERR_INTERNAL, "Drive export failed");
  return textResult(md);
}

async function toolGetTranscript(actor: Actor, args: Record<string, unknown>) {
  const id = String(args.record_id ?? "");
  const records = await loadVisibleRecords(actor);
  const rec = records.find(r => r.id === id);
  if (!rec) throw new McpError(ERR_INVALID_PARAMS, "record not found (or not visible to your role)");
  const tx = rec.transcript_text ?? "";
  if (!tx) return textResult("(no transcript on this record)", true);
  return textResult(tx);
}

async function toolGetProvenance(actor: Actor, args: Record<string, unknown>) {
  const id = String(args.record_id ?? "");
  const records = await loadVisibleRecords(actor);
  const rec = records.find(r => r.id === id);
  if (!rec) throw new McpError(ERR_INVALID_PARAMS, "record not found (or not visible to your role)");
  return textResult(JSON.stringify({
    id: rec.id,
    title: rec.title,
    source_platform: rec.source_platform,
    source_id: rec.source_id,
    recorded_at: rec.recorded_at,
    locations: rec.locations ?? [],
    upstream_links: rec.upstream_links ?? [],
    contributor_email: rec.contributor_email ?? null,
    contributor_chapter: rec.contributor_chapter ?? null,
    deep_link: `${CATALOG_DEEP_LINK_ORIGIN}/catalog?just=${rec.id}`,
  }, null, 2));
}

async function toolSearchChapterMoments(actor: Actor, args: Record<string, unknown>) {
  const query = String(args.query ?? "").trim().toLowerCase();
  if (!query) throw new McpError(ERR_INVALID_PARAMS, "query required");
  const from = typeof args.from === "string" ? args.from : null;
  const to = typeof args.to === "string" ? args.to : null;
  const limit = Math.min(100, Math.max(1, Number(args.limit ?? 25) | 0));

  const records = await loadVisibleRecords(actor);
  const hits: Array<{ record_id: string; title: string; recorded_at: string | null; chapter_title: string | null; timestamp: string; seconds: number; text: string; deep_link: string }> = [];
  for (const r of records) {
    if (!r.summary_doc_id) continue;
    if (r.source_platform === "OpusClip") continue;
    if (from && r.recorded_at && r.recorded_at < from) continue;
    if (to && r.recorded_at && r.recorded_at > to + "T23:59:59Z") continue;
    const md = await readShowNotesMarkdown(r.summary_doc_id);
    if (!md) continue;
    let currentChapter: string | null = null;
    for (const rawLine of md.split("\n")) {
      const line = rawLine.trim();
      const chapM = line.match(/^#{1,4}\s+(.+)$/);
      if (chapM) {
        // Only track LEVEL 2 (chapter) headings — skip Key Moments etc.
        if (rawLine.startsWith("## ")) currentChapter = chapM[1];
        continue;
      }
      // Bullet with [HH:MM:SS] marker
      const bul = line.match(/^\s*(?:[-*+]|\d+\.)\s+\\?\[(\d{1,2}):(\d{2})(?::(\d{2}))?\\?\]\s*(.*)$/);
      if (!bul) continue;
      const text = bul[4].trim();
      if (!text.toLowerCase().includes(query)) continue;
      const h = bul[3] !== undefined ? Number(bul[1]) : 0;
      const m = bul[3] !== undefined ? Number(bul[2]) : Number(bul[1]);
      const s = bul[3] !== undefined ? Number(bul[3]) : Number(bul[2]);
      const seconds = h * 3600 + m * 60 + s;
      const ts = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      // Deep link — prefer YouTube location for time-anchored jumps.
      const yt = (r.locations ?? []).find(l => l.platform === "YouTube" && l.external_id);
      const ytId = yt?.external_id?.replace(/^youtube-/, "") ?? null;
      const deep = ytId
        ? `https://www.youtube.com/watch?v=${ytId}&t=${seconds}s`
        : `${CATALOG_DEEP_LINK_ORIGIN}/catalog?just=${r.id}`;
      hits.push({
        record_id: r.id,
        title: r.title,
        recorded_at: r.recorded_at ?? null,
        chapter_title: currentChapter,
        timestamp: ts,
        seconds,
        text,
        deep_link: deep,
      });
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit) break;
  }
  return textResult(JSON.stringify({ query, count: hits.length, moments: hits }, null, 2));
}

// ── Dispatcher ──────────────────────────────────────────────────

export class McpError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

export async function handleMcpRpc(actor: Actor, req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  // Notifications: no id → no response.
  if (id === null) {
    serverLog("info", "mcp", "notification", { method: req.method, actor: actor.email });
    return null;
  }
  try {
    switch (req.method) {
      case "initialize":        return ok(id, methodInitialize());
      case "ping":               return ok(id, {});
      case "resources/list":    return ok(id, await methodResourcesList(actor));
      case "resources/read":    return ok(id, await methodResourcesRead(actor, req.params));
      case "tools/list":        return ok(id, methodToolsList());
      case "tools/call":        return ok(id, await methodToolsCall(actor, req.params));
      default:
        return err(id, ERR_METHOD_NOT_FOUND, `Method not found: ${req.method}`);
    }
  } catch (e) {
    if (e instanceof McpError) return err(id, e.code, e.message, e.data);
    serverLog("error", "mcp", "internal error", { method: req.method, error: e instanceof Error ? e.message : String(e) });
    return err(id, ERR_INTERNAL, e instanceof Error ? e.message : String(e));
  }
}

export function parseJsonRpc(body: unknown): { ok: true; req: JsonRpcRequest } | { ok: false; response: JsonRpcResponseError } {
  if (!body || typeof body !== "object") {
    return { ok: false, response: err(null, ERR_PARSE, "invalid JSON body") };
  }
  const b = body as Record<string, unknown>;
  if (b.jsonrpc !== "2.0" || typeof b.method !== "string") {
    return { ok: false, response: err((b.id as number | string | null) ?? null, ERR_INVALID_REQUEST, "invalid JSON-RPC request") };
  }
  return { ok: true, req: b as unknown as JsonRpcRequest };
}
