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
  /** Transcript-mode system prompt (used when mode="generate" OR when
   *  mode="copy_show_notes" falls back because a record has no doc). */
  prompt_text: string;
  /** Show-Notes-mode prompt (used when mode="copy_show_notes" AND a
   *  Show Notes doc exists). Rewrites the doc into a YouTube-facing
   *  description that markets the video AND keeps chapter cues intact. */
  show_notes_prompt: string;
  updated_at?: string;
  updated_by?: string;
}

export const DEFAULT_DESCRIPTION_PROMPT = `You are a video session summariser. Given a meeting or coding session transcript, return a JSON object with exactly these fields:
- summary: string — 2-4 sentences describing what the session covered
- topics: string[] — 3-7 key topics discussed (short phrases)
- highlights: string[] — 2-5 notable moments, decisions, or insights

Return only valid JSON. No markdown, no explanation.`;

export const DEFAULT_SHOW_NOTES_PROMPT = `You are turning a chapter-by-chapter Show Notes markdown document into a YouTube video description that both:
1) preserves high-level chapter cues so YouTube's player renders clickable chapter jumps, AND
2) sells the video to a first-time viewer scrolling their feed.

OUTPUT FORMAT, in this exact order:

1. OPENING HOOK — 1–2 sentences (~200–300 characters). Answer "why should I watch this?" with the concrete question the video answers, the interesting demo, the surprising outcome, or the notable guest. No corporate throat-clearing. No "In this video we…" openers.

2. CHAPTER LIST — one line per chapter, in the EXACT form:
     HH:MM:SS Chapter title
   Rules:
   - Always 2-digit hour (00 for sub-hour videos).
   - No brackets, no bullets, no leading whitespace.
   - The very first line MUST be "00:00:00 <opener>" — YouTube's chapter picker requires this.
   - Aim for 5–12 chapters. Use the audience-facing chapter TITLES from the Show Notes (not "Chapter N"). Omit trivial chapters (setup / housekeeping / breaks).
   - Timestamps must be strictly ascending.

3. HIGHLIGHTS (optional, only if under the character cap). A blank line, then 3–5 short bullets on distinct moments a viewer will want to reach — interesting quotes, hot takes, demo results, learnings that landed. Each bullet starts with "• " (bullet dot + space), one line each, no timestamps (chapters already carry them).

4. CLOSING (optional). Any call-to-action lines the Show Notes already carry (subscribe, community Discord, follow-up docs, sponsor mentions). Otherwise omit.

CONSTRAINTS:
- Total output must be ≤ 4800 characters (YouTube's cap is 5000; leave headroom for tags/URLs).
- No markdown formatting: no **bold**, no ## headings, no [text](url) syntax. YouTube renders those as literal characters. Emojis are OK, sparingly.
- URLs autolinkify on YouTube — leave them bare.
- Do not invent facts. Every claim must be verifiable from the Show Notes text.
- Match the Show Notes' voice: first-plural ("we") if that's what the doc uses, otherwise third-person.

Return ONLY the description text. No preamble, no explanation, no JSON wrapper, no code fences.`;

export const DEFAULT_DESCRIPTION_CONFIG: DescriptionConfig = {
  mode: "copy_show_notes",
  prompt_text: DEFAULT_DESCRIPTION_PROMPT,
  show_notes_prompt: DEFAULT_SHOW_NOTES_PROMPT,
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
      show_notes_prompt: typeof data.show_notes_prompt === "string" && data.show_notes_prompt.length > 0
        ? data.show_notes_prompt
        : DEFAULT_SHOW_NOTES_PROMPT,
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
