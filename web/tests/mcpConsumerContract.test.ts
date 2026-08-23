/**
 * Tests for the ADR-076 consumer contract — the guarantees an external
 * site (agentics.org) builds against when it reads the catalog over MCP
 * with a machine bearer token.
 *
 * Covers:
 *   §3   Access control — a Viewer-role token (what a chapter-website
 *        token SHALL be) sees only Published records; Publisher/Admin
 *        see every status; Contributor sees only their own records.
 *   §8.a contributor_email is stripped from Viewer-scoped returns and
 *        retained for Publisher/Admin.
 *   §8.b A machine token's audit identity is the token's `name`, not
 *        the email of the operator who minted it.
 *   §8.c The X-Consumer attribution header is captured on the actor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Actor, Role } from "../src/lib/types/actor";

// ── Catalog fixture ──────────────────────────────────────────────────────────
// readCatalog returns records as a map of id → JSON string, which is how
// loadVisibleRecords consumes it.

interface Fixture {
  id: string;
  status: string;
  title: string;
  contributor_email?: string | null;
}

const FIXTURES: Fixture[] = [
  { id: "pub-1", status: "Published", title: "Toronto session alpha" },
  { id: "pub-2", status: "Published", title: "Toronto session beta", contributor_email: "contrib@agentics.org" },
  { id: "disc-1", status: "Discovered", title: "Toronto session gamma" },
  { id: "appr-1", status: "Approved", title: "Toronto session delta" },
  { id: "fail-1", status: "Failed", title: "Toronto session epsilon" },
  { id: "aband-1", status: "Abandoned", title: "Toronto session zeta" },
  { id: "contrib-1", status: "InScope", title: "Toronto session eta", contributor_email: "contrib@agentics.org" },
];

function fixtureStore() {
  const records: Record<string, string> = {};
  const lastModified: Record<string, string> = {};
  for (const f of FIXTURES) {
    records[f.id] = JSON.stringify({
      id: f.id,
      source_id: `src-${f.id}`,
      source_platform: "Zoom",
      title: f.title,
      description: null,
      status: f.status,
      recorded_at: "2026-08-01T18:00:00Z",
      participants: [],
      tags: [],
      locations: [],
      upstream_links: [],
      ...(f.contributor_email ? { contributor_email: f.contributor_email } : {}),
    });
    lastModified[f.id] = "2026-08-01T18:00:00Z";
  }
  return { records, lastModified };
}

vi.mock("../src/app/api/catalog/route", () => ({
  readCatalog: vi.fn(async () => fixtureStore()),
}));

// Silence the structured logger — it writes to data/server.log on import.
vi.mock("../src/lib/serverLogger", () => ({
  serverLog: vi.fn(),
}));

function actorWith(role: Role, email = "operator@agentics.org"): Actor {
  return { user_id: `uid-${role}`, role, email, sub: `sub-${role}` };
}

async function importMcp() {
  vi.resetModules();
  return await import("../src/lib/mcpServer");
}

/** Run search_records and return the record ids it matched. `query`
 *  matches every fixture title. */
async function searchIds(actor: Actor): Promise<string[]> {
  const { handleMcpRpc } = await importMcp();
  const res = await handleMcpRpc(actor, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "search_records", arguments: { query: "toronto", limit: 100 } },
  });
  expect(res).not.toBeNull();
  expect(res).not.toHaveProperty("error");
  const result = (res as { result: { content: Array<{ text: string }> } }).result;
  const parsed = JSON.parse(result.content[0].text) as {
    hits: Array<{ id: string }>;
    results: Array<{ id: string }>;
  };
  // ADR-076 §4 names the array `hits`; `results` is the deprecated
  // pre-ADR-076 alias. Both must carry the same rows.
  expect(parsed.results.map(r => r.id)).toEqual(parsed.hits.map(h => h.id));
  return parsed.hits.map(h => h.id).sort();
}

