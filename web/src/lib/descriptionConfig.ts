/**
 * ADR-064 — description generation configuration.
 *
 * Stored server-side in data/description-config.json. Two knobs:
 *
 *   - mode: "copy_show_notes" | "generate"
 *     copy_show_notes → the paragraph description is derived from
 *     the current Show Notes (ADR-046) via showNotesToDescription().
 *     Falls back to `generate` when the record has no summary_doc_id.
 *     generate → the description is a fresh LLM summary of the
 *     transcript (the pre-ADR-064 default).
 *
 *   - prompt_text: system prompt for the `generate` path. Was
 *     hardcoded in /api/process/summarize; moved here so operators
 *     can tune it without redeploying.
 *
 * Client callers use getDescriptionConfigCached() after AppContext
 * warms the cache on boot.
 */

export type DescriptionMode = "copy_show_notes" | "generate";

export interface DescriptionConfig {
  mode: DescriptionMode;
  prompt_text: string;
  updated_at?: string;
  updated_by?: string;
}

export const DEFAULT_DESCRIPTION_PROMPT = `You are a video session summariser. Given a meeting or coding session transcript, return a JSON object with exactly these fields:
- summary: string — 2-4 sentences describing what the session covered
- topics: string[] — 3-7 key topics discussed (short phrases)
- highlights: string[] — 2-5 notable moments, decisions, or insights

Return only valid JSON. No markdown, no explanation.`;

export const DEFAULT_DESCRIPTION_CONFIG: DescriptionConfig = {
  mode: "copy_show_notes",
  prompt_text: DEFAULT_DESCRIPTION_PROMPT,
};

let cache: DescriptionConfig | null = null;
let inflight: Promise<DescriptionConfig> | null = null;

async function fetchOnce(): Promise<DescriptionConfig> {
  try {
    const res = await fetch("/api/description/config", { cache: "no-store" });
    if (!res.ok) return DEFAULT_DESCRIPTION_CONFIG;
    const data = (await res.json()) as Partial<DescriptionConfig>;
    return {
      mode: data.mode === "generate" ? "generate" : "copy_show_notes",
      prompt_text: typeof data.prompt_text === "string" && data.prompt_text.length > 0
        ? data.prompt_text
        : DEFAULT_DESCRIPTION_PROMPT,
      updated_at: data.updated_at,
      updated_by: data.updated_by,
    };
  } catch {
    return DEFAULT_DESCRIPTION_CONFIG;
  }
}

export async function getDescriptionConfig(): Promise<DescriptionConfig> {
  if (cache) return cache;
  if (!inflight) inflight = fetchOnce().then((v) => { cache = v; inflight = null; return v; });
  return inflight;
}

/** Synchronous cached accessor — returns the default until AppContext's warm-up resolves. */
export function getDescriptionConfigCached(): DescriptionConfig {
  return cache ?? DEFAULT_DESCRIPTION_CONFIG;
}

export function refreshDescriptionConfig(): void {
  cache = null;
  inflight = null;
}

export async function saveDescriptionConfig(cfg: DescriptionConfig): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/description/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: (data as { error?: string }).error ?? `HTTP ${res.status}` };
    }
    cache = cfg;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
