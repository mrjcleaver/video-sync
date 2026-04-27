/**
 * In-memory store that holds WasmVideoRecord instances.
 * Uses a Map keyed by video record ID.
 *
 * Persistence (ADR-035 Level 2):
 *   - localStorage stays as a fast-boot cache + offline fallback
 *   - server (data/catalog.json + data/transcripts.json) is the
 *     source of truth shared across browsers
 *   - on boot we hydrate from localStorage, then merge against the
 *     server using per-record `lastModified` (last-writer-wins)
 *   - mutations push to server in the background (debounced 500ms
 *     per-record); failures are logged, not blocking
 */

import { WasmVideoRecord, VideoRecordJSON, ensureWasm } from "./wasm";
import { clientLog } from "./logger";

const STORAGE_KEY = "video-sync:records";
const TRANSCRIPTS_KEY = "video-sync:transcripts";
const LAST_MODIFIED_KEY = "video-sync:records-lastmodified";

const PUSH_DEBOUNCE_MS = 500;

class VideoStore {
  private records = new Map<string, WasmVideoRecord>();
  private transcripts = new Map<string, string>(); // id → transcript_text (JS-side only)
  private lastModified = new Map<string, string>(); // id → ISO timestamp
  private listeners = new Set<() => void>();
  private pendingRecordPush = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingTranscriptPush = new Map<string, ReturnType<typeof setTimeout>>();

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

    // Load last-modified map (used by Level 2 sync)
    try {
      const raw = localStorage.getItem(LAST_MODIFIED_KEY);
      if (raw) {
        const map = JSON.parse(raw) as Record<string, string>;
        for (const [id, ts] of Object.entries(map)) {
          this.lastModified.set(id, ts);
        }
      }
    } catch {
      localStorage.removeItem(LAST_MODIFIED_KEY);
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
          clientLog("warn", "store", "Skipping corrupt record during hydrate");
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
        clientLog("warn", "store", "Dropping record — serialization failed", { video_id: id });
        this.records.delete(id);
        this.lastModified.delete(id);
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
      clientLog("warn", "store", "Transcript cache too large for localStorage — transcripts will be lost on reload");
    }

