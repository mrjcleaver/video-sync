/**
 * ADR-075/§Follow-up — resolve the platform-account identifier that
 * owns each record's source. Returned as {label, tooltip} pairs so
 * the VideoCard can render a compact "from: <account>" chip without
 * losing the raw values in the hover.
 *
 * Different sources carry the identity in different metadata_extra
 * keys — this is the single place that reconciles them.
 */

import type { VideoRecordJSON } from "./wasm";

export interface ContributingAccount {
  /** Short label — the thing that goes in the chip. */
  label: string;
  /** Full multi-line disclosure for the hover title. */
  tooltip: string;
  /** Which metadata_extra key drove the resolution — useful for
   *  operator triage of "why does this show that account". */
  source_key: string;
}

function extra(v: VideoRecordJSON): Record<string, unknown> {
  const raw = (v as VideoRecordJSON & { metadata_extra?: unknown }).metadata_extra;
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function resolveContributingAccount(v: VideoRecordJSON): ContributingAccount | null {
  const m = extra(v);

  // Contributor-submitted records (ADR-065) — the submitter of the
  // /contribute form is the effective account, even if the underlying
  // Zoom / Drive account is someone else. Show that first because
  // it's what the operator is holding accountable.
  const contributorEmail = str((v as VideoRecordJSON & { contributor_email?: string }).contributor_email);
  if (contributorEmail) {
    const chapter = str((v as VideoRecordJSON & { contributor_chapter?: string }).contributor_chapter);
    return {
      label: contributorEmail,
      tooltip: `Contributor: ${contributorEmail}${chapter ? `\nChapter: ${chapter}` : ""}\n(via /contribute submission)`,
      source_key: "contributor_email",
    };
  }

  switch (v.source_platform) {
    case "YouTube": {
      // youtube channel name is what viewers see; channelId is stable
      const channel = str(m.channel) ?? str(m.channelTitle);
      const channelId = str(m.channel_id);
      if (channel) {
        return {
          label: channel,
          tooltip: `YouTube channel: ${channel}${channelId ? `\nChannel id: ${channelId}` : ""}`,
          source_key: "channel",
        };
      }
      return null;
    }
    case "Zoom": {
      const hostEmail = str(m.host_email);
      const hostId = str(m.host_id);
      if (hostEmail) {
        return {
          label: hostEmail,
          tooltip: `Zoom host: ${hostEmail}${hostId ? `\nHost id: ${hostId}` : ""}`,
          source_key: "host_email",
        };
      }
      // Zoom-share (public) rows may not carry a host_email; fall
      // through to the "contributor_submitted" marker if present.
      if (m.zoom_share_url && m.contributor_submitted === "1") {
        return {
          label: "public share",
          tooltip: `Zoom public share.\n${str(m.zoom_share_url) ?? ""}`,
          source_key: "zoom_share_url",
        };
      }
      return null;
    }
    case "Fireflies": {
      const org = str(m.organizer_email);
      if (org) {
        return {
          label: org,
          tooltip: `Fireflies organizer: ${org}`,
          source_key: "organizer_email",
        };
      }
      return null;
    }
    case "Loom": {
      const email = str(m.owner_email);
      const name = str(m.owner_name);
      if (email || name) {
        return {
          label: email ?? name!,
          tooltip: `Loom owner: ${name ?? "?"}${email ? ` <${email}>` : ""}`,
          source_key: email ? "owner_email" : "owner_name",
        };
      }
      return null;
    }
    case "Kaltura": {
      // Kaltura's KMC exposes an uploader user id per entry. Best-effort;
      // the importer doesn't always capture it today.
      const uploader = str(m.uploader) ?? str(m.uploader_user_id);
      if (uploader) {
        return {
          label: uploader,
          tooltip: `Kaltura uploader: ${uploader}`,
          source_key: "uploader",
        };
      }
      return null;
    }
    case "GoogleDrive": {
      const email = str(m.drive_original_owner_email);
      const name = str(m.drive_original_owner_name);
      if (email || name) {
        return {
          label: email ?? name!,
          tooltip: `Drive file owner: ${name ?? "?"}${email ? ` <${email}>` : ""}`,
          source_key: email ? "drive_original_owner_email" : "drive_original_owner_name",
        };
      }
      return null;
    }
    default:
      return null;
  }
}
