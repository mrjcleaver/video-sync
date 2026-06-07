/**
 * Tests for the defensive guard in web/src/app/api/catalog/route.ts —
 * specifically that `readCatalog` coerces wrong-type `records` /
 * `lastModified` values to `{}` instead of returning them as-is.
 *
 * Background: 2026-06-07 incident — a Python migration clobbered
 * `lastModified` from an object to a single ISO string, and every
 * subsequent POST /api/catalog threw `TypeError: Cannot create
 * property '<id>' on string '...'`. The route now type-checks the
 * deserialized JSON before returning the store.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { promises as fs } from "fs";

const ROUTE_MODULE = "../src/app/api/catalog/route";

async function importRoute() {
  vi.resetModules();
  return await import(ROUTE_MODULE);
}

function makeGetReq(): Request {
  return new Request("https://example.com/api/catalog", { method: "GET" });
}

function makePostReq(body: unknown): Request {
  return new Request("https://example.com/api/catalog", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("catalog/route readCatalog — shape guard (incident 2026-06-07)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the parsed store unchanged when both fields are plain objects", async () => {
    const good = {
      records: { "abc": '{"id":"abc"}' },
      lastModified: { "abc": "2026-06-07T15:50:49Z" },
    };
    vi.spyOn(fs, "readFile").mockResolvedValueOnce(JSON.stringify(good));
    const mod = await importRoute();
    // GET handler returns whatever readCatalog returns
    const res = await mod.GET(makeGetReq() as never);
    const body = await res.json();
    expect(body.records).toEqual(good.records);
    expect(body.lastModified).toEqual(good.lastModified);
  });

  it("coerces a string `lastModified` (the actual incident shape) to {}", async () => {
    const corrupt = {
      records: { "abc": '{"id":"abc"}' },
      lastModified: "2026-06-07T15:50:49+00:00Z",  // <-- the bug
    };
    vi.spyOn(fs, "readFile").mockResolvedValueOnce(JSON.stringify(corrupt));
    const mod = await importRoute();
    const res = await mod.GET(makeGetReq() as never);
    const body = await res.json();
    expect(body.records).toEqual(corrupt.records);  // records intact
    expect(body.lastModified).toEqual({});           // string coerced to {}
  });

  it("coerces an array `records` to {} (defends against the symmetric case)", async () => {
    const corrupt = {
      records: ["not", "an", "object"],
      lastModified: {},
    };
    vi.spyOn(fs, "readFile").mockResolvedValueOnce(JSON.stringify(corrupt));
    const mod = await importRoute();
    const res = await mod.GET(makeGetReq() as never);
    const body = await res.json();
    expect(body.records).toEqual({});
    expect(body.lastModified).toEqual({});
  });

  it("coerces a null `lastModified` to {}", async () => {
    const corrupt = {
      records: {},
      lastModified: null,
    };
    vi.spyOn(fs, "readFile").mockResolvedValueOnce(JSON.stringify(corrupt));
    const mod = await importRoute();
    const res = await mod.GET(makeGetReq() as never);
    const body = await res.json();
    expect(body.lastModified).toEqual({});
  });

  it("returns the empty store when the file doesn't exist (ENOENT path)", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(new Error("ENOENT"));
    const mod = await importRoute();
    const res = await mod.GET(makeGetReq() as never);
    const body = await res.json();
    expect(body).toEqual({ records: {}, lastModified: {} });
  });

  it("POST after recovering from a corrupt lastModified now succeeds", async () => {
    // First call reads the corrupt file...
    const corrupt = {
      records: { "abc": '{"id":"abc"}' },
      lastModified: "2026-06-07T15:50:49+00:00Z",
    };
    let stored = JSON.stringify(corrupt);
    vi.spyOn(fs, "readFile").mockImplementation(async () => stored);
    vi.spyOn(fs, "writeFile").mockImplementation(async (_path, data) => {
      stored = String(data);
    });
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const mod = await importRoute();

    const req = makePostReq({
      id: "xyz-record",
      json: JSON.stringify({ id: "xyz-record" }),
      lastModified: "2026-06-07T20:00:00Z",
    });
    // Cast Request → NextRequest at the boundary; the route only
    // reads .json() which both have.
    const res = await mod.POST(req as never);
    expect(res.status).toBe(200);
    // The on-disk shape after the write should be self-healed:
    const written = JSON.parse(stored);
    expect(written.lastModified).toEqual({ "xyz-record": "2026-06-07T20:00:00Z" });
    expect(written.records["xyz-record"]).toBeTruthy();
  });
});
