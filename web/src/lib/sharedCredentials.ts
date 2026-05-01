/**
 * Shared-credentials resolver (ADR-042 Phase 1).
 *
 * Server-side cache + Google Secret Manager wrapper for credentials
 * that key admins choose to make available to every operator. Each
 * platform stores ONE secret with a JSON-serialised body whose shape
 * is platform-specific (see PLATFORM_SHAPES below).
 *
 * Naming convention: `video-sync-shared-<platform>` (Secret Manager
 * doesn't allow `/` in secret names; we use a flat hyphen-separated
 * namespace).
 *
 * Read path: latest version, parsed and cached for 5 minutes per
 * Cloud Run instance. Misses pull from Secret Manager on demand.
 *
 * Write/delete path: Admin role only (gated by the route handler).
 * Each write creates a new version; old versions are auto-disabled
 * to keep the secret list lean.
 *
 * YouTube is deliberately absent — per ADR-042 it stays per-operator
 * for brand-account attribution.
 */

import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { serverLog } from "./serverLogger";

export const SHARED_PLATFORMS = ["zoom", "fireflies", "kaltura", "openrouter", "opusclip"] as const;
export type SharedPlatform = (typeof SHARED_PLATFORMS)[number];

export interface SharedSecretMeta {
  configured: boolean;
  set_by?: string;       // email of the key admin who last wrote this
  set_at?: string;       // ISO timestamp of the latest version
  version_count?: number; // including disabled
}

const SECRET_PREFIX = "video-sync-shared-";
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  value: Record<string, unknown> | null;
  cachedAt: number;
}

const valueCache = new Map<SharedPlatform, CacheEntry>();
let _client: SecretManagerServiceClient | null = null;

function client(): SecretManagerServiceClient {
  if (!_client) _client = new SecretManagerServiceClient();
  return _client;
}

function projectId(): string {
  const p = process.env.GOOGLE_CLOUD_PROJECT
    ?? process.env.GCP_PROJECT
    ?? process.env.PROJECT_ID
    ?? "agentics-487016";
  return p;
}

function secretName(platform: SharedPlatform): string {
  return `projects/${projectId()}/secrets/${SECRET_PREFIX}${platform}`;
}

function isSharedPlatform(s: string): s is SharedPlatform {
  return (SHARED_PLATFORMS as readonly string[]).includes(s);
}

/**
 * Fetch the latest version of a shared secret. Returns null if the
 * secret does not exist or has no enabled version. Cached 5 min.
 */
export async function getSharedCredential(platform: SharedPlatform): Promise<Record<string, unknown> | null> {
  const cached = valueCache.get(platform);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;

  let value: Record<string, unknown> | null = null;
  try {
    const [resp] = await client().accessSecretVersion({
      name: `${secretName(platform)}/versions/latest`,
    });
    const payload = resp.payload?.data;
    if (payload) {
      const text = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf-8");
      try {
        value = JSON.parse(text) as Record<string, unknown>;
      } catch {
        serverLog("warn", "shared-creds", "secret payload not JSON", { platform });
      }
    }
  } catch (err: unknown) {
    const code = (err as { code?: number | string }).code;
    if (code !== 5 && code !== "NOT_FOUND") {
      // 5 = NOT_FOUND in gRPC; anything else is a real error worth logging
      serverLog("warn", "shared-creds", "fetch failed", { platform, error: String(err).slice(0, 200) });
    }
    value = null;
  }
  valueCache.set(platform, { value, cachedAt: Date.now() });
  return value;
}

/**
 * Write (or replace) a shared secret. Creates the secret if missing,
 * adds a new version, and disables prior enabled versions. Returns
 * the new version's create time as ISO. Caller must enforce Admin role.
 */
