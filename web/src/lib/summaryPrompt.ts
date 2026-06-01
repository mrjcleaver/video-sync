/**
 * ADR-046 — server-side resolver for the org-shared summary prompt.
 *
 * Stored as `data/summary-prompt.json` on the FUSE-mounted GCS bucket
 * (server-authoritative per ADR-035 L2). Same shape as rules.json:
 * server reads/writes the file directly; no Secret Manager since the
 * prompt is not a secret.
 *
 * Versions are monotonic. Each PUT bumps the counter and appends the
 * previous version to `history` so we can answer "which prompt wrote
 * this Drive Doc?" months later.
 */

import { promises as fs } from "fs";
import { join } from "path";

const PROMPT_FILE = join(process.cwd(), "data", "summary-prompt.json");

export interface SummaryPromptVersion {
  version: number;
  text: string;
  model: string;
  updated_at: string;
  updated_by: string;
}

export interface SummaryPromptStore {
  current: SummaryPromptVersion;
  history: SummaryPromptVersion[];
}

// Default model — long context, deterministic enough for structured
// markdown output. Operators can override per-org via PUT.
const DEFAULT_MODEL = "google/gemini-2.5-pro";

// Default prompt — ships embedded so the route works out of the box
// before any admin tunes the team's prompt. Designed to produce
// markdown that the count-bullets-under-heading parser can read
// reliably regardless of how the model nests chapters.
const DEFAULT_PROMPT_TEXT = `You are a video session summariser for a 2-3 hour technical livestream that may include embedded chat.

Produce a chapter-oriented breakdown of the transcript as Markdown.

For each chapter, emit a chapter heading and FOUR sections, in this exact order, using these exact level-3 headings:

### Key Moments
### Key Learnings
### Key Takeaways
### Chat-Sparked Discussions

Each section is a bulleted list. Each bullet:
- Starts with a timestamp in square brackets, e.g. [00:14:32]
- Then a one-paragraph description referencing the speaker(s) where known.

Section definitions:
- **Key Moments** — narrative beats in the video itself (concept introductions, decisions, demos, transitions).
- **Key Learnings** — generalisable insights a viewer would write down.
- **Key Takeaways** — action items, what to do next.
- **Chat-Sparked Discussions** — moments where the embedded chat shows concentrated engagement. For each, record both **what was said in the video** that triggered it and a representative **chat quote** with the chat author's name where available.

If a section has no entries for a chapter, omit the heading for that chapter (do not emit an empty section).

Chapter heading format: \`## {N}. {Short chapter title} [{HH:MM}-{HH:MM}]\`

Output ONLY the Markdown summary. No preamble. No JSON wrapper. No closing remarks.`;

const DEFAULT_PROMPT: SummaryPromptStore = {
  current: {
    version: 1,
    text: DEFAULT_PROMPT_TEXT,
    model: DEFAULT_MODEL,
    updated_at: "2026-05-27T00:00:00Z",
    updated_by: "system",
  },
  history: [],
};

/** Read the current prompt store. Returns the embedded default if no file exists. */
export async function getSummaryPromptStore(): Promise<SummaryPromptStore> {
  try {
    const raw = await fs.readFile(PROMPT_FILE, "utf-8");
    const parsed = JSON.parse(raw) as SummaryPromptStore;
    // Defensive: ensure current exists with required fields.
    if (!parsed.current?.text || typeof parsed.current.version !== "number") {
      return DEFAULT_PROMPT;
    }
    return {
      current: parsed.current,
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return DEFAULT_PROMPT;
  }
}

/** Convenience: just the current version. */
export async function getCurrentPrompt(): Promise<SummaryPromptVersion> {
  return (await getSummaryPromptStore()).current;
}

/**
 * Write a new prompt version. Bumps `version`, moves the previous
 * current into `history`. Caller is responsible for role-gating.
 */
export async function setCurrentPrompt(
  text: string,
  model: string,
  updatedBy: string,
): Promise<SummaryPromptStore> {
  const store = await getSummaryPromptStore();
  const nextVersion = store.current.version + 1;
  const newCurrent: SummaryPromptVersion = {
    version: nextVersion,
    text,
    model,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  };
  const updated: SummaryPromptStore = {
    current: newCurrent,
    history: [store.current, ...store.history].slice(0, 50),  // cap retained history
  };
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  await fs.writeFile(PROMPT_FILE, JSON.stringify(updated, null, 2), "utf-8");
  return updated;
}
