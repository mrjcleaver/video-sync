/**
 * ADR-066 §4 follow-up — OAuth 2.1 + PKCE surface for Claude Desktop's
 * Custom Connector.
 *
 * Storage: data/mcp-oauth.json on FUSE. Two kinds:
 *   - Registered clients (RFC 7591) — {client_id, name, redirect_uris[]}
 *   - Authorization codes — short-lived (10 min) single-use envelopes
 *     bound to a client_id, PKCE code_challenge, and the IAP-authed actor.
 *
 * Access tokens issued at /token are just `vsync_` bearer tokens minted
 * through the existing mcpTokens store, so the MCP endpoint's Bearer
 * check keeps working with no branch.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { randomBytes, createHash } from "crypto";

const STORE_FILE = join(process.cwd(), "data", "mcp-oauth.json");

export interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: string;
}

export interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  scope?: string;
  actor_email: string;
  actor_role: string;
  actor_user_id: string;
  expires_at: string;      // ISO
  redeemed_at?: string;    // set to lock a code to single-use
}

interface Store {
  clients: OAuthClient[];
  codes: AuthCode[];
}

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Store>;
    return {
      clients: Array.isArray(parsed.clients) ? parsed.clients : [],
      codes: Array.isArray(parsed.codes) ? parsed.codes : [],
    };
  } catch {
    return { clients: [], codes: [] };
  }
}

async function writeStore(s: Store): Promise<void> {
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  // Prune expired codes on every write so the file doesn't grow unboundedly.
  const now = Date.now();
  s.codes = s.codes.filter(c => new Date(c.expires_at).getTime() > now - 3600_000);
  await fs.writeFile(STORE_FILE, JSON.stringify(s, null, 2), "utf-8");
}

function rand(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

// ── Clients (RFC 7591 dynamic registration) ────────────────────

export async function registerClient(input: { client_name?: string; redirect_uris: string[] }): Promise<OAuthClient> {
  const s = await readStore();
  const client: OAuthClient = {
    client_id: `mcp_${rand(16)}`,
    client_name: input.client_name,
    redirect_uris: input.redirect_uris,
    created_at: new Date().toISOString(),
  };
  s.clients.push(client);
  await writeStore(s);
  return client;
}

export async function getClient(client_id: string): Promise<OAuthClient | null> {
  const s = await readStore();
  return s.clients.find(c => c.client_id === client_id) ?? null;
}

// ── Authorization codes ────────────────────────────────────────

export async function issueCode(input: Omit<AuthCode, "code" | "expires_at" | "redeemed_at">): Promise<string> {
  const s = await readStore();
  const code = `code_${rand(24)}`;
  const record: AuthCode = {
    ...input,
    code,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
  s.codes.push(record);
  await writeStore(s);
  return code;
}

/** Redeem a code: returns the auth-code record on success, or an
 *  error string. Records the redemption so double-use is rejected. */
export async function redeemCode(input: {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_verifier: string;
}): Promise<{ ok: true; record: AuthCode } | { ok: false; error: string }> {
  const s = await readStore();
  const rec = s.codes.find(c => c.code === input.code);
  if (!rec) return { ok: false, error: "invalid_grant" };
  if (rec.redeemed_at) return { ok: false, error: "invalid_grant" };
  if (new Date(rec.expires_at).getTime() < Date.now()) return { ok: false, error: "invalid_grant" };
  if (rec.client_id !== input.client_id) return { ok: false, error: "invalid_grant" };
  if (rec.redirect_uri !== input.redirect_uri) return { ok: false, error: "invalid_grant" };
  // PKCE verification: base64url(sha256(code_verifier)) === code_challenge
  const hash = createHash("sha256").update(input.code_verifier).digest();
  const computed = hash.toString("base64url");
  if (computed !== rec.code_challenge) return { ok: false, error: "invalid_grant" };
  rec.redeemed_at = new Date().toISOString();
  await writeStore(s);
  return { ok: true, record: rec };
}