/** Run get_provenance for one record and return the parsed payload. */
async function provenance(actor: Actor, record_id: string) {
  const { handleMcpRpc } = await importMcp();
  const res = await handleMcpRpc(actor, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_provenance", arguments: { record_id } },
  });
  if (res && "error" in res) return { error: res.error };
  const result = (res as { result: { content: Array<{ text: string }> } }).result;
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("ADR-076 §3 — role-scoped record visibility over MCP", () => {
  it("a Viewer token sees only Published records", async () => {
    expect(await searchIds(actorWith("Viewer"))).toEqual(["pub-1", "pub-2"]);
  });

  it("a Publisher token sees every status", async () => {
    expect(await searchIds(actorWith("Publisher"))).toEqual(
      ["aband-1", "appr-1", "contrib-1", "disc-1", "fail-1", "pub-1", "pub-2"],
    );
  });

  it("an Admin token sees every status", async () => {
    expect(await searchIds(actorWith("Admin"))).toEqual(
      ["aband-1", "appr-1", "contrib-1", "disc-1", "fail-1", "pub-1", "pub-2"],
    );
  });

  it("a Contributor token sees only its own records, at any status", async () => {
    // contrib-1 is InScope — a Contributor still sees it because it's
    // their own submission; the Published-only gate is Viewer-specific.
    expect(await searchIds(actorWith("Contributor", "contrib@agentics.org")))
      .toEqual(["contrib-1", "pub-2"]);
  });

  it("hides an unpublished record from a Viewer even on a direct record_id fetch", async () => {
    // The §3 gate lives in loadVisibleRecords, so per-record tools must
    // 404 rather than leak — a consumer can't guess its way past it.
    const res = await provenance(actorWith("Viewer"), "fail-1");
    expect(res).toHaveProperty("error");
    expect((res as { error: { message: string } }).error.message).toMatch(/not visible to your role/);
  });
});

describe("ADR-076 §8.a — contributor_email redaction", () => {
  it("strips contributor_email for a Viewer token", async () => {
    const p = await provenance(actorWith("Viewer"), "pub-2");
    expect(p.id).toBe("pub-2");
    expect(p.contributor_email).toBeNull();
  });

  it("retains contributor_email for a Publisher token", async () => {
    const p = await provenance(actorWith("Publisher"), "pub-2");
    expect(p.contributor_email).toBe("contrib@agentics.org");
  });

  it("retains contributor_email for an Admin token", async () => {
    const p = await provenance(actorWith("Admin"), "pub-2");
    expect(p.contributor_email).toBe("contrib@agentics.org");
  });

  it("leaves a Contributor seeing their own address", async () => {
    const p = await provenance(actorWith("Contributor", "contrib@agentics.org"), "pub-2");
    expect(p.contributor_email).toBe("contrib@agentics.org");
  });
});

// ── §8.b / §8.c — actor derivation for machine tokens ────────────────────────

const TOKEN_RECORD = {
  id: "tok-1",
  hash: "irrelevant",
  last4: "abcd",
  name: "agentics.org public site — production",
  actor_email: "martin.cleaver@agentics.org",  // the operator who minted it
  actor_role: "Viewer" as Role,
  actor_user_id: "uid-token-owner",
  created_at: "2026-08-19T00:00:00Z",
};

vi.mock("../src/lib/mcpTokens", () => ({
  resolveToken: vi.fn(async (plaintext: string) =>
    plaintext === "vsync_valid" ? TOKEN_RECORD : null,
  ),
}));

describe("ADR-076 §8.b/§8.c — machine-token identity + consumer attribution", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.ALLOW_NO_IAP;
    delete process.env.IAP_AUDIENCE;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  async function getActorFor(headers: Record<string, string>) {
    vi.resetModules();
    const { getActor } = await import("../src/lib/auth");
    return await getActor(new Request("https://mcp.example.com/api/mcp", { headers }));
  }

  it("resolves the token's frozen role and exposes its name for the audit log", async () => {
    const actor = await getActorFor({ authorization: "Bearer vsync_valid" });
    expect(actor.role).toBe("Viewer");
    expect(actor.token_name).toBe("agentics.org public site — production");
    // The minting operator's email is retained on the actor for
    // revoke / rotation flows; §8.b only removes it from the audit
    // line, which resolveActorForAudit handles.
    expect(actor.email).toBe("martin.cleaver@agentics.org");
  });

  it("captures the X-Consumer label on a token-authenticated request", async () => {
    const actor = await getActorFor({
      authorization: "Bearer vsync_valid",
      "x-consumer": "agentics.org/chapter/toronto",
    });
    expect(actor.consumer_ua).toBe("agentics.org/chapter/toronto");
  });

  it("captures X-Consumer on a dev-mode (non-token) request too", async () => {
    process.env.ALLOW_NO_IAP = "1";
    const actor = await getActorFor({ "x-consumer": "cache-warmer/build-42" });
    expect(actor.consumer_ua).toBe("cache-warmer/build-42");
  });

  it("leaves consumer_ua undefined when the header is absent or blank", async () => {
    process.env.ALLOW_NO_IAP = "1";
    expect((await getActorFor({})).consumer_ua).toBeUndefined();
    expect((await getActorFor({ "x-consumer": "   " })).consumer_ua).toBeUndefined();
  });

  it("rejects a revoked or unknown bearer token", async () => {
    await expect(getActorFor({ authorization: "Bearer vsync_bogus" }))
      .rejects.toThrow(/Invalid or revoked MCP bearer token/);
  });
});
