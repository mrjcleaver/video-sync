/**
 * ADR-077 §2 — destination resolution outside the browser.
 *
 * Two things under test:
 *   1. resolveDestinationsWith is genuinely pure — the layering obeys
 *      only its arguments, with no localStorage or warmed cache in play.
 *      This is what lets a server route, cron sweep or MCP tool ask
 *      "where is this record supposed to go".
 *   2. The server loaders read the same two FUSE files the client-facing
 *      endpoints serve, and degrade to empty-with-defaults exactly as
 *      the client does on a failed fetch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { promises as fs } from "fs";
import { resolveDestinationsWith, type ResolverInputs } from "../src/lib/destinationResolver";
import type { SeriesRegistryEntry } from "../src/lib/youtubeTitleAlign";
import type { ProcessingRule } from "../src/lib/processingRules";
import type { VideoRecordJSON } from "../src/lib/wasm";

function rec(title: string): VideoRecordJSON {
  return {
    id: "rec-1", source_id: "s-1", source_platform: "Zoom", title,
    description: null, created_at: "2026-08-01T00:00:00Z", duration_seconds: 3600,
    participants: [], transcript_text: null, download_url: "zoom://x",
    thumbnail_url: null, tags: [], notes: [], owners: [], moderators: [],
    status: "Approved", curated_by: null, curated_at: null,
    indexed_at: "2026-08-01T00:00:00Z", recorded_at: "2026-08-01T18:00:00Z",
    published_at: null, destination_id: null, destination_url: null,
    locations: [], upstream_links: [], rejected_links: [], metadata_extra: null,
  } as VideoRecordJSON;
}

const TORONTO: SeriesRegistryEntry = {
  series_name: "Agentics Toronto",
  pattern: "Agentics Toronto",
  destinations: [
    { platform: "YouTube", visibility: "public" },
    { platform: "Kaltura", visibility: "members" },
  ],
} as SeriesRegistryEntry;

/** A series that exists but declares no destinations — must fall through
 *  to the fallback path rather than resolving to an empty set. */
const NO_DESTS: SeriesRegistryEntry = {
  series_name: "Volunteer Training",
  pattern: "Volunteer Training",
} as SeriesRegistryEntry;

function inputs(over: Partial<ResolverInputs> = {}): ResolverInputs {
  return {
    registry: [],
    rules: [],
    profile: null,
    config: { youtube_fallback_when_no_series_match: true },
    ...over,
  };
}

