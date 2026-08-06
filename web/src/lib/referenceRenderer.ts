/**
 * ADR-074 §3 — reference.md generator.
 *
 * Composes an aggregated single-file view of a record from:
 *   - the WASM record's live state (title, dates, contributor, YouTube link)
 *   - the record's Drive artifact bag (transcript, summary, description,
 *     chat, youtube-snippet)
 *
 * Derived, not authored. Regenerate on any material change to the
 * inputs (see §Trigger points in the ADR). Store as `reference.md`
 * via setArtifact.
 */

import type { VideoRecordJSON } from "./wasm";
import { getMeta, getArtifact, setArtifact } from "./driveArtifactStore";

interface RenderOptions {
  /** Include a "Transcript" section (large; some consumers only want
   *  the aggregation without the transcript body). Default true. */
  includeTranscript?: boolean;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

function fmtDuration(secs: number): string {
  if (!secs) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`
    : `${m}m ${String(s).padStart(2, "0")}s`;
}

function locationLine(l: { platform: string; role: string; external_url?: string | null; external_id?: string }): string {
  const url = l.external_url ?? "";
  const id = l.external_id ?? "";
  const label = url ? `[${l.platform}](${url})` : `${l.platform}${id ? ` (${id})` : ""}`;
  return `- ${l.role}: ${label}`;
}

async function safeArtifact(record_id: string, kind: Parameters<typeof getArtifact>[1]): Promise<string | null> {
  try {
    const res = await getArtifact(record_id, kind);
    return res?.content ?? null;
  } catch { return null; }
}

/**
 * Render reference.md content for a record. Does NOT write — caller
 * decides (setArtifact for persistence; direct return for a preview).
 */
export async function renderReference(rec: VideoRecordJSON, opts: RenderOptions = {}): Promise<string> {
  const includeTranscript = opts.includeTranscript !== false;

  const [transcriptMd, summaryMd, descriptionMd, chatMd, youtubeSnippetRaw] = await Promise.all([
    includeTranscript ? safeArtifact(rec.id, "transcript") : Promise.resolve(null),
    safeArtifact(rec.id, "summary"),
    safeArtifact(rec.id, "description"),
    safeArtifact(rec.id, "chat"),
    safeArtifact(rec.id, "youtube-snippet"),
  ]);

  // Prefer the pushed snippet's description when present; falls back
  // to the local description artifact, then to the WASM record's
  // inline description field.
  let pushedDescription = "";
  if (youtubeSnippetRaw) {
    try {
      const parsed = JSON.parse(youtubeSnippetRaw) as { snippet?: { description?: string } };
      pushedDescription = parsed.snippet?.description ?? "";
    } catch { /* malformed snippet — fall through */ }
  }
  const description = pushedDescription
    || descriptionMd
    || rec.description
    || "";

  // Pick the destination YouTube URL for the header link (if any).
  const ytLocation = (rec.locations ?? []).find(l => l.platform === "YouTube" && l.role === "Destination")
                  ?? (rec.locations ?? []).find(l => l.platform === "YouTube");
  const youtubeUrl = ytLocation?.external_url ?? null;

  // Contributor / attribution
  const contributor = (rec as VideoRecordJSON & { contributor_email?: string; contributor_chapter?: string }).contributor_email ?? null;
  const contributorChapter = (rec as VideoRecordJSON & { contributor_chapter?: string }).contributor_chapter ?? null;

  const lines: string[] = [];
  lines.push(`# ${rec.title}`);
  lines.push("");
  lines.push(`- **Recorded:** ${fmtDate(rec.recorded_at)}`);
  lines.push(`- **Duration:** ${fmtDuration(rec.duration_seconds)}`);
  lines.push(`- **Source:** ${rec.source_platform} (\`${rec.source_id}\`)`);
  if (contributor) {
    lines.push(`- **Contributor:** ${contributor}${contributorChapter ? ` · Agentics ${contributorChapter}` : ""}`);
  }
  if (rec.download_url) {
    lines.push(`- **Original source:** ${rec.download_url}`);
  }
  if (youtubeUrl) {
    lines.push(`- **Published on YouTube:** ${youtubeUrl}`);
  }
  lines.push(`- **Status:** ${rec.status}`);
  lines.push("");

  lines.push("## Show Notes");
  lines.push("");
  lines.push(summaryMd?.trim() || "_Not yet generated (see ADR-046)._");
  lines.push("");

  lines.push("## Description");
  lines.push("");
  if (pushedDescription) {
    lines.push("_As last pushed to YouTube._");
    lines.push("");
  } else if (description) {
    lines.push("_Local copy (not yet published)._");
    lines.push("");
  }
  lines.push(description.trim() || "_None._");
  lines.push("");

  if (includeTranscript) {
    lines.push("## Transcript");
    lines.push("");
    lines.push(transcriptMd?.trim() || "_Not yet available (see ADR-072 fallback ladder)._");
    lines.push("");
  }

  lines.push("## Chat");
  lines.push("");
  lines.push(chatMd?.trim() || "_Not available for this source._");
  lines.push("");

  const provenanceLines: string[] = [];
  for (const l of (rec.locations ?? [])) provenanceLines.push(locationLine(l));
  const upstream = (rec.upstream_links ?? []).map(u => `- Upstream: ${u.platform} \`${u.external_id}\` (${u.relation})`);
  provenanceLines.push(...upstream);

  lines.push("## Provenance");
  lines.push("");
  lines.push(provenanceLines.length > 0 ? provenanceLines.join("\n") : "_No locations recorded._");
  lines.push("");

  lines.push("---");
  lines.push(`_Generated ${new Date().toISOString()} · record \`${rec.id}\`_`);

  return lines.join("\n");
}

/**
 * Render + persist reference.md via setArtifact. Uses the record's
 * existing meeting folder (which must exist — a reference-only pass
 * can't materialise a folder from scratch since we're not
 * authoritative on RecordContext).
 */
export async function generateAndStoreReference(rec: VideoRecordJSON): Promise<{ ok: true } | { ok: false; reason: string }> {
  const meta = await getMeta(rec.id);
  if (!meta) {
    return { ok: false, reason: "no artifact folder yet — record has no transcripts / show notes / chat to aggregate" };
  }
  const md = await renderReference(rec, { includeTranscript: true });
  await setArtifact(
    {
      record_id: rec.id,
      title: rec.title,
      source_platform: rec.source_platform,
      source_id: rec.source_id,
      recorded_at: rec.recorded_at ?? rec.indexed_at ?? new Date().toISOString(),
    },
    "reference",
    md,
  );
  return { ok: true };
}
