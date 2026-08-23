/**
 * ADR-077 §3 — Google Drive destination adapter.
 *
 * Wraps /api/drive/publish (ADR-075 §Follow-up #4), which downloads the
 * source media server-side and uploads it into the target folder using the
 * runtime service account (ADR-042). No client credentials for Drive
 * itself — only the source-fetch creds.
 *
 * Does NOT apply the declared share scope: the route sets no file
 * permissions, so the file inherits the folder's sharing. That is correct
 * for `share_scope: inherit` and silently wrong for `org_restricted` and
 * `anyone_with_link`. ADR-077 §5 closes it; until then
 * appliesDeclaredVisibility("GoogleDrive") is false.
 */

import type { DestinationAdapter, PushRequest, PushResult } from "../types";

/**
 * Series config sometimes stores a whole Drive folder URL where a bare id
 * is expected. Normalise both shapes.
 *
 * Mirrors extractDriveFolderId in the publish route — duplicated rather
 * than imported because that module is server-only (it pulls in node:fs
 * via the catalog route) and this adapter runs in the browser.
 */
export function extractDriveFolderId(input: string): string {
  const s = (input ?? "").trim();
  if (!s) return "";
  const m1 = s.match(/\/folders\/([A-Za-z0-9_-]{20,})/);
  if (m1) return m1[1];
  const m2 = s.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  if (m2) return m2[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  return s;
}

export const driveAdapter: DestinationAdapter = {
  platform: "GoogleDrive",

  async push(req: PushRequest): Promise<PushResult> {
    if (req.spec.platform !== "GoogleDrive") {
      throw new Error(`driveAdapter received a ${req.spec.platform} destination`);
    }
    const folderId = extractDriveFolderId(req.spec.folder_id);
    if (!folderId) {
      throw new Error("Drive destination has no folder_id — set one on the series.");
    }

    req.onPhase?.("Uploading to Drive folder…");

    const res = await fetch("/api/drive/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        record_id: req.record.id,
        folder_id: folderId,
        ...req.creds.source,
      }),
    });
    const data = await res.json().catch(() => ({})) as {
      drive_file_id?: string;
      web_view_link?: string;
      bytes?: number;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(data.error ?? `Drive publish failed (${res.status})`);
    }
    if (!data.drive_file_id) {
      throw new Error("Drive publish returned no file id");
    }
    return {
      external_id: data.drive_file_id,
      external_url: data.web_view_link ?? `https://drive.google.com/file/d/${data.drive_file_id}/view`,
      bytes: data.bytes,
    };
  },
};