describe("resolveDestinationsWith — pure layering", () => {
  it("takes the series' destinations when the title matches", () => {
    const r = resolveDestinationsWith(rec("Agentics Toronto - 1 Aug 2026"), inputs({ registry: [TORONTO] }));
    expect(r.provenance).toEqual({ source: "series", series_name: "Agentics Toronto" });
    expect(r.destinations.map(d => d.platform)).toEqual(["YouTube", "Kaltura"]);
  });

  it("falls back to the YouTube global default when nothing matches", () => {
    const r = resolveDestinationsWith(rec("Some one-off recording"), inputs({ registry: [TORONTO] }));
    expect(r.provenance).toEqual({ source: "global_default" });
    expect(r.destinations).toEqual([{ platform: "YouTube", visibility: "unlisted" }]);
  });

  it("resolves to nothing when the registry disables the fallback", () => {
    // ADR-077 §Decisions-resolved #2 — the toggle new deployments ship off.
    const r = resolveDestinationsWith(rec("Some one-off recording"), inputs({
      registry: [TORONTO],
      config: { youtube_fallback_when_no_series_match: false },
    }));
    expect(r.provenance).toEqual({ source: "no_match_no_fallback" });
    expect(r.destinations).toEqual([]);
  });

  it("uses the profile's default_privacy when a profile is driving", () => {
    const r = resolveDestinationsWith(rec("Some one-off recording"), inputs({
      profile: { id: "prof-1", default_privacy: "private" } as never,
    }));
    expect(r.provenance).toEqual({ source: "profile", profile_id: "prof-1" });
    expect(r.destinations).toEqual([{ platform: "YouTube", visibility: "private" }]);
  });

  it("matches a series that declares no destinations onto the fallback, not an empty set", () => {
    const r = resolveDestinationsWith(rec("Volunteer Training - 14 Aug 2026"), inputs({ registry: [NO_DESTS] }));
    expect(r.provenance).toEqual({ source: "global_default" });
    expect(r.destinations.map(d => d.platform)).toEqual(["YouTube"]);
  });

  it("matches an already-dated title — the title-alignment short-circuit must not hide destinations", () => {
    // Regression guard for the bug called out in findMatchingSeries: a
    // record already named "<series> - D MMM YYYY" still has to resolve.
    const r = resolveDestinationsWith(rec("Agentics Toronto - 14 Aug 2026"), inputs({ registry: [TORONTO] }));
    expect(r.provenance).toEqual({ source: "series", series_name: "Agentics Toronto" });
  });

  it("applies a privacy_status rule to the YouTube destination only", () => {
    const rule: ProcessingRule = {
      id: "r1", name: "force private", enabled: true, priority: 1,
      criteria: {}, transforms: { privacy_status: "private" },
    } as ProcessingRule;
    const r = resolveDestinationsWith(rec("Agentics Toronto - 1 Aug 2026"), inputs({
      registry: [TORONTO], rules: [rule],
    }));
    const yt = r.destinations.find(d => d.platform === "YouTube");
    const kal = r.destinations.find(d => d.platform === "Kaltura");
    expect(yt).toMatchObject({ visibility: "private" });
    // ADR-077 §Context — the rule layer can't reach Kaltura. Pinning the
    // current behaviour so follow-up #4 (transforms.destinations) has to
    // change this deliberately.
    expect(kal).toMatchObject({ visibility: "members" });
  });

  it("does not mutate the registry's declared destinations", () => {
    const rule: ProcessingRule = {
      id: "r1", name: "force private", enabled: true, priority: 1,
      criteria: {}, transforms: { privacy_status: "private" },
    } as ProcessingRule;
    resolveDestinationsWith(rec("Agentics Toronto - 1 Aug 2026"), inputs({ registry: [TORONTO], rules: [rule] }));
    // The series entry is a shared cached object; a rule transform that
    // wrote through to it would silently repoint every future publish.
    expect(TORONTO.destinations?.[0]).toMatchObject({ visibility: "public" });
  });

  it("ignores a disabled rule", () => {
    const rule: ProcessingRule = {
      id: "r1", name: "off", enabled: false, priority: 1,
      criteria: {}, transforms: { privacy_status: "private" },
    } as ProcessingRule;
    const r = resolveDestinationsWith(rec("Agentics Toronto - 1 Aug 2026"), inputs({
      registry: [TORONTO], rules: [rule],
    }));
    expect(r.destinations.find(d => d.platform === "YouTube")).toMatchObject({ visibility: "public" });
  });

  it("skips a series whose pattern is an invalid regex", () => {
    const broken = { series_name: "Broken", pattern: "([unclosed" } as SeriesRegistryEntry;
    const r = resolveDestinationsWith(rec("Agentics Toronto - 1 Aug 2026"), inputs({
      registry: [broken, TORONTO],
    }));
    expect(r.provenance).toEqual({ source: "series", series_name: "Agentics Toronto" });
  });
});

describe("server loaders", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  async function importServer() {
    vi.resetModules();
    return await import("../src/lib/destinationResolverServer");
  }

  it("reads entries and config from data/series-registry.json", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify({
      entries: [TORONTO],
      config: { youtube_fallback_when_no_series_match: false },
    }) as never);
    const { readSeriesRegistryServer } = await importServer();
    const out = await readSeriesRegistryServer();
    expect(out.entries).toHaveLength(1);
    expect(out.config.youtube_fallback_when_no_series_match).toBe(false);
  });

  it("defaults the fallback toggle to true when config is absent", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify({ entries: [] }) as never);
    const { readSeriesRegistryServer } = await importServer();
    expect((await readSeriesRegistryServer()).config.youtube_fallback_when_no_series_match).toBe(true);
  });

  it("degrades to empty-with-defaults when the registry file is missing", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValue(new Error("ENOENT"));
    const { readSeriesRegistryServer } = await importServer();
    const out = await readSeriesRegistryServer();
    expect(out.entries).toEqual([]);
    expect(out.config.youtube_fallback_when_no_series_match).toBe(true);
  });

  it("reads processingRules from data/rules.json", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify({
      processingRules: [{ id: "r1", name: "n", enabled: true, priority: 1, criteria: {}, transforms: {} }],
      postProcessingRules: [{ id: "ignored" }],
    }) as never);
    const { readProcessingRulesServer } = await importServer();
    const rules = await readProcessingRulesServer();
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("r1");
  });

  it("returns no rules when the file is malformed", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue("not json" as never);
    const { readProcessingRulesServer } = await importServer();
    expect(await readProcessingRulesServer()).toEqual([]);
  });

  it("resolves a record end to end from disk", async () => {
    vi.spyOn(fs, "readFile").mockImplementation((async (p: string) =>
      String(p).endsWith("series-registry.json")
        ? JSON.stringify({ entries: [TORONTO], config: {} })
        : JSON.stringify({ processingRules: [] })
    ) as never);
    const { resolveDestinationsServer } = await importServer();
    const r = await resolveDestinationsServer(rec("Agentics Toronto - 1 Aug 2026"));
    expect(r.provenance).toEqual({ source: "series", series_name: "Agentics Toronto" });
    expect(r.destinations.map(d => d.platform)).toEqual(["YouTube", "Kaltura"]);
  });
});
