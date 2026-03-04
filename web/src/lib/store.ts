/**
 * In-memory store that holds WasmVideoRecord instances.
 * Uses a Map keyed by video record ID.
 * Persists snapshots to localStorage so records survive page reloads.
 */

import { WasmVideoRecord, VideoRecordJSON, ensureWasm } from "./wasm";

const STORAGE_KEY = "video-sync:records";

class VideoStore {
  private records = new Map<string, WasmVideoRecord>();
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
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const snapshots: string[] = JSON.parse(raw);
      for (const json of snapshots) {
        try {
          const record = WasmVideoRecord.fromJson(json);
          // Verify the record can serialize without crashing
          record.to_json();
          this.records.set(record.id(), record);
        } catch {
          console.warn("Skipping corrupt record during hydrate");
        }
      }
      // Re-persist to drop any corrupt records
      if (this.records.size < snapshots.length) {
        this.persist();
      }
    } catch {
      // Storage completely corrupt — clear it
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
        result.push(JSON.parse(r.to_json()));
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
    this.notify();
  }

  /** Mutate a record and re-notify. Returns the events JSON string. */
  mutate(id: string, fn: (r: WasmVideoRecord) => string): string {
    const record = this.records.get(id);
    if (!record) throw new Error(`Record ${id} not found`);
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
