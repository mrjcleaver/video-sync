/**
 * Server-side authentication and actor derivation for ADR-036.
 *
 * Two modes:
 *   1. Production (IAP): Cloud Run sits behind Identity-Aware Proxy. Every
 *      authenticated request carries `X-Goog-IAP-JWT-Assertion` — a signed
 *      JWT containing the user's email, sub, and Workspace claims. We
 *      validate the signature against Google's published keys and derive
 *      the Actor.
 *   2. Development (ALLOW_NO_IAP=1): no IAP. We synthesise an Admin actor
 *      so existing single-operator behaviour continues. This is the
 *      default until IAP is configured on the Cloud Run service.
 *
 * Group → Role mapping (ADR-036):
 *   video-sync-key-admins@<domain> → Admin
 *   video-sync-operators@<domain>  → Publisher
 *   video-sync-viewers@<domain>    → Viewer
 *
 * Group lookup is cached per session (5 min TTL) to amortise the Cloud
 * Identity Groups API call.
 *
 * Server-only — never import from client components.
 */

import { jwtVerify, createRemoteJWKSet } from "jose";
import { createHash } from "crypto";
import type { Actor, Role } from "./types/actor";
export type { Actor, Role } from "./types/actor";

const IAP_KEYS_URL = new URL("https://www.gstatic.com/iap/verify/public_key-jwk");
const ALLOW_NO_IAP = process.env.ALLOW_NO_IAP === "1";

// Boot-time misconfiguration guard (QE finding sec#2 / rev#5):
// having both flags set means a partial cutover has left auth disabled
// while the operator thinks IAP is active. Refuse to start.
if (ALLOW_NO_IAP && process.env.IAP_AUDIENCE) {
  throw new Error(
    "Auth misconfiguration: ALLOW_NO_IAP=1 and IAP_AUDIENCE are both set. " +
    "Choose one — either remove ALLOW_NO_IAP=1 to enable IAP enforcement, " +
    "or unset IAP_AUDIENCE to confirm dev mode is intentional.",
  );
}

// Synthetic admin actor for dev / pre-IAP single-user mode.
// Matches the legacy ADMIN_ACTOR UUID so existing event-sourced data still
// resolves to the same logical actor when IAP is later enabled and
// martin.cleaver@agentics.org becomes the bootstrap KeyAdmin.
// Email uses RFC-6761 reserved .invalid TLD so dev events never match a
// real audit log query (QE finding rev#14).
const DEV_ACTOR: Actor = {
  user_id: "00000000-0000-0000-0000-000000000001",
  role: "Admin",
  email: "dev-actor@invalid",
  sub: "dev",
};

const jwks = createRemoteJWKSet(IAP_KEYS_URL);

const groupCache = new Map<string, { roles: Role[]; expires: number }>();
const GROUP_TTL_MS = 5 * 60 * 1000;

/**
 * Derive a stable UUID v5 from a Google `sub` claim. Idempotent — same
 * sub always produces the same UUID — and avoids leaking the raw sub into
 * the WASM aggregate. Uses a project-specific namespace UUID per RFC 4122
 * §4.3 (QE finding sec#6: ensures off-the-shelf v5 generators reproduce
 * the same UUID for ops/recovery scenarios).
 */