export async function setSharedCredential(
  platform: SharedPlatform,
  body: Record<string, unknown>,
  actorEmail: string,
): Promise<{ created_at: string; version: string }> {
  const sc = client();
  const parent = `projects/${projectId()}`;
  const sName = `${SECRET_PREFIX}${platform}`;

  // 1. Ensure the secret exists. createSecret throws ALREADY_EXISTS (6) if so.
  try {
    await sc.createSecret({
      parent,
      secretId: sName,
      secret: {
        replication: { automatic: {} },
        labels: { app: "video-sync", platform },
      },
    });
  } catch (err: unknown) {
    const code = (err as { code?: number | string }).code;
    if (code !== 6 && code !== "ALREADY_EXISTS") throw err;
  }

  // 2. Add a new version with the JSON body + actor stamp in a separate label
  //    field — labels are limited to 63 chars and ASCII-safe so we put email
  //    in a payload metadata key, NOT a Secret Manager label.
  const stamped = { ...body, _set_by: actorEmail, _set_at: new Date().toISOString() };
  const data = Buffer.from(JSON.stringify(stamped), "utf-8");
  const [version] = await sc.addSecretVersion({
    parent: secretName(platform),
    payload: { data },
  });

  // 3. Disable older enabled versions — keep the latest only.
  try {
    const [versions] = await sc.listSecretVersions({ parent: secretName(platform) });
    for (const v of versions) {
      if (!v.name) continue;
      if (v.name === version.name) continue;
      if (v.state === "ENABLED") {
        await sc.disableSecretVersion({ name: v.name }).catch(() => undefined);
      }
    }
  } catch {
    // Best-effort; old versions linger but don't affect correctness
  }

  // Invalidate cache so next read pulls fresh
  valueCache.delete(platform);

  return {
    created_at: stamped._set_at,
    version: version.name ?? "",
  };
}

/**
 * Delete the shared secret (all versions). After deletion the platform
 * falls through to operator override (or "unconfigured"). Caller must
 * enforce Admin role.
 */
export async function deleteSharedCredential(platform: SharedPlatform): Promise<void> {
  try {
    await client().deleteSecret({ name: secretName(platform) });
  } catch (err: unknown) {
    const code = (err as { code?: number | string }).code;
    if (code !== 5 && code !== "NOT_FOUND") throw err;
  }
  valueCache.delete(platform);
}

/**
 * Read metadata for all shared platforms — what's configured, who set
 * it, when. Never returns the secret values themselves; safe to surface
 * to non-admin authenticated users so the Connections UI can show
 * "Source: shared default (set by …)".
 */
export async function listSharedSecretMeta(): Promise<Record<SharedPlatform, SharedSecretMeta>> {
  const out = {} as Record<SharedPlatform, SharedSecretMeta>;
  await Promise.all(SHARED_PLATFORMS.map(async (p) => {
    out[p] = await getSharedSecretMeta(p);
  }));
  return out;
}

async function getSharedSecretMeta(platform: SharedPlatform): Promise<SharedSecretMeta> {
  // Read the latest payload to extract _set_by / _set_at; this is the only
  // place those metadata fields surface back. We don't expose the rest.
  const value = await getSharedCredential(platform);
  if (!value) return { configured: false };
  let version_count: number | undefined;
  try {
    const [versions] = await client().listSecretVersions({ parent: secretName(platform) });
    version_count = versions.length;
  } catch { /* best effort */ }
  return {
    configured: true,
    set_by: typeof value._set_by === "string" ? value._set_by : undefined,
    set_at: typeof value._set_at === "string" ? value._set_at : undefined,
    version_count,
  };
}

/**
 * Resolve a platform-specific credential — operator override (when
 * supplied) takes precedence; otherwise the shared secret. Returns
 * null when neither is configured. Strips the `_set_by`/`_set_at`
 * metadata fields before returning.
 *
 * @param platform           The platform key
 * @param operatorOverride   The credentials the operator passed in the
 *                           request body (any partial shape). When the
 *                           operator passes a non-empty object we treat
 *                           it as an override.
 */
export async function resolveCredential(
  platform: SharedPlatform,
  operatorOverride?: Record<string, unknown> | null | undefined,
): Promise<Record<string, unknown> | null> {
  if (operatorOverride && hasAnyTruthyValue(operatorOverride)) {
    return operatorOverride;
  }
  const shared = await getSharedCredential(platform);
  if (!shared) return null;
  // Strip our internal metadata before handing back
  const { _set_by, _set_at, ...rest } = shared as Record<string, unknown> & { _set_by?: unknown; _set_at?: unknown };
  void _set_by; void _set_at;
  return rest;
}

function hasAnyTruthyValue(o: Record<string, unknown>): boolean {
  return Object.values(o).some(v => v != null && v !== "");
}

export function flushSharedCache(): void {
  valueCache.clear();
}

export { isSharedPlatform };
