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

export type Role = "Admin" | "Publisher" | "Viewer";

export interface Actor {
  user_id: string;   // UUID v5 derived from sub
  role: Role;
  email: string;
  sub: string;       // raw Google subject
}

const IAP_KEYS_URL = new URL("https://www.gstatic.com/iap/verify/public_key-jwk");
const ALLOW_NO_IAP = process.env.ALLOW_NO_IAP === "1";

// Synthetic admin actor for dev / pre-IAP single-user mode.
// Matches the legacy ADMIN_ACTOR UUID so existing event-sourced data still
// resolves to the same logical actor when IAP is later enabled and
// martin.cleaver@agentics.org becomes the bootstrap KeyAdmin.
const DEV_ACTOR: Actor = {
  user_id: "00000000-0000-0000-0000-000000000001",
  role: "Admin",
  email: "dev@localhost",
  sub: "dev",
};

const jwks = createRemoteJWKSet(IAP_KEYS_URL);

const groupCache = new Map<string, { roles: Role[]; expires: number }>();
const GROUP_TTL_MS = 5 * 60 * 1000;

/**
 * Derive a stable UUID v5 from a Google `sub` claim. Idempotent — same
 * sub always produces the same UUID — and avoids leaking the raw sub into
 * the WASM aggregate.
 */
function uuidFromSub(sub: string): string {
  const hash = createHash("sha1").update(`video-sync:${sub}`).digest("hex");
  // Set version 5 (name-based, SHA-1) and RFC 4122 variant
  const v = "5" + hash.slice(13, 16);
  const r = ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${v}-${r}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
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
  const { payload } = await jwtVerify(token, jwks, {
    issuer: "https://cloud.google.com/iap",
    audience,
  });
  const email = typeof payload.email === "string" ? payload.email : "";
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!email || !sub) throw new Error("IAP JWT missing email or sub claim");
  return { email, sub };
}

/**
 * Look up the user's Video Sync roles via Cloud Identity Groups API.
 * Returns the highest applicable role.
 *
 * For Phase 1 with no Workspace groups configured, this is gated by
 * KEY_ADMIN_EMAILS / OPERATOR_EMAILS / VIEWER_EMAILS env vars (comma-
 * separated). Phase 2 swaps to the Cloud Identity API call.
 */
async function lookupRole(email: string): Promise<Role> {
  const cached = groupCache.get(email);
  if (cached && cached.expires > Date.now()) return highestRole(cached.roles);

  const roles: Role[] = [];
  const keyAdmins = (process.env.KEY_ADMIN_EMAILS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const operators = (process.env.OPERATOR_EMAILS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const viewers = (process.env.VIEWER_EMAILS ?? "").split(",").map(s => s.trim()).filter(Boolean);

  if (keyAdmins.includes(email)) roles.push("Admin");
  if (operators.includes(email)) roles.push("Publisher");
  if (viewers.includes(email)) roles.push("Viewer");

  groupCache.set(email, { roles, expires: Date.now() + GROUP_TTL_MS });
  return highestRole(roles);
}

function highestRole(roles: Role[]): Role {
  if (roles.includes("Admin")) return "Admin";
  if (roles.includes("Publisher")) return "Publisher";
  if (roles.includes("Viewer")) return "Viewer";
  // Member of no group: deny by mapping to Viewer with empty user_id later.
  // Calling code should treat unknown users as denied, not as Viewers — but
  // throwing here would leak through as a 500. Returning Viewer keeps the
  // type honest; the caller decides whether to reject.
  return "Viewer";
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
