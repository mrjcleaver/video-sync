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
}
