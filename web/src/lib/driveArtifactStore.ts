/**
 * Higher-level Drive artifact store for ADR-039.
 *
 * Resolves record_id → meeting folder → individual artifact files.
 * Caches:
 *   - record_id → folder_id (in-memory map, no expiry; folder ids don't change)
 *   - record_id → .meta.json (1 hour TTL)
 *   - (file_id, modifiedTime) → markdown body (LRU, 256 entries)
 *
 * Folder layout (per ADR-039):
 *   <root>/<YYYY>/<MM>/<YYYY-MM-DD>--<platform>-<source-id-12>-<title-32>/
 *     transcript.md, description.md, summary.md, chat.md, .meta.json
 */

import {
  findOrCreateFolder,
  findFile,
  findFolderByAppProperty,
  writeFile,
  writeGoogleDoc,
  readFile,
  deleteFile,
  getRootFolderId,
  getFolderWebUrl,
} from "./drive";
import { serverLog } from "./serverLogger";

export const ARTIFACT_KINDS = [
  "transcript",
  "description",
  "summary",
  "chat",
  // ADR-074 §1 — captured on every successful videos.update / .insert,
  // stored as JSON of the snippet body we PUT. Distinct from
  // `description` (local, editable) — this is the last-published copy.
  "youtube-snippet",
  // ADR-074 §3 — aggregated single-file view. Derived, regenerated on
  // material changes; not directly authored.
  "reference",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

const KIND_FILENAMES: Record<ArtifactKind, string> = {
  transcript: "transcript.md",
  description: "description.md",
  summary: "summary.md",
  chat: "chat.md",
  "youtube-snippet": "youtube-snippet.json",
  reference: "reference.md",
};

const META_FILENAME = ".meta.json";
const APP_KEY_RECORD_ID = "video_sync_record_id";

const META_TTL_MS = 60 * 60 * 1000; // 1 hour
const FILE_CACHE_MAX = 256;

export interface ArtifactEntry {
  drive_file_id: string;
  size: number;
  modified: string;
  drive_web_url?: string;
  /** ADR-046 — prompt version that authored this artifact (summary only). */
  prompt_version?: number;
  /** ADR-046 — when the summary was generated (ISO timestamp). */
  generated_at?: string;
}

export interface MetaJson {
  record_id: string;
  title: string;
  source_platform: string;
  source_id: string;
  recorded_at: string;
  folder_drive_id: string;
  folder_drive_web_url?: string;
  artifacts: Partial<Record<ArtifactKind, ArtifactEntry>>;
}

export interface RecordContext {
  record_id: string;
  title: string;
  source_platform: string;
  source_id: string;
  recorded_at: string; // ISO
}

const folderIdByRecord = new Map<string, string>();
const metaCache = new Map<string, { meta: MetaJson; cachedAt: number }>();
const fileContentCache = new Map<string, { content: string; modifiedTime: string }>();

function slugify(s: string, maxLen: number): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
}

function meetingFolderName(ctx: RecordContext): string {
  const date = ctx.recorded_at.slice(0, 10);
  const platform = ctx.source_platform.toLowerCase();
  const sourceShort = ctx.source_id.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12);
  const titleSlug = slugify(ctx.title, 32);
  return `${date}--${platform}-${sourceShort}-${titleSlug}`;
}

async function getOrCreateMeetingFolder(ctx: RecordContext): Promise<string> {
  const cached = folderIdByRecord.get(ctx.record_id);
  if (cached) return cached;

  // Canonical lookup by appProperty (set when we create the folder)
  const found = await findFolderByAppProperty(APP_KEY_RECORD_ID, ctx.record_id);
  if (found) {
    folderIdByRecord.set(ctx.record_id, found);
    return found;
  }

  const yyyy = ctx.recorded_at.slice(0, 4);
  const mm = ctx.recorded_at.slice(5, 7);
  const root = getRootFolderId();
  const yearId = await findOrCreateFolder(yyyy, root);
  const monthId = await findOrCreateFolder(mm, yearId);
  const meetingId = await findOrCreateFolder(meetingFolderName(ctx), monthId, {
    [APP_KEY_RECORD_ID]: ctx.record_id,
  });

  folderIdByRecord.set(ctx.record_id, meetingId);
  return meetingId;
}