const NAMESPACE_UUID = "f4b9e6d2-1c3a-4b2e-8c5d-7f8e9a0b1c2d"; // arbitrary, fixed
function uuidFromSub(sub: string): string {
  // RFC 4122: SHA-1 hash of (namespace bytes || name bytes), then set
  // version (5) and variant (RFC 4122) bits.
  const nsHex = NAMESPACE_UUID.replace(/-/g, "");
  const nsBytes = Buffer.from(nsHex, "hex");
  const nameBytes = Buffer.from(sub, "utf8");
  const input = Buffer.concat([nsBytes, nameBytes]);
  const hash = createHash("sha1").update(input).digest();
  // Set version 5 (high nibble of byte 6 = 0x5)
  hash[6] = (hash[6] & 0x0f) | 0x50;
  // Set variant (high two bits of byte 8 = 0b10)
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = hash.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Validate the IAP JWT and return its claims. Throws on invalid signature,
 * audience mismatch, or expired token.
 *
 * The expected audience is the Cloud Run service's IAP-assigned audience,
 * format `/projects/PROJECT_NUMBER/global/backendServices/SERVICE_ID`.
 * Configured via env var IAP_AUDIENCE.
 */
async function verifyIapJwt(token: string): Promise<{ email: string; sub: string }> {
  const audience = process.env.IAP_AUDIENCE;
  if (!audience) {
    throw new Error("IAP_AUDIENCE env var not set; refusing to validate without an expected audience");
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: "https://cloud.google.com/iap",
      audience,
    });
    if (typeof payload.email !== "string" || !payload.email) {
      throw new Error("IAP JWT missing email claim");
    }
    if (typeof payload.sub !== "string" || !payload.sub) {
      throw new Error("IAP JWT missing sub claim");
    }
    return { email: payload.email, sub: payload.sub };
  } catch (err) {
    // Diagnostic: decode the JWT without verifying signature so we can log
    // the actual audience IAP put in the token. Helps when the configured
    // IAP_AUDIENCE doesn't match the real one (e.g. wrong format guess).
    try {
      const parts = token.split(".");
      if (parts.length === 3) {
        const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
        // Mask the local-part of the email so the diagnostic surfaces the
        // domain (useful for "wrong tenant" debugging) without writing the
        // user's address to stdout / Cloud Logging on every failed request.
        const email = typeof claims.email === "string"
          ? claims.email.replace(/^[^@]+/, (m: string) => `${m.slice(0, 1)}***`)
          : "(none)";
        console.warn(`IAP JWT verification failed. Expected audience='${audience}', got aud='${claims.aud}', iss='${claims.iss}', email='${email}'. Reason: ${err instanceof Error ? err.message : err}`);
      }
    } catch { /* swallow — diagnostic only */ }
    throw err;
  }
}

/**
 * Look up the user's Video Sync roles. Returns the highest applicable
 * role, or `null` if the user is in none of the three groups — callers
 * must treat null as "deny" (QE finding sec#8 + rev#9).
 *
 * Resolution order:
 *  1. Cloud Identity Groups API (`groups/-/memberships:searchTransitiveGroups`)
 *     when WS_DOMAIN is set. The Cloud Run runtime SA must have
 *     permission to query group membership — typically by being a
 *     Manager of each of the three groups (configured in Workspace
 *     Admin > Groups), or by a project-wide Group Reader role.
 *  2. Env var allowlist fallback (KEY_ADMIN_EMAILS / OPERATOR_EMAILS /
 *     VIEWER_EMAILS) — used when the API path is unavailable or fails,
 *     so the operator can ship a working deploy without waiting on
 *     Workspace plumbing.
 *
 * Failures in the API path are logged but downgraded to the env-var
 * fallback so a transient Cloud Identity outage doesn't 401 every
 * authenticated user.
 */