    // Persist last-modified map
    const lmMap: Record<string, string> = {};
    for (const [id, ts] of this.lastModified.entries()) {
      lmMap[id] = ts;
    }
    try {
      localStorage.setItem(LAST_MODIFIED_KEY, JSON.stringify(lmMap));
    } catch {
      // Tiny map; if this fails localStorage is wedged anyway.
    }
  }

  /**
   * ADR-035 Level 2 — merge with server using per-record lastModified.
   * Call after `hydrate()`. Best-effort: server errors leave the local
   * state untouched (offline-friendly).
   *
   * Conflict resolution per id:
   *   - server has newer ts → pull (overwrite local record)
   *   - local has newer ts (or server doesn't know it) → schedule push
   *   - tie or both unknown → leave local as-is
   */
  async syncWithServer(): Promise<void> {
    let serverData: { records: Record<string, string>; lastModified: Record<string, string> };
    try {
      const res = await fetch("/api/catalog", { cache: "no-store" });
      if (!res.ok) throw new Error(`GET /api/catalog ${res.status}`);
      serverData = await res.json();
    } catch (err) {
      clientLog("warn", "store", "catalog server fetch failed; running offline", { error: String(err) });
      return;
    }

    const serverRecords = serverData.records ?? {};
    const serverLm = serverData.lastModified ?? {};

    const allIds = new Set<string>([
      ...Object.keys(serverRecords),
      ...this.records.keys(),
    ]);

    let pulled = 0;
    let pushed = 0;
    for (const id of allIds) {
      const localRecord = this.records.get(id);
      const localTs = this.lastModified.get(id);
      const serverJson = serverRecords[id];
      const serverTs = serverLm[id];

      const localTime = localTs ? Date.parse(localTs) : 0;
      const serverTime = serverTs ? Date.parse(serverTs) : 0;

      if (serverJson && (!localRecord || serverTime > localTime)) {
        try {
          const parsed = JSON.parse(serverJson) as { id?: string; transcript_text?: string | null };
          if (parsed.transcript_text && parsed.id) {
            this.transcripts.set(parsed.id, parsed.transcript_text);
            parsed.transcript_text = null;
          }
          const cleanJson = parsed.id && parsed.transcript_text === null
            ? JSON.stringify(parsed)
            : serverJson;
          const record = WasmVideoRecord.fromJson(cleanJson);
          this.records.set(record.id(), record);
          if (serverTs) this.lastModified.set(id, serverTs);
          pulled++;
        } catch (err) {
          clientLog("warn", "store", "skipping corrupt server record during sync", { video_id: id, error: String(err) });
        }
      } else if (localRecord && (!serverJson || localTime > serverTime)) {
        // Local newer (or server doesn't know about this record yet) → push.
        // Records without a stored lastModified are pre-Level-2 imports;
        // give them a fresh timestamp so the push has something to compare.
        if (!this.lastModified.has(id)) {
          this.lastModified.set(id, new Date().toISOString());
        }
        this.scheduleRecordPush(id);
        if (this.transcripts.has(id)) this.scheduleTranscriptPush(id);
        pushed++;
      }
    }

    // Pull transcripts the server has that we don't (e.g. fresh browser).
    // We don't lastModified-track transcripts independently — they piggyback
    // on the record's lastModified, which is good enough for now.
    try {
      const tr = await fetch("/api/catalog/transcripts", { cache: "no-store" });
      if (tr.ok) {
        const map = (await tr.json()) as Record<string, string>;
        for (const [id, text] of Object.entries(map)) {
          if (!this.transcripts.has(id) && this.records.has(id)) {
            this.transcripts.set(id, text);
          }
        }
      }
    } catch {
      // Best-effort
    }

    if (pulled > 0 || pushed > 0) {
      clientLog("info", "store", "catalog synced with server", { pulled, pushed });
    }
    this.persist();
    this.listeners.forEach((fn) => fn());
  }

  private scheduleRecordPush(id: string) {
    const existing = this.pendingRecordPush.get(id);
    if (existing) clearTimeout(existing);
    this.pendingRecordPush.set(id, setTimeout(() => {
      this.pendingRecordPush.delete(id);
      this.pushRecord(id);
    }, PUSH_DEBOUNCE_MS));
  }

  private scheduleTranscriptPush(id: string) {
    const existing = this.pendingTranscriptPush.get(id);
    if (existing) clearTimeout(existing);
    this.pendingTranscriptPush.set(id, setTimeout(() => {
      this.pendingTranscriptPush.delete(id);
      this.pushTranscript(id);
    }, PUSH_DEBOUNCE_MS));
  }

  private async pushRecord(id: string) {
    const record = this.records.get(id);
    if (!record) return;
    let json: string;
    try {
      json = record.to_json();
    } catch {
      return;
    }
    const lastModified = this.lastModified.get(id) ?? new Date().toISOString();
    try {
      const res = await fetch("/api/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, json, lastModified }),
      });
      if (!res.ok) throw new Error(`POST /api/catalog ${res.status}`);
    } catch (err) {
      clientLog("warn", "store", "catalog record push failed", { video_id: id, error: String(err) });
    }
  }

  private async pushTranscript(id: string) {
    const text = this.transcripts.get(id);
    if (text === undefined) return;
    try {
      const res = await fetch("/api/catalog/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, text }),
      });
      if (!res.ok) throw new Error(`POST /api/catalog/transcripts ${res.status}`);
    } catch (err) {
      clientLog("warn", "store", "transcript push failed", { video_id: id, error: String(err) });
    }
  }

  private async pushDelete(id: string) {
    try {
      await fetch(`/api/catalog?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (err) {
      clientLog("warn", "store", "catalog delete push failed", { video_id: id, error: String(err) });
    }
    try {
      await fetch(`/api/catalog/transcripts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch {
      // best-effort
    }
  }

  private touch(id: string) {
    this.lastModified.set(id, new Date().toISOString());
  }

  add(record: WasmVideoRecord) {
    const id = record.id();
    this.records.set(id, record);
    this.touch(id);
    this.notify();
    this.scheduleRecordPush(id);
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
        clientLog("warn", "store", "Dropping unserializable record", { video_id: id });
        this.records.delete(id);
        this.lastModified.delete(id);
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
    this.lastModified.delete(id);
    // Cancel any pending pushes for this id — the delete supersedes them.
    const recPush = this.pendingRecordPush.get(id);
    if (recPush) { clearTimeout(recPush); this.pendingRecordPush.delete(id); }
    const trPush = this.pendingTranscriptPush.get(id);
    if (trPush) { clearTimeout(trPush); this.pendingTranscriptPush.delete(id); }
    this.notify();
    this.pushDelete(id);
  }

  /** Store transcript text for a record in the JS-side cache (never touches WASM heap). */
  setTranscript(id: string, transcript: string) {
    this.transcripts.set(id, transcript);
    this.touch(id);
    this.notify();
    this.scheduleTranscriptPush(id);
    // Also bump record lastModified on the server so other browsers
    // know there's a newer version (transcript change implies the record
    // shape changed from their POV, since transcripts overlay onto the
    // returned VideoRecordJSON).
    this.scheduleRecordPush(id);
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
    const statusBefore = (() => { try { return (JSON.parse(record.to_json()) as { status?: string }).status; } catch { return "unknown"; } })();
    let events: string;
    try {
      events = fn(record);
    } catch (err) {
      clientLog("error", "wasm", "transition failed", { video_id: id, status_before: statusBefore, error: String(err) });
      // Defer notify to ensure WASM RefCell borrow is fully released
      // before any subsequent to_json() calls in persist()
      queueMicrotask(() => this.notify());
      throw err;
    }
    const statusAfter = (() => { try { return (JSON.parse(record.to_json()) as { status?: string }).status; } catch { return "unknown"; } })();
    clientLog("debug", "wasm", "transition", { video_id: id, status_before: statusBefore, status_after: statusAfter });
    this.touch(id);
    this.notify();
    this.scheduleRecordPush(id);
    return events;
  }
}

export const videoStore = new VideoStore();

/** Boot: init WASM + hydrate store + sync with server */
export async function bootStore(): Promise<void> {
  // If URL has ?reset, clear corrupt records
  if (typeof window !== "undefined" && window.location.search.includes("reset")) {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LAST_MODIFIED_KEY);
    window.history.replaceState({}, "", window.location.pathname);
  }
  await ensureWasm();
  videoStore.hydrate();
  // Server sync runs in the background — don't block UI on it.
  videoStore.syncWithServer().catch(() => {/* logged inside */});
}
