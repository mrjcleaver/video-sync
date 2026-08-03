/**
 * ADR-066 §7 — MCP token storage.
 *
 * Per-actor bearer tokens for headless MCP clients (Claude Desktop
 * Custom Connector, mcp-remote, etc.). Storage lives on the FUSE-
 * mounted bucket at `data/mcp-tokens.json`; the plaintext token is
 * never persisted — only a SHA-256 hash + a last-4 for display.
 *
 * On mint we return the plaintext ONCE to the caller; the operator
 * then puts it in Claude Desktop's Authorization header. Losing the
 * plaintext = revoke and re-mint.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { randomBytes, createHash } from "crypto";
import type { Role } from "./types/actor";

const TOKENS_FILE = join(process.cwd(), "data", "mcp-tokens.json");

export interface McpTokenRecord {
  id: string;                // uuid
  hash: string;              // sha256(plaintext)
  last4: string;             // last 4 chars of plaintext for display
  name: string;              // operator-supplied label (e.g. "Claude Desktop laptop")
  actor_email: string;       // owning user
  actor_role: Role;          // role at time of mint; frozen thereafter
  actor_user_id: string;
  created_at: string;
  last_used_at?: string;
  revoked_at?: string;
}

interface TokensStore {
  tokens: McpTokenRecord[];
}

async function readStore(): Promise<TokensStore> {
  try {
    const raw = await fs.readFile(TOKENS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TokensStore>;
    return { tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [] };
  } catch {
    return { tokens: [] };
  }
}

async function writeStore(store: TokensStore): Promise<void> {
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  await fs.writeFile(TOKENS_FILE, JSON.stringify(store, null, 2), "utf-8");
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function newUuid(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Mint a new token for the given actor. Plaintext returned ONCE. */
export async function mintToken(input: {
  name: string;
  actor_email: string;
  actor_role: Role;
  actor_user_id: string;
}): Promise<{ record: McpTokenRecord; plaintext: string }> {
  // 32 bytes of URL-safe base64 → ~43 characters. Prefix `vsync_` so
  // a leaked key is unambiguously identifiable in a code-search sweep.
  const raw = randomBytes(32).toString("base64url");
  const plaintext = `vsync_${raw}`;
  const record: McpTokenRecord = {
    id: newUuid(),
    hash: sha256(plaintext),
    last4: plaintext.slice(-4),
    name: input.name.trim() || "unnamed",
    actor_email: input.actor_email,
    actor_role: input.actor_role,
    actor_user_id: input.actor_user_id,
    created_at: new Date().toISOString(),
  };
  const store = await readStore();
  store.tokens.push(record);
  await writeStore(store);
  return { record, plaintext };
}

/** List non-revoked tokens for a specific actor (or all when actor_email null). */
export async function listTokens(actor_email: string | null): Promise<McpTokenRecord[]> {
  const store = await readStore();
  return store.tokens
    .filter(t => !t.revoked_at)
    .filter(t => (actor_email === null ? true : t.actor_email === actor_email))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Revoke a token by id. Only the token's owner (or an Admin) may revoke.
 *  Actual authorisation check lives in the route handler; this fn just persists. */
export async function revokeToken(id: string): Promise<boolean> {
  const store = await readStore();
  const t = store.tokens.find(x => x.id === id);
  if (!t) return false;
  if (t.revoked_at) return true;
  t.revoked_at = new Date().toISOString();
  await writeStore(store);
  return true;
}

/** Resolve a plaintext token to its record, updating last_used_at on
 *  a match. Returns null when the token is unknown or revoked. */
export async function resolveToken(plaintext: string): Promise<McpTokenRecord | null> {
  if (!plaintext || !plaintext.startsWith("vsync_")) return null;
  const store = await readStore();
  const hash = sha256(plaintext);
  const t = store.tokens.find(x => x.hash === hash);
  if (!t || t.revoked_at) return null;
  t.last_used_at = new Date().toISOString();
  // Fire-and-forget write; a resolve-time failure to persist last_used_at
  // shouldn't block the authenticated call.
  void writeStore(store).catch(() => {});
  return t;
}
