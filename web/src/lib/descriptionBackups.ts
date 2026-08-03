/**
 * ADR-064 follow-up — backups for YouTube description/title
 * overwrites. Every `/api/youtube/update-title` PUT captures the
 * prior snippet BEFORE writing new values. Keep the last N per
 * (record_id, yt_video_id) so an operator can undo a bad push.
 *
 * Storage: data/description-backups.json on FUSE, shared by both
 * services.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const BACKUPS_FILE = join(process.cwd(), "data", "description-backups.json");
const KEEP_PER_TARGET = 2;

export interface DescriptionBackup {
  id: string;
  record_id: string;
  yt_video_id: string;
  taken_at: string;
  taken_by: string;            // actor email at capture time
  prior_title: string;
  prior_description: string;
  new_title?: string;          // what we wrote AFTER this backup (for context)
  new_description?: string;
}

interface Store { backups: DescriptionBackup[] }

async function read(): Promise<Store> {
  try {
    const raw = await fs.readFile(BACKUPS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Store>;
    return { backups: Array.isArray(parsed.backups) ? parsed.backups : [] };
  } catch { return { backups: [] }; }
}

async function write(store: Store): Promise<void> {
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  await fs.writeFile(BACKUPS_FILE, JSON.stringify(store, null, 2), "utf-8");
}

function uuid(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

export async function captureBackup(input: Omit<DescriptionBackup, "id" | "taken_at">): Promise<DescriptionBackup> {
  const store = await read();
  const record: DescriptionBackup = {
    ...input,
    id: uuid(),
    taken_at: new Date().toISOString(),
  };
  store.backups.push(record);
  // Prune per (record_id, yt_video_id) — keep only the newest KEEP_PER_TARGET.
  const groups = new Map<string, DescriptionBackup[]>();
  for (const b of store.backups) {
    const key = `${b.record_id}:${b.yt_video_id}`;
    const arr = groups.get(key) ?? [];
    arr.push(b);
    groups.set(key, arr);
  }
  const kept: DescriptionBackup[] = [];
  for (const arr of groups.values()) {
    arr.sort((a, b) => b.taken_at.localeCompare(a.taken_at));
    kept.push(...arr.slice(0, KEEP_PER_TARGET));
  }
  store.backups = kept;
  await write(store);
  return record;
}

export async function listBackups(record_id: string | null): Promise<DescriptionBackup[]> {
  const store = await read();
  const all = record_id === null ? store.backups : store.backups.filter(b => b.record_id === record_id);
  return all.sort((a, b) => b.taken_at.localeCompare(a.taken_at));
}

export async function getBackup(id: string): Promise<DescriptionBackup | null> {
  const store = await read();
  return store.backups.find(b => b.id === id) ?? null;
}
