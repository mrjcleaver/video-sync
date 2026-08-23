/**
 * The bulk-automation kill switch.
 *
 * The property that matters most is the direction of failure: every
 * uncertain state — missing file, corrupt file, failed fetch, not yet
 * warmed — must read as DISABLED. Erring that way costs a skipped tick;
 * erring the other way publishes videos nobody asked for.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";

async function importRoute() {
  vi.resetModules();
  return await import("../src/app/api/admin/automation/route");
}

async function importClient() {
  vi.resetModules();
  return await import("../src/lib/bulkAutomation");
}

function putReq(body: unknown) {
  return new Request("https://x/api/admin/automation", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("automation route — read path defaults to off", () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => { vi.restoreAllMocks(); process.env.ALLOW_NO_IAP = "1"; });
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

  it("is off when no setting has ever been stored", async () => {
    // The fresh-deployment case: shipping a publish-path change must not
    // start unattended uploads before an operator opts in.
    vi.spyOn(fs, "readFile").mockRejectedValue(new Error("ENOENT"));
    const { GET } = await importRoute();
    const body = await (await GET(new Request("https://x") as never)).json();
    expect(body.bulk_enabled).toBe(false);
  });

  it("is off when the file is corrupt", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue("not json" as never);
    const { GET } = await importRoute();
    expect((await (await GET(new Request("https://x") as never)).json()).bulk_enabled).toBe(false);
  });

  it("is off when the flag is a truthy non-boolean", async () => {
    // Guards against "true" (the string) or 1 reading as enabled.
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify({ bulk_enabled: "true" }) as never);
    const { GET } = await importRoute();
    expect((await (await GET(new Request("https://x") as never)).json()).bulk_enabled).toBe(false);
  });

  it("reports on only when explicitly stored as true", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify({
      bulk_enabled: true, set_by: "admin@agentics.org", set_at: "2026-08-23T00:00:00Z",
    }) as never);
    const { GET } = await importRoute();
    const body = await (await GET(new Request("https://x") as never)).json();
    expect(body.bulk_enabled).toBe(true);
    expect(body.set_by).toBe("admin@agentics.org");
  });
});

describe("automation route — write path", () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
  });
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

  it("stores the flag with who changed it", async () => {
    process.env.ALLOW_NO_IAP = "1";   // DEV_ACTOR is Admin
    let written = "";
    vi.spyOn(fs, "writeFile").mockImplementation(async (_p, data) => { written = String(data); });
    const { PUT } = await importRoute();
    const res = await PUT(putReq({ bulk_enabled: true }) as never);
    expect(res.status).toBe(200);
    const stored = JSON.parse(written);
    expect(stored.bulk_enabled).toBe(true);
    expect(stored.set_by).toBe("dev-actor@invalid");
    expect(stored.set_at).toBeTruthy();
  });

  it("rejects a non-boolean flag", async () => {
    process.env.ALLOW_NO_IAP = "1";
    const { PUT } = await importRoute();
    const res = await PUT(putReq({ bulk_enabled: "yes" }) as never);
    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated caller", async () => {
    // No ALLOW_NO_IAP and no IAP header → getActor throws → 401.
    delete process.env.ALLOW_NO_IAP;
    process.env.IAP_AUDIENCE = "/projects/1/global/backendServices/2";
    const { PUT } = await importRoute();
    const res = await PUT(putReq({ bulk_enabled: true }) as never);
    expect(res.status).toBe(401);
  });
});

describe("client accessor — disabled until proven otherwise", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("reads disabled before the first fetch resolves", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));   // never settles
    const { isBulkAutomationEnabled } = await importClient();
    // A timer firing during page load must not slip through.
    expect(isBulkAutomationEnabled()).toBe(false);
  });

  it("reads disabled when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { getAutomationSettings, isBulkAutomationEnabled } = await importClient();
    await getAutomationSettings();
    expect(isBulkAutomationEnabled()).toBe(false);
  });

  it("reads disabled when the route errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    const { getAutomationSettings, isBulkAutomationEnabled } = await importClient();
    await getAutomationSettings();
    expect(isBulkAutomationEnabled()).toBe(false);
  });

  it("reads enabled once the route says so", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ bulk_enabled: true }),
    }));
    const { getAutomationSettings, isBulkAutomationEnabled } = await importClient();
    await getAutomationSettings();
    expect(isBulkAutomationEnabled()).toBe(true);
  });

  it("does not treat a truthy non-boolean from the wire as enabled", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ bulk_enabled: "true" }),
    }));
    const { getAutomationSettings, isBulkAutomationEnabled } = await importClient();
    await getAutomationSettings();
    expect(isBulkAutomationEnabled()).toBe(false);
  });

  it("caches after the first successful read", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ bulk_enabled: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getAutomationSettings } = await importClient();
    await getAutomationSettings();
    await getAutomationSettings();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
