"use client";

/**
 * ADR-064 — description generation configuration panel.
 *
 * Admin-only edit. Radio picks between:
 *   copy_show_notes (default) — description = deterministic copy of the
 *     Show Notes doc, markdown-flattened, YouTube-chapter-cue-friendly.
 *   generate — LLM summary from the transcript (pre-ADR-064 behaviour).
 * Textarea edits the fallback prompt used by the `generate` path.
 */

import { useEffect, useState } from "react";
import { useCurrentActor } from "../lib/useCurrentActor";
import {
  DEFAULT_DESCRIPTION_PROMPT,
  DEFAULT_SHOW_NOTES_PROMPT,
  getDescriptionConfig,
  refreshDescriptionConfig,
  saveDescriptionConfig,
  type DescriptionConfig,
  type DescriptionMode,
} from "../lib/descriptionConfig";

export default function DescriptionConfigPanel() {
  const actorState = useCurrentActor();
  const isAdmin = actorState.actor?.role === "Admin";
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<DescriptionConfig | null>(null);
  const [mode, setMode] = useState<DescriptionMode>("copy_show_notes");
  const [prompt, setPrompt] = useState("");
  const [showNotesPrompt, setShowNotesPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDescriptionConfig().then((c) => {
      if (cancelled) return;
      setCfg(c);
      setMode(c.mode);
      setPrompt(c.prompt_text);
      setShowNotesPrompt(c.show_notes_prompt);
    });
    return () => { cancelled = true; };
  }, []);

  async function save() {
    setSaving(true);
    setStatus(null);
    setError(null);
    const res = await saveDescriptionConfig({ mode, prompt_text: prompt, show_notes_prompt: showNotesPrompt });
    setSaving(false);
    if (res.ok) {
      setStatus("Saved.");
      refreshDescriptionConfig();
      const c = await getDescriptionConfig();
      setCfg(c);
    } else {
      setError(res.error);
    }
  }

  const dirty = cfg != null && (cfg.mode !== mode || cfg.prompt_text !== prompt || cfg.show_notes_prompt !== showNotesPrompt);

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div
        className="panel-header"
        onClick={() => setOpen((v) => !v)}
        style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <div>
          <strong>📝 Description strategy</strong>
          <span style={{ color: "var(--text-muted)", marginLeft: 8, fontSize: "0.85rem" }}>
            {cfg
              ? cfg.mode === "copy_show_notes"
                ? "Copy from Show Notes (fallback: LLM from transcript)"
                : "LLM summary from transcript"
              : "loading…"}
          </span>
        </div>
        <span>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="panel-body" style={{ padding: 12 }}>
          <div style={{ marginBottom: 12, fontSize: "0.82rem", color: "var(--text-muted)" }}>
            Controls the paragraph <code>description</code> that ships with YouTube uploads.
            The chapter-oriented Show Notes doc (ADR-046) is a separate artifact
            edited via the <strong>Show Notes prompt</strong> panel below.
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "flex-start" }}>
              <input
                type="radio"
                name="desc-mode"
                value="copy_show_notes"
                checked={mode === "copy_show_notes"}
                onChange={() => setMode("copy_show_notes")}
                disabled={!isAdmin}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>Copy from Show Notes (recommended)</strong>
                <div style={{ fontSize: "0.76rem", color: "var(--text-muted)" }}>
                  Deterministic markdown flatten of the Show Notes doc. Emits <code>HH:MM:SS Chapter</code>
                  {" "}lines that YouTube renders as clickable chapter jumps. Falls back to the
                  LLM path when a record has no Show Notes yet.
                </div>
              </span>
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <input
                type="radio"
                name="desc-mode"
                value="generate"
                checked={mode === "generate"}
                onChange={() => setMode("generate")}
                disabled={!isAdmin}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>Generate from transcript</strong>
                <div style={{ fontSize: "0.76rem", color: "var(--text-muted)" }}>
                  LLM summariser fed the transcript directly. Ignores Show Notes even when present.
                </div>
              </span>
            </label>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ fontWeight: 600, fontSize: "0.82rem" }}>
              Show-Notes-mode prompt
            </label>
            <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: 4 }}>
              System prompt sent to OpenRouter when producing a YouTube description
              from a record&apos;s Show Notes doc (mode &quot;Copy from Show Notes&quot;).
              The default writes a marketing hook, HH:MM:SS chapter cues (so YouTube&apos;s
              chapter picker renders), optional highlights, and hard-caps at 4800 chars.
            </div>
            <textarea
              value={showNotesPrompt}
              onChange={(e) => setShowNotesPrompt(e.target.value)}
              disabled={!isAdmin}
              rows={16}
              style={{
                width: "100%", fontFamily: "monospace", fontSize: "0.78rem",
                padding: 8, background: "var(--bg)", color: "var(--text)",
                border: "1px solid var(--border)", borderRadius: 4, resize: "vertical",
              }}
            />
            {showNotesPrompt !== DEFAULT_SHOW_NOTES_PROMPT && (
              <button
                className="btn btn-sm"
                style={{ marginTop: 4, fontSize: "0.72rem" }}
                onClick={() => setShowNotesPrompt(DEFAULT_SHOW_NOTES_PROMPT)}
                disabled={!isAdmin}
                title="Reset the Show-Notes-mode prompt to the embedded default (not saved until you click Save)"
              >
                ↺ Reset to default
              </button>
            )}
          </div>

          <div style={{ marginBottom: 8 }}>
            <label style={{ fontWeight: 600, fontSize: "0.82rem" }}>
              Transcript-mode prompt
            </label>
            <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: 4 }}>
              System prompt sent to OpenRouter when generating from a transcript.
              Used by mode &quot;Generate from transcript&quot; AND as the fallback
              when &quot;Copy from Show Notes&quot; is on but no Show Notes exist yet.
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={!isAdmin}
              rows={10}
              style={{
                width: "100%", fontFamily: "monospace", fontSize: "0.78rem",
                padding: 8, background: "var(--bg)", color: "var(--text)",
                border: "1px solid var(--border)", borderRadius: 4, resize: "vertical",
              }}
            />
            {prompt !== DEFAULT_DESCRIPTION_PROMPT && (
              <button
                className="btn btn-sm"
                style={{ marginTop: 4, fontSize: "0.72rem" }}
                onClick={() => setPrompt(DEFAULT_DESCRIPTION_PROMPT)}
                disabled={!isAdmin}
                title="Reset the prompt textarea to the embedded default (not saved until you click Save)"
              >
                ↺ Reset to default
              </button>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              className="btn btn-sm btn-primary"
              onClick={save}
              disabled={!isAdmin || saving || !dirty}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {!isAdmin && (
              <span style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>
                Admin required to edit.
              </span>
            )}
            {status && <span style={{ color: "var(--green)", fontSize: "0.78rem" }}>{status}</span>}
            {error && <span style={{ color: "var(--red)", fontSize: "0.78rem" }}>Error: {error}</span>}
            {cfg?.updated_at && (
              <span style={{ color: "var(--text-muted)", fontSize: "0.72rem", marginLeft: "auto" }}>
                Last saved {new Date(cfg.updated_at).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
