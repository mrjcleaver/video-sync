/**
 * Drive API wrapper (ADR-039).
 *
 * Authentication uses Application Default Credentials:
 *   - Locally: `gcloud auth application-default login`
 *   - On Cloud Run: the runtime service account (per ADR-039 Plan B,
 *     no domain-wide delegation; runtime SA is a Manager on the
 *     Shared Drive directly).
 *
 * Required env vars:
 *   DRIVE_ROOT_FOLDER_ID   — folder where year/month buckets are created
 *   DRIVE_SHARED_DRIVE_ID  — the Shared Drive containing that folder
 *                             (Shared Drive APIs require driveId on list)
 */

import { google, drive_v3 } from "googleapis";
import { GoogleAuth } from "google-auth-library";

const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

let _drive: drive_v3.Drive | null = null;

export function getDrive(): drive_v3.Drive {
  if (_drive) return _drive;
  const auth = new GoogleAuth({ scopes: SCOPES });
  _drive = google.drive({ version: "v3", auth });
  return _drive;
}

export function getRootFolderId(): string {
  const id = process.env.DRIVE_ROOT_FOLDER_ID;
  if (!id) throw new Error("DRIVE_ROOT_FOLDER_ID env var not set");
  return id;
}

export function getSharedDriveId(): string {
  const id = process.env.DRIVE_SHARED_DRIVE_ID;
  if (!id) throw new Error("DRIVE_SHARED_DRIVE_ID env var not set");
  return id;
}

function escapeQ(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export interface DriveFile {
  id: string;
  name: string;
  modifiedTime: string;
  size: number;
  webViewLink?: string;
}

export async function findFolder(name: string, parentId: string): Promise<string | null> {
  const drive = getDrive();
  const res = await drive.files.list({
    q: `name='${escapeQ(name)}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: getSharedDriveId(),
    pageSize: 1,
  });
  return res.data.files?.[0]?.id ?? null;
}

export async function createFolder(name: string, parentId: string, appProperties?: Record<string, string>): Promise<string> {
  const drive = getDrive();
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
      ...(appProperties ? { appProperties } : {}),
    },
    fields: "id",
    supportsAllDrives: true,
  });
  if (!res.data.id) throw new Error(`createFolder: no id returned for ${name}`);
  return res.data.id;
}

export async function findOrCreateFolder(name: string, parentId: string, appProperties?: Record<string, string>): Promise<string> {
  const existing = await findFolder(name, parentId);
  if (existing) return existing;
  return createFolder(name, parentId, appProperties);
}

export async function findFolderByAppProperty(key: string, value: string): Promise<string | null> {
  const drive = getDrive();
  const q = `appProperties has { key='${escapeQ(key)}' and value='${escapeQ(value)}' } and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({
    q,
    fields: "files(id, name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: getSharedDriveId(),
    pageSize: 1,
  });
  return res.data.files?.[0]?.id ?? null;
}

export async function findFile(name: string, parentId: string): Promise<DriveFile | null> {
  const drive = getDrive();
  const res = await drive.files.list({
    q: `name='${escapeQ(name)}' and '${parentId}' in parents and trashed=false`,
    fields: "files(id, name, modifiedTime, size, webViewLink)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: getSharedDriveId(),
    pageSize: 1,
  });
  const f = res.data.files?.[0];
  if (!f?.id || !f.name || !f.modifiedTime) return null;
  return {
    id: f.id,
    name: f.name,
    modifiedTime: f.modifiedTime,
    size: Number(f.size ?? 0),
    webViewLink: f.webViewLink ?? undefined,
  };
}

export async function writeFile(name: string, parentId: string, content: string, mimeType = "text/markdown"): Promise<DriveFile> {
  const drive = getDrive();
  const existing = await findFile(name, parentId);
  if (existing) {
    const res = await drive.files.update({
      fileId: existing.id,
      media: { mimeType, body: content },
      fields: "id, name, modifiedTime, size, webViewLink",
      supportsAllDrives: true,
    });
    const f = res.data;
    return {
      id: f.id!,
      name: f.name!,
      modifiedTime: f.modifiedTime!,
      size: Number(f.size ?? content.length),
      webViewLink: f.webViewLink ?? existing.webViewLink,
    };
  }
  const res = await drive.files.create({
    requestBody: { name, parents: [parentId] },
    media: { mimeType, body: content },
    fields: "id, name, modifiedTime, size, webViewLink",
    supportsAllDrives: true,
  });
  const f = res.data;
  return {
    id: f.id!,
    name: f.name!,
    modifiedTime: f.modifiedTime!,
    size: Number(f.size ?? content.length),
    webViewLink: f.webViewLink ?? undefined,
  };
}

/**
 * ADR-046 — write a native Google Doc by converting source markdown
 * at upload time. The resulting file's mimeType is
 * `application/vnd.google-apps.document` and it opens in Google Docs
 * (not as plain text). `appProperties` is stored on the file for
 * machine-readable provenance (e.g. prompt_version, generated_at).
 *
 * Idempotent on name: if a file with this name already exists in
 * parentId, its content is replaced (Drive re-runs the markdown→Doc
 * conversion) and appProperties is merged.
 */
export async function writeGoogleDoc(
  name: string,
  parentId: string,
  markdown: string,
  appProperties: Record<string, string> = {},
): Promise<DriveFile> {
  const drive = getDrive();
  const existing = await findFile(name, parentId);
  if (existing) {
    const res = await drive.files.update({
      fileId: existing.id,
      requestBody: { appProperties },
      media: { mimeType: "text/markdown", body: markdown },
      fields: "id, name, modifiedTime, size, webViewLink",
      supportsAllDrives: true,
    });
    const f = res.data;
    return {
      id: f.id!,
      name: f.name!,
      modifiedTime: f.modifiedTime!,
      size: Number(f.size ?? markdown.length),
      webViewLink: f.webViewLink ?? existing.webViewLink,
    };
  }
  const res = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId],
      mimeType: "application/vnd.google-apps.document",
      appProperties,
    },
    media: { mimeType: "text/markdown", body: markdown },
    fields: "id, name, modifiedTime, size, webViewLink",
    supportsAllDrives: true,
  });
  const f = res.data;
  return {
    id: f.id!,
    name: f.name!,
    modifiedTime: f.modifiedTime!,
    size: Number(f.size ?? markdown.length),
    webViewLink: f.webViewLink ?? undefined,
  };
}

export async function readFile(fileId: string): Promise<string> {
  const drive = getDrive();
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "text" },
  );
  // googleapis returns the body as `data`; with responseType:"text" it's a string
  return res.data as unknown as string;
}

export async function deleteFile(fileId: string): Promise<void> {
  const drive = getDrive();
  await drive.files.delete({ fileId, supportsAllDrives: true });
}

export async function getFolderWebUrl(folderId: string): Promise<string | undefined> {
  const drive = getDrive();
  const res = await drive.files.get({
    fileId: folderId,
    fields: "webViewLink",
    supportsAllDrives: true,
  });
  return res.data.webViewLink ?? undefined;
}
