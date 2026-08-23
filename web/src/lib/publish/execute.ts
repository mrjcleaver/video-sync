/**
 * ADR-077 §3 — one executor over the resolved destination set.
 *
 * ADR-075 specified "Publish button pushes each destination in sequence.
 * A single failing destination doesn't block the others; each row shows
 * its own result state." That sequencing never existed: each platform was
 * a separate operator click, and the bulk paths posted straight to
 * YouTube. This is it.
 *
 * Destinations are pushed in the order the series declared them, one at a
 * time rather than concurrently: they contend for the same source
 * download and the same Cloud Run instance, and a parallel fan-out of
 * multi-GB uploads is how you OOM the container (see the trim diagnostic
 * in the YouTube adapter).
 *
 * The executor does not touch the catalog store. It reports each outcome
 * through `onOutcome`, and the caller records it via the aggregate's
 * per-destination command (ADR-077 §1). That keeps status semantics in the
 * domain and keeps this function testable without a store.
 */

import type { DestinationSpec } from "../youtubeTitleAlign";
import type { VideoRecordJSON } from "../wasm";
import { isAutomatedDestination, destinationLabel } from "../destinationResolver";
import type { DestinationAdapter, PublishAttrs, PublishCredentials, PushResult } from "./types";
import { youtubeAdapter } from "./adapters/youtube";
import { kalturaAdapter } from "./adapters/kaltura";
import { driveAdapter } from "./adapters/drive";

const ADAPTERS: DestinationAdapter[] = [youtubeAdapter, kalturaAdapter, driveAdapter];

export function adapterFor(platform: DestinationSpec["platform"]): DestinationAdapter | null {
  return ADAPTERS.find(a => a.platform === platform) ?? null;
}

/** One destination's result. `skipped` covers a declared destination the
 *  tool cannot push — an `Other` manual target, or a platform with no
 *  adapter — which is neither a success nor a failure and must not be
 *  reported as either. */
export interface DestinationResult {
  spec: DestinationSpec;
  status: "pushed" | "failed" | "skipped";
  external_id?: string;
  external_url?: string;
  bytes?: number;
  error?: string;
  /** Why it was skipped, for the operator-facing summary. */
  skipReason?: string;
}

export interface ExecutePublishRequest {
  record: VideoRecordJSON;
  /** The resolved set, in declaration order (ADR-077 §2). */
  destinations: DestinationSpec[];
  /** Per-destination attributes. Called per spec so the caller can vary
   *  the description cap and the declared visibility by platform. */
  attrsFor: (spec: DestinationSpec) => PublishAttrs;
  /** Source URL to fetch the media from, per destination — the best
   *  upstream copy can differ by target (ADR-062 source picking). */
  sourceUrlFor: (spec: DestinationSpec) => string;
  creds: PublishCredentials;
  onPhase?: (phase: string) => void;
  /** Fires as each destination settles, so the caller can record the
   *  outcome and update the row before the next push starts. */
  onOutcome?: (result: DestinationResult) => void | Promise<void>;
}

export interface ExecutePublishReport {
  results: DestinationResult[];
  pushed: number;
  failed: number;
  skipped: number;
  /** True when at least one destination landed — the condition under
   *  which ADR-077 §Decisions-resolved #1 says the record is Published. */
  anyPushed: boolean;
  /** True when every non-skipped destination landed. */
  allPushed: boolean;
}

export async function executePublish(
  req: ExecutePublishRequest,
): Promise<ExecutePublishReport> {
  const results: DestinationResult[] = [];

  for (const spec of req.destinations) {
    let result: DestinationResult;

    if (!isAutomatedDestination(spec)) {
      result = {
        spec,
        status: "skipped",
        skipReason: `${destinationLabel(spec)} is a manual target — action it by hand`,
      };
    } else {
      const adapter = adapterFor(spec.platform);
      if (!adapter) {
        result = {
          spec,
          status: "skipped",
          skipReason: `no adapter for ${spec.platform}`,
        };
      } else {
        req.onPhase?.(`Publishing to ${destinationLabel(spec)}…`);
        try {
          const pushed: PushResult = await adapter.push({
            record: req.record,
            spec,
            attrs: req.attrsFor(spec),
            sourceUrl: req.sourceUrlFor(spec),
            creds: req.creds,
            onPhase: req.onPhase,
          });
          result = {
            spec,
            status: "pushed",
            external_id: pushed.external_id,
            external_url: pushed.external_url,
            bytes: pushed.bytes,
          };
        } catch (err) {
          // One destination failing must not abort its peers — that is
          // the whole point of walking the set.
          result = {
            spec,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }

    results.push(result);
    await req.onOutcome?.(result);
  }

  const pushed = results.filter(r => r.status === "pushed").length;
  const failed = results.filter(r => r.status === "failed").length;
  const skipped = results.filter(r => r.status === "skipped").length;
  return {
    results,
    pushed,
    failed,
    skipped,
    anyPushed: pushed > 0,
    allPushed: pushed > 0 && failed === 0,
  };
}
