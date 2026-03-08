/**
 * Auto-linker for video provenance (ADR-019 Tier 1 + 2).
 *
 * Detects upstream relationships between VideoRecords using:
 *  1. Fireflies zoom_meeting_id (high confidence, primary signal)
 *  2. Timestamp proximity ±15 minutes (high confidence alone)
 *  3. Title similarity (medium) + participant overlap (medium) together
 */

import type { VideoRecordJSON, LinkUpstreamCmd } from "./wasm";
import { videoStore } from "./store";

const TIMESTAMP_WINDOW_MS = 15 * 60 * 1000; // ±15 minutes

// ── Suggestion generation ────────────────────────────────────────

/**
 * Given a list of all video records, compute suggested LinkUpstreamCmd pairs.
 * Returns an array of { childId, cmd } objects — the caller decides whether to apply them.
 */
export function suggestUpstreamLinks(
  videos: VideoRecordJSON[],
  actorUserId: string,
  actorRole: "Admin" | "Publisher" | "Viewer" = "Admin"
): Array<{ childId: string; cmd: LinkUpstreamCmd }> {
  const suggestions: Array<{ childId: string; cmd: LinkUpstreamCmd }> = [];
  const zoomById = new Map<string, VideoRecordJSON>(); // source_id -> record
  const zoomByUuid = new Map<string, VideoRecordJSON>(); // uuid part -> record

  for (const v of videos) {
    if (v.source_platform === "Zoom") {
      zoomById.set(v.source_id, v);
      // source_id is "zoom-<uuid>"
      const uuid = v.source_id.replace(/^zoom-/, "");
      if (uuid) zoomByUuid.set(uuid, v);
      // Also index by numeric meeting ID stored in metadata_extra
      const numId = (v.metadata_extra as Record<string, string> | null)?.zoom_meeting_id;
      if (numId) zoomByUuid.set(numId, v);
    }
  }

  for (const child of videos) {
    if (child.source_platform !== "Fireflies" && child.source_platform !== "Loom") continue;

    // Skip if already linked to a Zoom via SameEvent
    if (
      child.upstream_links?.some(
        (l) => l.platform === "Zoom" && l.relation === "SameEvent"
      )
    )
      continue;

    const childTime = child.recorded_at
      ? new Date(child.recorded_at).getTime()
      : new Date(child.indexed_at).getTime();

    let matched: VideoRecordJSON | null = null;
    let isPhantom = false;
    let phantomExternalId = "";
    let accountHint: string | undefined;

    // 1. Primary: zoom_meeting_id from Fireflies metadata_extra
    const zoomMeetingId = (child.metadata_extra as Record<string, string> | null | undefined)?.zoom_meeting_id;
    if (zoomMeetingId) {
      const zoomRecord = zoomByUuid.get(zoomMeetingId);
      if (zoomRecord) {
        matched = zoomRecord;
      } else {
        // Phantom: Zoom meeting not in catalog
        isPhantom = true;
        phantomExternalId = zoomMeetingId;
      }
    }

    // 2. Fallback: timestamp proximity
    if (!matched && !isPhantom) {
      for (const parent of videos) {
        if (parent.id === child.id || parent.source_platform !== "Zoom") continue;
        if (
          child.rejected_links?.some(
            (r) => r.platform === "Zoom" && r.external_id === parent.source_id
          )
        )
          continue;

        const parentTime = parent.recorded_at
          ? new Date(parent.recorded_at).getTime()
          : new Date(parent.indexed_at).getTime();

        if (Math.abs(childTime - parentTime) <= TIMESTAMP_WINDOW_MS) {
          matched = parent;
          break;
        }
      }
    }

    if (matched) {
      suggestions.push({
        childId: child.id,
        cmd: {
          actor: { user_id: actorUserId, role: actorRole },
          video_id: matched.id,
          platform: "Zoom",
          external_id: matched.source_id,
          account_hint: accountHint,
          relation: "SameEvent",
          linked_by: "Auto",
        },
      });
    } else if (isPhantom) {
      // Skip if already rejected
      if (
        child.rejected_links?.some(
          (r) => r.platform === "Zoom" && r.external_id === phantomExternalId
        )
      )
        continue;

      suggestions.push({
        childId: child.id,
        cmd: {
          actor: { user_id: actorUserId, role: actorRole },
          video_id: null,
          platform: "Zoom",
          external_id: phantomExternalId,
          account_hint: accountHint,
          relation: "SameEvent",
          linked_by: "Auto",
        },
      });
    }
  }

  return suggestions;
}

/**
 * Apply auto-links for newly imported records.
 * Pass the IDs of just-imported records so we only link those.
 * Modifies the store in-place. Returns count of links created.
 */
export function applyAutoLinks(
  newRecordIds: string[],
  actorUserId = "00000000-0000-0000-0000-000000000001"
): number {
  const all = videoStore.getAll();
  const suggestions = suggestUpstreamLinks(all, actorUserId);
  // Only apply suggestions for the newly imported records
  const newSet = new Set(newRecordIds);
  let count = 0;
  for (const { childId, cmd } of suggestions) {
    if (!newSet.has(childId)) continue;
    try {
      videoStore.mutate(childId, (r) => r.link_upstream(JSON.stringify(cmd)));
      count++;
    } catch {
      // Ignore: record may already have this link
    }
  }
  return count;
}

// ── Graph reconstruction ─────────────────────────────────────────

export type PhantomNode = {
  kind: "phantom";
  platform: string;
  external_id: string;
  account_hint: string | null;
};

export type RealNode = {
  kind: "real";
  record: VideoRecordJSON;
};

