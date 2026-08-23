/**
 * Server-side reader for the ADR-064 description config.
 *
 * Split out of app/api/description/config/route.ts: a route module may only
 * export handlers, so exporting this from there broke the generated
 * route-type check and blocked deploy.sh's pre-flight. Kept separate from
 * lib/descriptionConfig.ts because that module is imported by client code
 * and this one needs node:fs.
 *
 * Server-only — never import from a client component.
 */

import { promises as fs } from "fs";
import { join } from "path";
import {
  DEFAULT_DESCRIPTION_PROMPT,
  DEFAULT_SHOW_NOTES_PROMPT,
  type DescriptionConfig,
} from "./descriptionConfig";

const CONFIG_FILE = join(process.cwd(), "data", "description-config.json");

const DEFAULT_CONFIG: DescriptionConfig = {
  mode: "copy_show_notes",
  prompt_text: DEFAULT_DESCRIPTION_PROMPT,
  show_notes_prompt: DEFAULT_SHOW_NOTES_PROMPT,
};

export async function readDescriptionConfig(): Promise<DescriptionConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DescriptionConfig>;
    return {
      mode: parsed.mode === "generate" ? "generate" : "copy_show_notes",
      prompt_text: typeof parsed.prompt_text === "string" && parsed.prompt_text.length > 0
        ? parsed.prompt_text
        : DEFAULT_DESCRIPTION_PROMPT,
      show_notes_prompt: typeof parsed.show_notes_prompt === "string" && parsed.show_notes_prompt.length > 0
        ? parsed.show_notes_prompt
        : DEFAULT_SHOW_NOTES_PROMPT,
      updated_at: parsed.updated_at,
      updated_by: parsed.updated_by,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
