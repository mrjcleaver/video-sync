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
    // Build a compact snapshot: strip large server-authoritative
    // fields (description, transcript_text, notes body, metadata_extra)
    // so 700+ records fit in the ~5MB origin cap. In-memory copy is
    // unchanged; boot-time hydration merges with the server (ADR-035
    // Level 2) which restores stripped fields.
    const snapshots: string[] = [];
    for (const [id, record] of this.records.entries()) {
      try {
        const parsed = JSON.parse(record.to_json()) as Record<string, unknown>;
        // Description is server-authoritative and re-fetched on sync.
        // Truncate rather than drop so cards can still render a
        // preview between page load and first sync.
        if (typeof parsed.description === "string" && parsed.description.length > 300) {
          parsed.description = parsed.description.slice(0, 300);
        }
        // Transcripts live in a dedicated cache; never in the record
        // blob (belt-and-braces — some old records may still carry
        // an inline copy).
        parsed.transcript_text = null;
        // metadata_extra: strip everything. Rebuilt server-side on
        // next sync. Includes the opus_fresh_* URLs we used to hand-
        // strip, plus Loom Apollo chapters_json, Zoom / Drive raw
        // URLs, etc.
        parsed.metadata_extra = undefined;
        // Notes: keep the structure (VideoCard renders count + last
        // author) but truncate long note bodies. Notes over 500 chars
        // usually indicate someone pasted a transcript excerpt.
        if (Array.isArray(parsed.notes)) {
          parsed.notes = (parsed.notes as Array<{ text?: string }>).map(n =>
            typeof n?.text === "string" && n.text.length > 500
              ? { ...n, text: n.text.slice(0, 500) }
              : n,
          );
        }
        snapshots.push(JSON.stringify(parsed));
      } catch {
        clientLog("warn", "store", "Dropping record — serialization failed", { video_id: id });
        this.records.delete(id);
        this.lastModified.delete(id);
      }
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots));
    } catch (err) {
      // Quota still exceeded after stripping — the origin cap is
      // ~5MB and ~700 minimal records × 3-4KB overhead can still
      // approach it. Rather than lose everything, keep the newest
      // half (by lastModified) and retry. Older records will re-
      // hydrate from server on next boot.
      const err0 = err instanceof Error ? err.message : String(err);
      try {
        const sortedIds = Array.from(this.records.keys())
          .sort((a, b) => (this.lastModified.get(b) ?? "").localeCompare(this.lastModified.get(a) ?? ""));
        const halfCount = Math.max(50, Math.floor(sortedIds.length / 2));
        const keptIds = new Set(sortedIds.slice(0, halfCount));
        const kept = snapshots.filter((_, i) => keptIds.has(Array.from(this.records.keys())[i]));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
        clientLog("warn", "store", `Records blob exceeded localStorage quota — persisted newest ${kept.length}/${snapshots.length}. Older rows will re-hydrate from server on reload.`);
      } catch (err2) {
        clientLog("warn", "store", "Records blob still exceeds quota after halving — session-only until reload from server", { error: err0, retryError: String(err2) });
      }
    }

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

  private pendingBatchIds = new Set<string>();
  private batchPushTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleRecordPush(id: string) {
    // Coalesce record pushes into a single batched POST. Individual
    // per-id timers were causing N serialized writes on the server
    // (POST /api/catalog is inside a withLock); a bulk operator
    // action easily produced 60 concurrent pushes, and the server's
    // read-merge-write serialization made each subsequent one wait —
    // the 30th write hit Cloud Run's 30s request cap and 500'd.
    // Now: every mutation adds to a batch set; a single timer fires
    // one bulk POST with everything queued.
    this.pendingBatchIds.add(id);
    if (this.batchPushTimer) return;
    this.batchPushTimer = setTimeout(() => {
      this.batchPushTimer = null;
      const ids = Array.from(this.pendingBatchIds);
      this.pendingBatchIds.clear();
      this.pushRecordsBatch(ids);
    }, PUSH_DEBOUNCE_MS);
  }

  private scheduleTranscriptPush(id: string) {
    const existing = this.pendingTranscriptPush.get(id);
    if (existing) clearTimeout(existing);
    this.pendingTranscriptPush.set(id, setTimeout(() => {
      this.pendingTranscriptPush.delete(id);
      this.pushTranscript(id);
    }, PUSH_DEBOUNCE_MS));
  }

  // ADR-074 §Follow-ups — reference.md auto-regenerate. Debounced
  // longer than the record push (which itself is debounced) so a
  // burst of title→description→summary edits collapses to one
  // reference regen server-side. 3s per the ADR §3 trigger design.
  private pendingReferenceRegen = new Map<string, ReturnType<typeof setTimeout>>();
  private static REF_REGEN_DEBOUNCE_MS = 3000;
  private scheduleReferenceRegen(id: string) {
    const existing = this.pendingReferenceRegen.get(id);
    if (existing) clearTimeout(existing);
    this.pendingReferenceRegen.set(id, setTimeout(() => {
      this.pendingReferenceRegen.delete(id);
      // Fire-and-forget — server regenerates against its own catalog
      // snapshot, so we don't need to send anything but the record id.
      fetch(`/api/artifacts/${encodeURIComponent(id)}/regenerate-reference`, { method: "POST" })
        .catch((err) => clientLog("warn", "store", "reference regen kickoff failed", { video_id: id, error: String(err) }));
    }, VideoStore.REF_REGEN_DEBOUNCE_MS));
  }

  // ADR-074 §Follow-ups — description.md is populated by mirroring
  // the WASM record's description field onto Drive after any mutation
  // that touched it. Debounced same as records to collapse the
  // typical "generate then edit then push" burst into one Drive write.
  private pendingDescriptionPush = new Map<string, ReturnType<typeof setTimeout>>();
  private scheduleDescriptionPush(id: string) {
    const existing = this.pendingDescriptionPush.get(id);
    if (existing) clearTimeout(existing);
    this.pendingDescriptionPush.set(id, setTimeout(() => {
      this.pendingDescriptionPush.delete(id);
      this.pushDescription(id);
    }, PUSH_DEBOUNCE_MS));
  }
  private async pushDescription(id: string) {
    const record = this.records.get(id);
    if (!record) return;
    let desc = "";
    try {
      const j = JSON.parse(record.to_json()) as { description?: string | null };
      desc = j.description ?? "";
    } catch { return; }
    const ctx = this.extractRecordContext(id);
    if (!ctx) return;
    try {
      const res = await fetch(`/api/artifacts/${encodeURIComponent(id)}/description`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: desc,
          title: ctx.title,
          source_platform: ctx.source_platform,
          source_id: ctx.source_id,
          recorded_at: ctx.recorded_at,
        }),
      });
      if (!res.ok) throw new Error(`PUT /api/artifacts/${id}/description ${res.status}`);
    } catch (err) {
      clientLog("warn", "store", "description push failed", { video_id: id, error: String(err) });
    }
  }

  private async pushRecordsBatch(ids: string[]) {
    if (ids.length === 0) return;
    const records: Array<{ id: string; json: string; lastModified: string }> = [];
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record) continue;
      let json: string;
      try {
        json = record.to_json();
      } catch {
        continue;
      }
      records.push({ id, json, lastModified: this.lastModified.get(id) ?? new Date().toISOString() });
    }
    if (records.length === 0) return;
    try {
      const res = await fetch("/api/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records }),
      });
      if (!res.ok) throw new Error(`POST /api/catalog ${res.status}`);
    } catch (err) {
      clientLog("warn", "store", "catalog batch push failed", { count: records.length, error: String(err) });
    }
  }

  private extractRecordContext(id: string): { title: string; source_platform: string; source_id: string; recorded_at: string } | null {
    const record = this.records.get(id);
    if (!record) return null;
    try {
      const j = JSON.parse(record.to_json()) as { title?: string; source_platform?: string; source_id?: string; recorded_at?: string; indexed_at?: string };
      return {
        title: j.title ?? "Untitled",
        source_platform: j.source_platform ?? "Unknown",
        source_id: j.source_id ?? id,
        recorded_at: j.recorded_at ?? j.indexed_at ?? new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  private async pushTranscript(id: string) {
    const text = this.transcripts.get(id);
    if (text === undefined) return;
    const ctx = this.extractRecordContext(id);
    if (!ctx) {
      clientLog("warn", "store", "transcript push skipped — no record context", { video_id: id });
      return;
    }
    try {
      const body = `---\nrecord_id: ${id}\nsource_platform: ${ctx.source_platform}\nsource_id: ${ctx.source_id}\nrecorded_at: ${ctx.recorded_at}\ngenerated_at: ${new Date().toISOString()}\n---\n\n${text}`;
      const res = await fetch(`/api/artifacts/${encodeURIComponent(id)}/transcript`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: body,
          title: ctx.title,
          source_platform: ctx.source_platform,
          source_id: ctx.source_id,
          recorded_at: ctx.recorded_at,
        }),
      });
      if (!res.ok) throw new Error(`PUT /api/artifacts/${id}/transcript ${res.status}`);
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
    // Best-effort delete of the transcript artifact (if any)
    try {
      await fetch(`/api/artifacts/${encodeURIComponent(id)}/transcript`, { method: "DELETE" });
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
    this.pendingBatchIds.delete(id);
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
    // Capture the reference-material fields before + after so we can:
    //   1. mirror description to Drive when it changes (ADR-074)
    //   2. debounce-regenerate reference.md when any of these change
    // Read them in one to_json call to keep cost flat.
    interface RefFields {
      status: string;
      description: string;
      title: string;
      summary_doc_id: string;
      recorded_at: string;
    }
    const readFields = (): RefFields => {
      try {
        const j = JSON.parse(record.to_json()) as { status?: string; description?: string | null; title?: string; summary_doc_id?: string | null; recorded_at?: string | null };
        return {
          status: j.status ?? "unknown",
          description: j.description ?? "",
          title: j.title ?? "",
          summary_doc_id: j.summary_doc_id ?? "",
          recorded_at: j.recorded_at ?? "",
        };
      } catch {
        return { status: "unknown", description: "", title: "", summary_doc_id: "", recorded_at: "" };
      }
    };
    const stateBefore = readFields();
    let events: string;
    try {
      events = fn(record);
    } catch (err) {
      clientLog("error", "wasm", "transition failed", { video_id: id, status_before: stateBefore.status, error: String(err) });
      // Defer notify to ensure WASM RefCell borrow is fully released
      // before any subsequent to_json() calls in persist()
      queueMicrotask(() => this.notify());
      throw err;
    }
    const stateAfter = readFields();
    clientLog("debug", "wasm", "transition", { video_id: id, status_before: stateBefore.status, status_after: stateAfter.status });
    this.touch(id);
    this.notify();
    this.scheduleRecordPush(id);
    if (stateAfter.description !== stateBefore.description) {
      this.scheduleDescriptionPush(id);
    }
    // ADR-074 §3 — reference.md aggregates title / description /
    // summary / recorded_at / status. Trigger a regenerate when any
    // of them changes.
    if (
      stateAfter.title !== stateBefore.title ||
      stateAfter.description !== stateBefore.description ||
      stateAfter.summary_doc_id !== stateBefore.summary_doc_id ||
      stateAfter.recorded_at !== stateBefore.recorded_at ||
      stateAfter.status !== stateBefore.status
    ) {
      this.scheduleReferenceRegen(id);
    }
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