async function readMeta(folderId: string): Promise<MetaJson | null> {
  const f = await findFile(META_FILENAME, folderId);
  if (!f) return null;
  try {
    const txt = await readFile(f.id);
    return JSON.parse(txt) as MetaJson;
  } catch (err) {
    serverLog("warn", "drive:meta", "failed to read .meta.json", { folderId, error: String(err) });
    return null;
  }
}

async function writeMeta(folderId: string, meta: MetaJson): Promise<void> {
  await writeFile(META_FILENAME, folderId, JSON.stringify(meta, null, 2), "application/json");
}

export async function getMeta(record_id: string): Promise<MetaJson | null> {
  const cached = metaCache.get(record_id);
  if (cached && Date.now() - cached.cachedAt < META_TTL_MS) return cached.meta;

  let folderId = folderIdByRecord.get(record_id);
  if (!folderId) {
    const found = await findFolderByAppProperty(APP_KEY_RECORD_ID, record_id);
    if (!found) return null;
    folderId = found;
    folderIdByRecord.set(record_id, folderId);
  }

  const meta = await readMeta(folderId);
  if (meta) metaCache.set(record_id, { meta, cachedAt: Date.now() });
  return meta;
}

function pruneFileCache(): void {
  if (fileContentCache.size <= FILE_CACHE_MAX) return;
  const keys = Array.from(fileContentCache.keys());
  for (let i = 0; i < keys.length - FILE_CACHE_MAX; i++) {
    fileContentCache.delete(keys[i]);
  }
}

/**
 * Read an artifact body. Returns null if the artifact doesn't exist on Drive.
 *
 * `forPublishPath`: pass true from publish/webhook code paths to bypass the
 * content cache. Per ADR-039 "out-of-band edits" guarantee — operator
 * edits in Drive must be picked up at publish time.
 */
export async function getArtifact(
  record_id: string,
  kind: ArtifactKind,
  opts: { forPublishPath?: boolean } = {},
): Promise<{ content: string; modified: string } | null> {
  const meta = await getMeta(record_id);
  if (!meta) return null;
  const entry = meta.artifacts[kind];
  if (!entry) return null;

  const cacheKey = `${entry.drive_file_id}|${entry.modified}`;
  if (!opts.forPublishPath) {
    const cached = fileContentCache.get(cacheKey);
    if (cached) return { content: cached.content, modified: cached.modifiedTime };
  }

  const content = await readFile(entry.drive_file_id);
  fileContentCache.set(cacheKey, { content, modifiedTime: entry.modified });
  pruneFileCache();
  return { content, modified: entry.modified };
}

export async function setArtifact(ctx: RecordContext, kind: ArtifactKind, content: string): Promise<ArtifactEntry> {
  const folderId = await getOrCreateMeetingFolder(ctx);
  // ADR-074 — youtube-snippet is JSON; every other kind is markdown.
  const mimeType = kind === "youtube-snippet" ? "application/json" : "text/markdown";
  const file = await writeFile(KIND_FILENAMES[kind], folderId, content, mimeType);

  let meta = await readMeta(folderId);
  if (!meta) {
    const folderUrl = await getFolderWebUrl(folderId).catch(() => undefined);
    meta = {
      record_id: ctx.record_id,
      title: ctx.title,
      source_platform: ctx.source_platform,
      source_id: ctx.source_id,
      recorded_at: ctx.recorded_at,
      folder_drive_id: folderId,
      folder_drive_web_url: folderUrl,
      artifacts: {},
    };
  }
  const entry: ArtifactEntry = {
    drive_file_id: file.id,
    size: file.size,
    modified: file.modifiedTime,
    drive_web_url: file.webViewLink,
  };
  meta.artifacts[kind] = entry;
  await writeMeta(folderId, meta);

  metaCache.delete(ctx.record_id);
  return entry;
}

