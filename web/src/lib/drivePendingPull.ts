/**
 * ADR-071 §2 — pending-curator queue scanner.
 *
 * Finds catalog records that a contributor submitted with a private
 * Drive link. They land at Discovered with
 * metadata_extra.drive_pending_curator = "1" and metadata_extra
 * .drive_file_id = <id>. A Publisher triggers the actual pull from
 * /maintain; on success the flag clears and the record advances.
 */

import type { VideoRecordJSON } from "./wasm";

export interface DrivePendingPullCandidate {
  record: VideoRecordJSON;
  file_id: string;
  submitted_by: string | null;
  web_view_link: string | null;
}

export function findDrivePendingPulls(records: VideoRecordJSON[]): DrivePendingPullCandidate[] {
  const out: DrivePendingPullCandidate[] = [];
  for (const rec of records) {
    if (rec.status === "Skipped" || rec.status === "Abandoned") continue;
    const extra = (rec as VideoRecordJSON & { metadata_extra?: Record<string, string> }).metadata_extra ?? {};
    if (extra.drive_pending_curator !== "1") continue;
    const fileId = extra.drive_file_id;
    if (!fileId) continue;
    out.push({
      record: rec,
      file_id: fileId,
      submitted_by: (rec as VideoRecordJSON & { contributor_email?: string }).contributor_email ?? null,
      web_view_link: extra.drive_web_view_link ?? null,
    });
  }
  return out;
}
