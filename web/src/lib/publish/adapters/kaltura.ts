/**
 * ADR-077 §3 — Kaltura destination adapter.
 *
 * Wraps /api/kaltura/upload (ADR-037 Phase 1): a single-shot blocking
 * upload with no progress stream, so the phase reporter fires once at the
 * start and the operator sees an indeterminate spinner.
 *
 * Does NOT apply the declared visibility. Kaltura's model is an
 * access-control profile id, the upload body has no field for one, and
 * the id values are partner-specific so there is no universal mapping
 * from `public` / `members` / `unlisted`. ADR-077 §5 closes this, and it
 * needs the org's KMC administrator to supply the mapping first — the one
 * dependency in that ADR outside engineering. Until then
 * appliesDeclaredVisibility("Kaltura") is false and the UI says so.
 */

import type { DestinationAdapter, PushRequest, PushResult } from "../types";

export const kalturaAdapter: DestinationAdapter = {
  platform: "Kaltura",

  async push(req: PushRequest): Promise<PushResult> {
    if (req.spec.platform !== "Kaltura") {
      throw new Error(`kalturaAdapter received a ${req.spec.platform} destination`);
    }

    req.onPhase?.("Uploading to Kaltura…");

    const body: Record<string, unknown> = {
      title: req.attrs.title,
      description: req.attrs.description,
      tags: req.attrs.tags,
      downloadUrl: req.sourceUrl,
      // ADR-044 — stamp the catalog uuid as the entry's referenceId so a
      // later presence sweep can find it without depending on the
      // description footer surviving an operator edit.
      referenceId: req.record.id,
      ...(req.spec.category_ids?.length
        ? { categoryIds: req.spec.category_ids.map(id => Number(id)).filter(n => !Number.isNaN(n)) }
        : {}),
      ...req.creds.source,
    };
    if (req.creds.kaltura?.partnerId && req.creds.kaltura?.adminSecret) {
      body.partnerId = req.creds.kaltura.partnerId;
      body.adminSecret = req.creds.kaltura.adminSecret;
    }

    const res = await fetch("/api/kaltura/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({})) as {
      entryId?: string;
      playerUrl?: string;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(data.error ?? `Kaltura upload failed (${res.status})`);
    }
    if (!data.entryId) {
      throw new Error("Kaltura upload returned no entryId");
    }
    return {
      external_id: data.entryId,
      external_url: data.playerUrl ?? "",
    };
  },
};