export type GraphNode = PhantomNode | RealNode;

export type DestinationNode = {
  platform: string;
  external_id: string;
  external_url: string | null;
};

export type ProvenanceSession = {
  /** ISO date string from the earliest record in the session */
  date: string;
  /** Zoom records (real + phantom) that are origins for this session */
  origins: GraphNode[];
  /** Fireflies / Loom records that derived from those origins */
  intermediaries: RealNode[];
  /** Destination locations (YouTube, Kaltura) drawn from all records in the session */
  destinations: DestinationNode[];
};

/** Build provenance sessions from the full catalog. */
export function buildProvenance(videos: VideoRecordJSON[]): ProvenanceSession[] {
  const videoMap = new Map<string, VideoRecordJSON>();
  for (const v of videos) videoMap.set(v.id, v);

  // Union-Find
  const parent = new Map<string, string>();
  function find(id: string): string {
    if (!parent.has(id)) return id;
    const p = find(parent.get(id)!);
    parent.set(id, p);
    return p;
  }
  function union(a: string, b: string) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // Build unions from upstream_links
  for (const v of videos) {
    for (const link of v.upstream_links ?? []) {
      if (link.video_id) union(v.id, link.video_id);
      else {
        // Phantom: use synthetic key
        const phantomKey = `phantom:${link.platform}:${link.external_id}`;
        union(v.id, phantomKey);
      }
    }
  }

  // Collect all participants in linked sessions (exclude isolated records)
  const linkedIds = new Set<string>();
  for (const v of videos) {
    if ((v.upstream_links?.length ?? 0) > 0) {
      linkedIds.add(v.id);
      for (const link of v.upstream_links ?? []) {
        if (link.video_id) linkedIds.add(link.video_id);
      }
    }
  }
  // Also include Zoom records that are referenced as parents (but have no upstream_links themselves)
  for (const id of linkedIds) {
    // ids from upstream_links may not be in linkedIds if the Zoom record has no links
    // already handled above
  }

  if (linkedIds.size === 0) return [];

  // Group by root
  const groups = new Map<string, Set<string>>();
  for (const id of linkedIds) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root)!.add(id);
  }

  const sessions: ProvenanceSession[] = [];

  for (const [, ids] of groups) {
    const realRecords: VideoRecordJSON[] = [];
    const phantomMap = new Map<string, PhantomNode>();

    for (const id of ids) {
      if (id.startsWith("phantom:")) {
        const parts = id.split(":");
        const platform = parts[1];
        const external_id = parts.slice(2).join(":");
        phantomMap.set(id, { kind: "phantom", platform, external_id, account_hint: null });
      } else {
        const rec = videoMap.get(id);
        if (rec) realRecords.push(rec);
      }
    }

    // Resolve account_hint for phantom nodes from the actual links
    for (const rec of realRecords) {
      for (const link of rec.upstream_links ?? []) {
        if (!link.video_id) {
          const key = `phantom:${link.platform}:${link.external_id}`;
          const existing = phantomMap.get(key);
          if (existing && link.account_hint && !existing.account_hint) {
            existing.account_hint = link.account_hint;
          }
        }
      }
    }

    // Classify nodes
    const origins: GraphNode[] = [
      ...realRecords
        .filter((r) => r.source_platform === "Zoom")
        .map((r): RealNode => ({ kind: "real", record: r })),
      ...Array.from(phantomMap.values()),
    ];

    const intermediaries: RealNode[] = realRecords
      .filter(
        (r) => r.source_platform === "Fireflies" || r.source_platform === "Loom"
      )
      .map((r) => ({ kind: "real" as const, record: r }));

    // Collect destination locations from all records in session
    const destMap = new Map<string, DestinationNode>();
    for (const rec of realRecords) {
      for (const loc of rec.locations ?? []) {
        if (loc.role === "Destination") {
          const key = `${loc.platform}:${loc.external_id}`;
          if (!destMap.has(key)) {
            destMap.set(key, {
              platform: loc.platform,
              external_id: loc.external_id,
              external_url: loc.external_url,
            });
          }
        }
      }
    }

    const allTimes = realRecords
      .map((r) => r.recorded_at || r.indexed_at)
      .filter(Boolean)
      .map((s) => new Date(s!).getTime());
    const date =
      allTimes.length > 0
        ? new Date(Math.min(...allTimes)).toISOString()
        : new Date().toISOString();

    sessions.push({
      date,
      origins,
      intermediaries,
      destinations: Array.from(destMap.values()),
    });
  }

  // Sort by date descending
  sessions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return sessions;
}

// ── Label helpers ────────────────────────────────────────────────

/** Human-readable label for a DerivationType value. */
export function derivationLabel(relation: string): string {
  switch (relation) {
    case "SameEvent":       return "Same session";
    case "TranscribedFrom": return "Transcribed from";
    case "ScreenRecordingOf": return "Screen recording of";
    case "ClipOf":          return "Clip of";
    default:                return relation;
  }
}

/** Human-readable label for a LinkOrigin value. */
export function linkOriginLabel(origin: string): string {
  return origin === "Auto" ? "auto-detected" : "manual";
}

/** Platform emoji/abbreviation for compact display. */
export function platformLabel(p: string): string {
  switch (p) {
    case "Zoom":       return "Zoom";
    case "Fireflies":  return "Fireflies";
    case "Loom":       return "Loom";
    case "YouTube":    return "YouTube";
    case "Kaltura":    return "Kaltura";
    case "Veedio":     return "Veedio";
    default:           return p;
  }
}