/**
 * ADR-046 — write the summary as a NATIVE Google Doc (not markdown).
 * Drive converts the source markdown on upload so operators can edit
 * in Docs natively. Stores `prompt_version` and `generated_at` in the
 * file's `appProperties` for machine-readable provenance, and mirrors
 * them onto the meta.json artifact entry so a catalog scan can answer
 * "which prompt wrote this?" without fetching each file.
 *
 * The file is named "Summary" (no extension) so Drive uses its native
 * Google Doc icon. Idempotent on name — re-writes replace content.
 */
export async function setSummaryDoc(
  ctx: RecordContext,
  markdown: string,
  promptVersion: number,
  generatedAt: string = new Date().toISOString(),
): Promise<ArtifactEntry> {
  const folderId = await getOrCreateMeetingFolder(ctx);
  const file = await writeGoogleDoc("Summary", folderId, markdown, {
    kind: "summary",
    prompt_version: String(promptVersion),
    generated_at: generatedAt,
    record_id: ctx.record_id,
  });

  let meta = await readMeta(folderId);
  if (!meta) {
    const folderUrl = await getFolderWebUrl(folderId).catch(() => undefined);
    meta = {
      record_id: ctx.record_id,
      title: ctx.title,
      source_platform: ctx.source_platform,
      source_id: ctx.source_id,
      recorded_at: ctx.recorded_at,
      folder_drive_id: folderId,
      folder_drive_web_url: folderUrl,
      artifacts: {},
    };
  }
  const entry: ArtifactEntry = {
    drive_file_id: file.id,
    size: file.size,
    modified: file.modifiedTime,
    drive_web_url: file.webViewLink,
    prompt_version: promptVersion,
    generated_at: generatedAt,
  };
  meta.artifacts.summary = entry;
  await writeMeta(folderId, meta);

  metaCache.delete(ctx.record_id);
  return entry;
}

export async function deleteArtifact(record_id: string, kind: ArtifactKind): Promise<void> {
  const meta = await getMeta(record_id);
  if (!meta) return;
  const entry = meta.artifacts[kind];
  if (!entry) return;
  try {
    await deleteFile(entry.drive_file_id);
  } catch (err) {
    serverLog("warn", "drive:delete", "drive delete failed; removing from meta anyway", { record_id, kind, error: String(err) });
  }
  delete meta.artifacts[kind];
  await writeMeta(meta.folder_drive_id, meta);
  metaCache.delete(record_id);
}

export interface WebhookArtifactBlock {
  folder: { drive_web_url?: string; drive_id: string };
  transcript?: ArtifactRefForWebhook;
  description?: ArtifactRefForWebhook;
  summary?: ArtifactRefForWebhook;
  chat?: ArtifactRefForWebhook;
}

export interface ArtifactRefForWebhook {
  drive_web_url?: string;
  drive_id: string;
  api_url: string;
  size: number;
  modified: string;
}

export function buildWebhookArtifactBlock(meta: MetaJson, baseApiUrl: string): WebhookArtifactBlock {
  const block: WebhookArtifactBlock = {
    folder: { drive_web_url: meta.folder_drive_web_url, drive_id: meta.folder_drive_id },
  };
  for (const kind of ARTIFACT_KINDS) {
    const e = meta.artifacts[kind];
    if (!e) continue;
    block[kind] = {
      drive_web_url: e.drive_web_url,
      drive_id: e.drive_file_id,
      api_url: `${baseApiUrl}/api/artifacts/${meta.record_id}/${kind}`,
      size: e.size,
      modified: e.modified,
    };
  }
  return block;
}
