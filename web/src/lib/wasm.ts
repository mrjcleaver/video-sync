import init, { WasmVideoRecord } from "../../pkg/video_sync";

let initialized = false;

export async function ensureWasm(): Promise<void> {
  if (!initialized) {
    await init();
    initialized = true;
  }
}

export { WasmVideoRecord };

/** Typed wrapper for the JSON returned by WasmVideoRecord.to_json() */
export interface VideoRecordJSON {
  id: string;
  source_id: string;
  source_platform: string;
  title: string;
  description: string | null;
  created_at: string;
  duration_seconds: number;
  participants: string[];
  transcript_text: string | null;
  download_url: string;
  thumbnail_url: string | null;
  tags: string[];
  notes: NoteJSON[];
  owners: string[];
  moderators: string[];
  status: string;
  curated_by: string | null;
  curated_at: string | null;
  indexed_at: string;
  recorded_at: string | null;
  published_at: string | null;
  destination_id: string | null;
  destination_url: string | null;
  locations: PlatformLocationJSON[];
  upstream_links: UpstreamLinkJSON[];
  rejected_links: RejectedLinkJSON[];
  metadata_extra: Record<string, unknown> | null;
  // ADR-046 — prompt-driven summary metadata.
  summary_doc_id?: string | null;
  summary_prompt_version?: number | null;
  summary_locked?: boolean;
  summary_counts?: SummaryCountsJSON | null;
  /** ISO timestamp when the current summary was generated. */
  summary_generated_at?: string | null;
  // ADR-065 — community-contributor attribution.
  contributor_email?: string | null;
  contributor_chapter?: string | null;
}

/** ADR-046 — counts surfaced as M:NN L:NN T:NN C:NN in the Overview. */
export interface SummaryCountsJSON {
  m: number;
  l: number;
  t: number;
  c: number;
}

export interface NoteJSON {
  id: string;
  author_id: string;
  text: string;
  created_at: string;
}

export interface PlatformLocationJSON {
  platform: string;
  external_id: string;
  external_url: string | null;
  role: string;
  ordinal: number;
  synced_at: string;
  status: string | null;
}

export interface UpstreamLinkJSON {
  video_id: string | null;
  platform: string;
  external_id: string;
  account_hint: string | null;
  relation: "SameEvent" | "TranscribedFrom" | "ScreenRecordingOf" | "ClipOf" | "BroadcastedFrom";
  linked_by: "Auto" | "Manual";
  linked_at: string;
}

export interface RejectedLinkJSON {
  platform: string;
  external_id: string;
  rejected_at: string;
}

export interface LinkUpstreamCmd {
  actor: { user_id: string; role: string };
  video_id?: string | null;
  platform: string;
  external_id: string;
  account_hint?: string;
  relation: "SameEvent" | "TranscribedFrom" | "ScreenRecordingOf" | "ClipOf" | "BroadcastedFrom";
  linked_by?: "Auto" | "Manual";
}

export interface UnlinkUpstreamCmd {
  actor: { user_id: string; role: string };
  platform: string;
  external_id: string;
  reject?: boolean;
}

export interface AddLocationCmd {
  actor: { user_id: string; role: string };
  platform: string;
  external_id: string;
  external_url?: string;
  role: string;
}

export interface RemoveLocationCmd {
  actor: { user_id: string; role: string };
  platform: string;
  external_id: string;
}

export interface IndexVideoCmd {
  source_id: string;
  source_platform: string;
  title: string;
  description?: string;
  duration_seconds: number;
  participants: string[];
  transcript_text?: string;
  download_url: string;
  thumbnail_url?: string;
  tags: string[];
  metadata_extra?: unknown;
  initial_owner?: string;
  recorded_at?: string;
  // ADR-065 — community-contributor attribution (optional).
  contributor_email?: string;
  contributor_chapter?: string;
}
