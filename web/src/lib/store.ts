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
        const record = WasmVideoRecord.fromJson(json);
        this.records.set(record.id(), record);
      }
    } catch {
      // ignore corrupt storage
    }
  }

  private persist() {
    const snapshots: string[] = [];
    for (const record of this.records.values()) {
      snapshots.push(record.to_json());
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
    return Array.from(this.records.values()).map((r) =>
      JSON.parse(r.to_json())
    );
  }

  size(): number {
    return this.records.size;
  }

  /** Mutate a record and re-notify. Returns the events JSON string. */
  mutate(id: string, fn: (r: WasmVideoRecord) => string): string {
    const record = this.records.get(id);
    if (!record) throw new Error(`Record ${id} not found`);
    const events = fn(record);
    this.notify();
    return events;
  }
}

export const videoStore = new VideoStore();

/** Boot: init WASM + hydrate store */
export async function bootStore(): Promise<void> {
  await ensureWasm();
  videoStore.hydrate();
}
