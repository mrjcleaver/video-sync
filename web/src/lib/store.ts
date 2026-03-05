/**
 * In-memory store that holds WasmVideoRecord instances.
 * Uses a Map keyed by video record ID.
 * Persists snapshots to localStorage so records survive page reloads.
 */

import { WasmVideoRecord, VideoRecordJSON, ensureWasm } from "./wasm";

const STORAGE_KEY = "video-sync:records";
const TRANSCRIPTS_KEY = "video-sync:transcripts";

class VideoStore {
  private records = new Map<string, WasmVideoRecord>();
  private transcripts = new Map<string, string>(); // id → transcript_text (JS-side only)
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.persist();
    this.listeners.forEach((fn) => fn());
  }

  /** Load all records from localStorage (call after WASM init) */
  hydrate() {
    // Load transcript cache first
    try {
      const raw = localStorage.getItem(TRANSCRIPTS_KEY);
      if (raw) {
        const map = JSON.parse(raw) as Record<string, string>;
        for (const [id, text] of Object.entries(map)) {
          this.transcripts.set(id, text);
        }
      }
    } catch {
      localStorage.removeItem(TRANSCRIPTS_KEY);
    }

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const snapshots: string[] = JSON.parse(raw);
      for (const json of snapshots) {
        try {
          // Migrate: strip transcript_text from WASM JSON → JS cache
          // This prevents large strings from living in the WASM heap.
          const parsed = JSON.parse(json) as { id?: string; transcript_text?: string | null };
          if (parsed.transcript_text && parsed.id) {
            this.transcripts.set(parsed.id, parsed.transcript_text);
            parsed.transcript_text = null;
          }
          const cleanJson = parsed.id && parsed.transcript_text === null
            ? JSON.stringify(parsed)
            : json;
          const record = WasmVideoRecord.fromJson(cleanJson);
          record.to_json();
          this.records.set(record.id(), record);
        } catch {
          console.warn("Skipping corrupt record during hydrate");
        }
      }
      if (this.records.size < snapshots.length) {
        this.persist();
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  private persist() {
    const snapshots: string[] = [];
    for (const [id, record] of this.records.entries()) {
      try {
        snapshots.push(record.to_json());
      } catch {
        console.warn(`Dropping record ${id} — serialization failed`);
        this.records.delete(id);
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots));

    // Persist transcript cache separately (never inside WASM JSON)
    const transcriptMap: Record<string, string> = {};
    for (const [id, text] of this.transcripts.entries()) {
      transcriptMap[id] = text;
    }
    try {
      localStorage.setItem(TRANSCRIPTS_KEY, JSON.stringify(transcriptMap));
    } catch {
      // Quota exceeded for transcripts — not fatal, WASM records still persist
      console.warn("Transcript cache too large for localStorage — transcripts will be lost on reload");
    }
  }

  add(record: WasmVideoRecord) {
    this.records.set(record.id(), record);
    this.notify();
  }

  get(id: string): WasmVideoRecord | undefined {
    return this.records.get(id);
  }

  getAll(): VideoRecordJSON[] {
    const result: VideoRecordJSON[] = [];
    for (const [id, r] of this.records.entries()) {
      try {
        const json = JSON.parse(r.to_json()) as VideoRecordJSON;
        // Overlay transcript from JS-side cache
        const transcript = this.transcripts.get(id);
        if (transcript) json.transcript_text = transcript;
        result.push(json);
      } catch {
        console.warn(`Dropping unserializable record ${id}`);
        this.records.delete(id);
      }
    }
    return result;
  }

  size(): number {
    return this.records.size;
  }

  remove(id: string) {
    this.records.delete(id);
    this.transcripts.delete(id);
    this.notify();
  }

  /** Store transcript text for a record in the JS-side cache (never touches WASM heap). */
  setTranscript(id: string, transcript: string) {
    this.transcripts.set(id, transcript);
    this.notify();
  }

  getTranscript(id: string): string | undefined {
    return this.transcripts.get(id);
  }

  /** Mutate a record and re-notify. Returns the events JSON string. */
  mutate(id: string, fn: (r: WasmVideoRecord) => string): string {
    const record = this.records.get(id);
    if (!record) {
      // If the store is empty the likely cause is a WASM hot-module swap that reset
      // the module singleton without re-running bootStore(). Surface a clear message.
      if (this.records.size === 0) {
        throw new Error(`Store is empty — reload the page (Ctrl+R) to re-initialise.`);
      }
      throw new Error(`Record ${id} not found`);
    }
    let events: string;
    try {
      events = fn(record);
    } catch (err) {
      // Defer notify to ensure WASM RefCell borrow is fully released
      // before any subsequent to_json() calls in persist()
      queueMicrotask(() => this.notify());
      throw err;
    }
    this.notify();
    return events;
  }
}

export const videoStore = new VideoStore();

/** Boot: init WASM + hydrate store */
export async function bootStore(): Promise<void> {
  // If URL has ?reset, clear corrupt records
  if (typeof window !== "undefined" && window.location.search.includes("reset")) {
    localStorage.removeItem(STORAGE_KEY);
    window.history.replaceState({}, "", window.location.pathname);
  }
  await ensureWasm();
  videoStore.hydrate();
}