async function lookupRole(email: string): Promise<Role | null> {
  const cached = groupCache.get(email);
  if (cached && cached.expires > Date.now()) return highestRole(cached.roles);

  // Three-state outcome from the Cloud Identity attempt:
  //   roles !== null → API authoritative (use result, even if empty = deny)
  //   roles === null → API not attempted OR threw — fall through to env vars
  let roles: Role[] | null = null;
  const wsDomain = process.env.WS_DOMAIN;
  if (wsDomain) {
    try {
      roles = await rolesFromCloudIdentity(email, wsDomain);
    } catch (err) {
      console.warn(`Cloud Identity lookup failed for ${email}: ${err instanceof Error ? err.message : err}`);
      // roles stays null — caller falls through to env-var allowlist
    }
  }

  if (roles === null) {
    roles = [];
    const keyAdmins = (process.env.KEY_ADMIN_EMAILS ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const operators = (process.env.OPERATOR_EMAILS ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const viewers = (process.env.VIEWER_EMAILS ?? "").split(",").map(s => s.trim()).filter(Boolean);
    if (keyAdmins.includes(email)) roles.push("Admin");
    if (operators.includes(email)) roles.push("Publisher");
    if (viewers.includes(email)) roles.push("Viewer");
  }

  groupCache.set(email, { roles, expires: Date.now() + GROUP_TTL_MS });
  return highestRole(roles);
}

/**
 * Resolve roles from Cloud Identity by checking each video-sync group
 * for the user's membership.
 *
 * We deliberately don't use `memberships:searchTransitiveGroups` —
 * that API requires the caller to have Workspace user-reader admin
 * privileges, which the runtime SA doesn't have. Instead we query
 * each group via `groups:lookup` + `memberships:lookup`, which the
 * SA *can* do because it's a MEMBER+MANAGER on each group.
 *
 * Group resource names (groups/{id}) are stable and cached for 24h
 * to avoid the lookup round-trip on every role check.
 */
const GROUP_NAME_TTL_MS = 24 * 60 * 60 * 1000;
const groupNameCache = new Map<string, { name: string; expires: number }>();

async function resolveGroupName(token: string, groupEmail: string): Promise<string | null> {
  const cached = groupNameCache.get(groupEmail);
  if (cached && cached.expires > Date.now()) return cached.name;
  const url = new URL("https://cloudidentity.googleapis.com/v1/groups:lookup");
  url.searchParams.set("groupKey.id", groupEmail);
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`groups:lookup ${groupEmail} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { name?: string };
  if (!data.name) return null;
  groupNameCache.set(groupEmail, { name: data.name, expires: Date.now() + GROUP_NAME_TTL_MS });
  return data.name;
}

async function isMemberOfGroup(token: string, groupName: string, userEmail: string): Promise<boolean> {
  const url = new URL(`https://cloudidentity.googleapis.com/v1/${groupName}/memberships:lookup`);
  url.searchParams.set("memberKey.id", userEmail);
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`memberships:lookup ${groupName} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true; // 200 → membership exists
}

async function rolesFromCloudIdentity(email: string, domain: string): Promise<Role[]> {
  const token = await getMetadataAccessToken();
  const groups: Array<{ email: string; role: Role }> = [
    { email: `video-sync-key-admins@${domain}`, role: "Admin" },
    { email: `video-sync-operators@${domain}`, role: "Publisher" },
    { email: `video-sync-viewers@${domain}`, role: "Viewer" },
  ];
  const roles: Role[] = [];
  for (const g of groups) {
    const name = await resolveGroupName(token, g.email);
    if (!name) continue;                                 // group doesn't exist → skip
    if (await isMemberOfGroup(token, name, email)) roles.push(g.role);
  }
  return roles;
}

let cachedToken: { value: string; expires: number } | null = null;
async function getMetadataAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 30_000) return cachedToken.value;
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) throw new Error(`Metadata token fetch ${res.status}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  cachedToken = {
    value: data.access_token,
    expires: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.value;
}

function highestRole(roles: Role[]): Role | null {
  if (roles.includes("Admin")) return "Admin";
  if (roles.includes("Publisher")) return "Publisher";
  if (roles.includes("Viewer")) return "Viewer";
  return null;  // user is in no group — deny
}

/**
 * Read the IAP JWT from the request and resolve the Actor.
 * Falls back to DEV_ACTOR when ALLOW_NO_IAP=1 (development).
 *
 * Throws when production mode and the JWT is absent or invalid — callers
 * should catch and return 401.
 */
export async function getActor(req: Request): Promise<Actor> {
  if (ALLOW_NO_IAP) return DEV_ACTOR;

  const jwt = req.headers.get("x-goog-iap-jwt-assertion");
  if (!jwt) throw new Error("Missing X-Goog-IAP-JWT-Assertion header — request is not IAP-fronted");

  const { email, sub } = await verifyIapJwt(jwt);
  const role = await lookupRole(email);
  if (role === null) {
    throw new Error(`Access denied: ${email} is not a member of any video-sync group. Contact your Workspace admin to request access.`);
  }
  return {
    user_id: uuidFromSub(sub),
    role,
    email,
    sub,
  };
}

/**
 * Test-only helper to flush the group cache (used by /api/auth/flush-cache
 * when an admin needs to revoke access immediately rather than waiting for
 * TTL).
 */
export function flushGroupCache(): void {
  groupCache.clear();
}
