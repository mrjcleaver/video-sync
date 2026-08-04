"use client";

import { useState, useCallback, useEffect, useId, useRef } from "react";
import {
  loadProcessingRules,
  saveProcessingRules,
  applyProcessingRules,
  renderTemplate,
  requestLlmSummary,
  type ProcessingRule,
  type AttributeTransform,
  type AttributeTransformMode,
  type TagTransform,
  type TrimSnapMode,
} from "../lib/processingRules";
import { videoStore } from "../lib/store";
import type { RuleCriteria } from "../lib/rules";
import HelpTip from "./HelpTip";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function emptyRule(): ProcessingRule {
  return {
    id: `proc-${Date.now()}`,
    name: "",
    enabled: true,
    priority: 10,
    criteria: {},
    transforms: { title: { mode: "template", value: "{{title}} - {{date:D MMM YYYY}}" } },
  };
}

function emptyTransform(mode: AttributeTransformMode = "template"): AttributeTransform {
  return { mode, value: "" };
}

interface Props {
  expanded?: boolean;
}

export default function ProcessingRulesPanel({ expanded: initExpanded = false }: Props) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(initExpanded);
  const [rules, setRules] = useState<ProcessingRule[]>(() => loadProcessingRules());
  const [editing, setEditing] = useState<ProcessingRule | null>(null);
  const [previewVideoId, setPreviewVideoId] = useState<string>("");
  const [previewResult, setPreviewResult] = useState<ReturnType<typeof applyProcessingRules> | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [deletePendingId, setDeletePendingId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const addRuleButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusAfterDelete, setFocusAfterDelete] = useState<{ target: "delete" | "add"; id: string } | null>(null);

  useEffect(() => {
    if (deletePendingId !== null || !focusAfterDelete) return;
    if (focusAfterDelete.target === "delete") {
      deleteButtonRefs.current.get(focusAfterDelete.id)?.focus();
    } else {
      addRuleButtonRef.current?.focus();
    }
    setFocusAfterDelete(null);
  }, [deletePendingId, focusAfterDelete]);

  const persist = useCallback((updated: ProcessingRule[]) => {
    setRules(updated);
    saveProcessingRules(updated);
  }, []);

  function toggleEnabled(id: string) {
    const rule = rules.find((r) => r.id === id);
    persist(rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
    if (rule) setStatusMessage(`${rule.name} ${rule.enabled ? "disabled" : "enabled"}.`);
  }

  function deleteRule(id: string) {
    const rule = rules.find((r) => r.id === id);
    persist(rules.filter((r) => r.id !== id));
    setFocusAfterDelete({ target: "add", id });
    setDeletePendingId(null);
    if (rule) setStatusMessage(`${rule.name} deleted.`);
  }

  function startEdit(rule?: ProcessingRule) {
    setEditing(rule ? JSON.parse(JSON.stringify(rule)) : emptyRule());
    setPreviewResult(null);
    setDeletePendingId(null);
    setEditError(null);
  }

  function saveEdit() {
    if (!editing) return;
    if (!editing.name.trim()) {
      setEditError("Enter a rule name.");
      return;
    }
    const idx = rules.findIndex((r) => r.id === editing.id);
    persist(idx >= 0 ? rules.map((r) => (r.id === editing.id ? editing : r)) : [...rules, editing]);
    setStatusMessage(`${editing.name} saved.`);
    setEditing(null);
    setEditError(null);
  }

  function updateCriteria(patch: Partial<RuleCriteria>) {
    if (!editing) return;
    setEditing({ ...editing, criteria: { ...editing.criteria, ...patch } });
  }

  function toggleDay(day: number) {
    if (!editing) return;
    const current = editing.criteria.days_of_week ?? [];
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
    updateCriteria({ days_of_week: next.length > 0 ? next : undefined });
  }

  function setTitleTransform(patch: Partial<AttributeTransform> | null) {
    if (!editing) return;
    setEditing({
      ...editing,
      transforms: {
        ...editing.transforms,
        title: patch ? { ...(editing.transforms.title ?? emptyTransform()), ...patch } : undefined,
      },
    });
  }

  function setDescTransform(patch: Partial<AttributeTransform> | null) {
    if (!editing) return;
    setEditing({
      ...editing,
      transforms: {
        ...editing.transforms,
        description: patch ? { ...(editing.transforms.description ?? emptyTransform()), ...patch } : undefined,
      },
    });
  }

  function setTagTransform(patch: Partial<TagTransform> | null) {
    if (!editing) return;
    setEditing({
      ...editing,
      transforms: {
        ...editing.transforms,
        tags: patch ? { ...(editing.transforms.tags ?? { mode: "append", tags: [] }), ...patch } : undefined,
      },
    });
  }

  async function runPreview() {
    const videos = videoStore.getAll();
    const video = previewVideoId
      ? videos.find((v) => v.id === previewVideoId)
      : videos[0];
    if (!video) {
      setPreviewResult(null);
      return;
    }

    const needsLlm = rules.some(
      (r) => r.enabled && r.transforms.description?.mode === "transcript_llm"
    );

    setPreviewLoading(needsLlm && !!video.transcript_text);
    setPreviewError(null);

    let enriched = video;
    if (needsLlm && video.transcript_text) {
      try {
        const summary = await requestLlmSummary(video.transcript_text);
        enriched = { ...video, description: summary.summary };
      } catch (err) {
        setPreviewError(`LLM summary failed: ${String(err)}`);
      }
    }

    setPreviewResult(applyProcessingRules(rules, enriched));
    setPreviewLoading(false);
  }

  function previewTemplate(template: string) {
    const videos = videoStore.getAll();
    const video = previewVideoId
      ? videos.find((v) => v.id === previewVideoId)
      : videos[0];
    if (!video || !template.trim()) return "Not available";
    try {
      return renderTemplate(template, video);
    } catch {
      return "(template error)";
    }
  }

  const videos = videoStore.getAll();

  return (
    <div className="rules-panel">
      <h2>
        <button
          type="button"
          className="rules-panel-toggle"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls={expanded ? `${panelId}-content` : undefined}
        >
          <span>Processing rules {rules.length > 0 && `(${rules.length})`}</span>
          <span aria-hidden="true" style={{ fontSize: "0.8rem" }}>{expanded ? "▲" : "▼"}</span>
        </button>
      </h2>

      {expanded && (
        <div id={`${panelId}-content`}>
          <HelpTip>
            Processing rules transform video metadata at publish time, before a video is
            uploaded to YouTube. Each rule matches recordings by title pattern or day of week,
            then applies transforms to <strong>title</strong> (template or literal),{" "}
            <strong>description</strong> (template, literal, first N chars of transcript, or
            LLM summary via OpenRouter), <strong>tags</strong> (append or replace), and{" "}
            <strong>privacy</strong>. Use the Preview dropdown to see the output for a
            specific video before saving. Rules run in priority order (lower = first).
          </HelpTip>

          <div className="rule-toolbar">
            <button ref={addRuleButtonRef} type="button" className="btn btn-sm btn-primary" onClick={() => startEdit()}>
              Add rule
            </button>
            <label className="compact-field rule-preview-field" htmlFor={`${panelId}-preview-video`}>
              <span>Preview video</span>
              <select
                id={`${panelId}-preview-video`}
                value={previewVideoId}
                onChange={(e) => setPreviewVideoId(e.target.value)}
                style={{ fontSize: "0.75rem", padding: "4px 8px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)" }}
              >
                <option value="">{videos.length > 0 ? "First video" : "No videos"}</option>
                {videos.map((v) => (
                  <option key={v.id} value={v.id}>{v.title.slice(0, 50)}</option>
                ))}
              </select>
            </label>
            {rules.length > 0 && (
              <button type="button" className="btn btn-sm" onClick={runPreview} disabled={previewLoading} aria-busy={previewLoading}>
                {previewLoading ? "Generating…" : "Preview"}
              </button>
            )}
          </div>

          {statusMessage && (
            <div className="form-message" role="status" aria-live="polite">{statusMessage}</div>
          )}

          {previewError && (
            <div className="form-message form-message-error" role="alert" style={{ fontSize: "0.8rem", color: "var(--red)", marginBottom: 8 }}>{previewError}</div>
          )}

          {previewResult && (
            <div className="rule-form" role="status" aria-live="polite" style={{ marginBottom: 12 }}>
              <div style={{ fontSize: "0.7rem", color: "var(--accent)", marginBottom: 6, fontWeight: 600 }}>
                Preview output
              </div>
              <div style={{ fontSize: "0.8rem", marginBottom: 4 }}>
                <strong>Title:</strong> {previewResult.title}
              </div>
              <div style={{ fontSize: "0.8rem", marginBottom: 4 }}>
                <strong>Description:</strong>{" "}
                {previewResult.description ? (
                  <span style={{ color: "var(--text-muted)" }}>{previewResult.description.slice(0, 200)}{previewResult.description.length > 200 ? "…" : ""}</span>
                ) : (() => {
                  const hasDescTransform = rules.some(r => r.enabled && r.transforms.description);
                  if (!hasDescTransform) {
                    return <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>No description transform configured. Add one in the rule editor.</span>;
                  }
                  return <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>(empty: video has no description and no transcript loaded)</span>;
                })()}
              </div>
              <div style={{ fontSize: "0.8rem", marginBottom: 4 }}>
                <strong>Tags:</strong> {previewResult.tags.join(", ") || "None"}
              </div>
              <div style={{ fontSize: "0.8rem", marginBottom: 4 }}>
                <strong>Privacy:</strong> {previewResult.privacy_status}
              </div>
              {previewResult.trim_start_seconds > 0 && (
                <div style={{ fontSize: "0.8rem" }}>
                  <strong>Trim start:</strong> {previewResult.trim_start_seconds}s (skip first {Math.floor(previewResult.trim_start_seconds / 60)}m {previewResult.trim_start_seconds % 60}s)
                </div>
              )}
            </div>
          )}

          {rules.length === 0 && (
            <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", padding: "12px 0" }}>
              No processing rules. Add a rule to transform titles, descriptions, and tags at publish time.
            </div>
          )}

          {rules.map((rule) => (
            <div key={rule.id} className="rule-item">
              <div className="rule-item-row">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={() => toggleEnabled(rule.id)}
                  aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
                  style={{ accentColor: "var(--accent)" }}
                />
                <span className="rule-item-name">{rule.name}</span>
                <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>P{rule.priority}</span>
                {rule.transforms.title && (
                  <span className="status-badge" style={{ fontSize: "0.65rem", background: "var(--surface)" }}>T</span>
                )}
                {rule.transforms.description && (
                  <span className="status-badge" style={{ fontSize: "0.65rem", background: "var(--surface)" }}>D</span>
                )}
                {rule.transforms.tags && (
                  <span className="status-badge" style={{ fontSize: "0.65rem", background: "var(--surface)" }}>tags</span>
                )}
                {rule.transforms.trim && (
                  <span className="status-badge" style={{ fontSize: "0.65rem", background: "var(--surface)" }}>trim</span>
                )}
                <button type="button" className="btn btn-sm" onClick={() => startEdit(rule)}>Edit</button>
                {deletePendingId === rule.id ? (
                  <span className="inline-confirm" role="group" aria-label={`Confirm deletion of ${rule.name}`}>
                    <span>Delete this rule?</span>
                    <button type="button" className="btn btn-sm btn-red" onClick={() => deleteRule(rule.id)}>Yes, delete</button>
                    <button type="button" className="btn btn-sm" onClick={() => {
                      setFocusAfterDelete({ target: "delete", id: rule.id });
                      setDeletePendingId(null);
                    }} autoFocus>Cancel</button>
                  </span>
                ) : (
                  <button
                    ref={(element) => {
                      if (element) deleteButtonRefs.current.set(rule.id, element);
                      else deleteButtonRefs.current.delete(rule.id);
                    }}
                    type="button"
                    className="btn btn-sm btn-red"
                    onClick={() => setDeletePendingId(rule.id)}
                  >Delete</button>
                )}
              </div>
              {rule.transforms.title?.value && (
                <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 4 }}>
                  title: {rule.transforms.title.value}
                </div>
              )}
            </div>
          ))}

          {editing && (
            <form className="rule-form rule-editor" onSubmit={(event) => { event.preventDefault(); saveEdit(); }} noValidate>
              <h3 className="rule-editor-title">
                {rules.find((r) => r.id === editing.id) ? "Edit" : "New"} processing rule
              </h3>

              {/* Name + Priority */}
              <div className="rule-editor-grid rule-editor-grid-name">
                <div className="form-field">
                  <label htmlFor={`${panelId}-name`}>Name</label>
                  <input
                    id={`${panelId}-name`}
                    value={editing.name}
                    onChange={(e) => { setEditing({ ...editing, name: e.target.value }); setEditError(null); }}
                    placeholder="e.g. Live Vibe Coding title"
                    aria-invalid={!!editError}
                    aria-describedby={editError ? `${panelId}-error` : undefined}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor={`${panelId}-priority`}>Priority</label>
                  <input
                    id={`${panelId}-priority`}
                    type="number"
                    value={editing.priority}
                    onChange={(e) => setEditing({ ...editing, priority: parseInt(e.target.value) || 0 })}
                    style={{ width: 64 }}
                  />
                </div>
              </div>

              {/* Criteria */}
              <h4 className="rule-section-title">Match criteria</h4>
              <p className="field-help">Leave every option empty to match all videos.</p>
              <div className="form-field">
                <label htmlFor={`${panelId}-title-pattern`}>Title pattern (regex)</label>
                <input
                  id={`${panelId}-title-pattern`}
                  value={editing.criteria.title_pattern ?? ""}
                  onChange={(e) => updateCriteria({ title_pattern: e.target.value || undefined })}
                  placeholder="e.g. Live Vibe Coding"
                />
              </div>
              <div className="form-field">
                <span id={`${panelId}-platforms-label`} className="field-group-label">Source platforms</span>
                <div className="rule-toggle-group" role="group" aria-labelledby={`${panelId}-platforms-label`}>
                  {["Zoom", "Fireflies", "Loom", "YouTube"].map((p) => (
                    <button
                      type="button"
                      key={p}
                      className={`btn btn-sm ${(editing.criteria.source_platforms ?? []).includes(p) ? "btn-primary" : ""}`}
                      aria-pressed={(editing.criteria.source_platforms ?? []).includes(p)}
                      onClick={() => {
                        const cur = editing.criteria.source_platforms ?? [];
                        const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p];
                        updateCriteria({ source_platforms: next.length > 0 ? next : undefined });
                      }}
                    >
                      {p}
                    </button>
                  ))}
                </div>
                <div className="field-help">
                  Leave unselected to match any platform. For trim rules, select Zoom and/or Fireflies only.
                </div>
              </div>
              <div className="form-field">
                <span id={`${panelId}-days-label`} className="field-group-label">Days of week</span>
                <div className="rule-toggle-group" role="group" aria-labelledby={`${panelId}-days-label`}>
                  {DAYS.map((label, i) => (
                    <button
                      type="button"
                      key={i}
                      className={`btn btn-sm ${(editing.criteria.days_of_week ?? []).includes(i) ? "btn-primary" : ""}`}
                      aria-pressed={(editing.criteria.days_of_week ?? []).includes(i)}
                      onClick={() => toggleDay(i)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Title transform */}
              <h4 className="rule-section-title">Title transform</h4>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "0.75rem" }}>
                  <input
                    type="checkbox"
                    checked={!!editing.transforms.title}
                    onChange={(e) => setTitleTransform(e.target.checked ? emptyTransform("template") : null)}
                  />
                  Override title
                </label>
              </div>
              {editing.transforms.title && (
                <>
                  <div className="rule-editor-grid rule-editor-grid-value">
                    <div className="form-field">
                      <label htmlFor={`${panelId}-title-mode`}>Mode</label>
                      <select
                        id={`${panelId}-title-mode`}
                        value={editing.transforms.title.mode}
                        onChange={(e) => setTitleTransform({ mode: e.target.value as AttributeTransformMode })}
                        style={{ padding: "5px 8px", fontSize: "0.75rem", border: "1px solid var(--border)", borderRadius: 4, background: "var(--surface)", color: "var(--text)" }}
                      >
                        <option value="template">Template</option>
                        <option value="literal">Literal</option>
                      </select>
                    </div>
                    <div className="form-field">
                      <label htmlFor={`${panelId}-title-value`}>
                        {editing.transforms.title.mode === "template" ? "Template" : "Value"}
                      </label>
                      <input
                        id={`${panelId}-title-value`}
                        value={editing.transforms.title.value ?? ""}
                        onChange={(e) => setTitleTransform({ value: e.target.value })}
                        placeholder="{{title}} - {{date:D MMM YYYY}}"
                      />
                    </div>
                  </div>
                  {editing.transforms.title.mode === "template" && editing.transforms.title.value && (
                    <div style={{ fontSize: "0.7rem", color: "var(--accent)", marginBottom: 6 }}>
                      Preview: {previewTemplate(editing.transforms.title.value)}
                    </div>
                  )}
                  <div className="field-help">
                    Variables: {"{{title}}"} {"{{date:D MMM YYYY}}"} {"{{day}}"} {"{{duration}}"} {"{{source_platform}}"} {"{{description}}"} {"{{tags}}"}
                  </div>
                </>
              )}

              {/* Description transform */}
              <h4 className="rule-section-title">Description transform</h4>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "0.75rem" }}>
                  <input
                    type="checkbox"
                    checked={!!editing.transforms.description}
                    onChange={(e) => setDescTransform(e.target.checked ? emptyTransform("template") : null)}
                  />
                  Override description
                </label>
              </div>
              {editing.transforms.description && (
                <>
                  <div className="rule-editor-grid rule-editor-grid-value">
                    <div className="form-field">
                      <label htmlFor={`${panelId}-description-mode`}>Mode</label>
                      <select
                        id={`${panelId}-description-mode`}
                        value={editing.transforms.description.mode}
                        onChange={(e) => setDescTransform({ mode: e.target.value as AttributeTransformMode })}
                        style={{ padding: "5px 8px", fontSize: "0.75rem", border: "1px solid var(--border)", borderRadius: 4, background: "var(--surface)", color: "var(--text)" }}
                      >
                        <option value="template">Template</option>
                        <option value="literal">Literal</option>
                        <option value="transcript_extract">Extract from transcript</option>
                        <option value="transcript_llm">LLM summary (OpenRouter)</option>
                      </select>
                    </div>
                    {(editing.transforms.description.mode === "template" ||
                      editing.transforms.description.mode === "literal") && (
                      <div className="form-field">
                        <label htmlFor={`${panelId}-description-value`}>Value</label>
                        <input
                          id={`${panelId}-description-value`}
                          value={editing.transforms.description.value ?? ""}
                          onChange={(e) => setDescTransform({ value: e.target.value })}
                          placeholder="Recorded {{date:D MMM YYYY}}.\n\n{{description}}"
                        />
                      </div>
                    )}
                    {editing.transforms.description.mode === "transcript_extract" && (
                      <div className="form-field">
                        <label htmlFor={`${panelId}-description-max-chars`}>Max chars</label>
                        <input
                          id={`${panelId}-description-max-chars`}
                          type="number"
                          value={editing.transforms.description.max_chars ?? 800}
                          onChange={(e) => setDescTransform({ max_chars: parseInt(e.target.value) || 800 })}
                          style={{ width: 80 }}
                        />
                      </div>
                    )}
                    {(editing.transforms.description.mode === "transcript_extract" ||
                      editing.transforms.description.mode === "transcript_llm") && (() => {
                      const previewVideo = previewVideoId
                        ? videos.find((v) => v.id === previewVideoId)
                        : videos[0];
                      if (previewVideo && !previewVideo.transcript_text) {
                        return (
                          <div className="form-message" role="status" style={{ fontSize: "0.7rem", color: "var(--yellow, #f59e0b)", padding: "4px 0" }}>
                            No transcript is loaded for the selected video. Load its transcript from the video card first.
                          </div>
                        );
                      }
                      return null;
                    })()}
                    {editing.transforms.description.mode === "transcript_llm" && (
                      <div className="form-field">
                        <label htmlFor={`${panelId}-description-fallback`}>Fallback template (no transcript)</label>
                        <input
                          id={`${panelId}-description-fallback`}
                          value={editing.transforms.description.value ?? ""}
                          onChange={(e) => setDescTransform({ value: e.target.value })}
                          placeholder="{{description}}"
                        />
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Tags transform */}
              <h4 className="rule-section-title">Tags transform</h4>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "0.75rem" }}>
                  <input
                    type="checkbox"
                    checked={!!editing.transforms.tags}
                    onChange={(e) => setTagTransform(e.target.checked ? { mode: "append", tags: [] } : null)}
                  />
                  Override tags
                </label>
              </div>
              {editing.transforms.tags && (
                <div className="rule-editor-grid rule-editor-grid-value">
                  <div className="form-field">
                    <label htmlFor={`${panelId}-tags-mode`}>Mode</label>
                    <select
                      id={`${panelId}-tags-mode`}
                      value={editing.transforms.tags.mode}
                      onChange={(e) => setTagTransform({ mode: e.target.value as "append" | "replace" })}
                      style={{ padding: "5px 8px", fontSize: "0.75rem", border: "1px solid var(--border)", borderRadius: 4, background: "var(--surface)", color: "var(--text)" }}
                    >
                      <option value="append">Append</option>
                      <option value="replace">Replace</option>
                    </select>
                  </div>
                  <div className="form-field">
                    <label htmlFor={`${panelId}-tags-value`}>Tags (comma-separated)</label>
                    <input
                      id={`${panelId}-tags-value`}
                      value={editing.transforms.tags.tags.join(", ")}
                      onChange={(e) =>
                        setTagTransform({
                          tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean),
                        })
                      }
                      placeholder="live-coding, rust, webdev"
                    />
                  </div>
                </div>
              )}

              {/* Trim transform */}
              <h4 className="rule-section-title">Pre-processing: start trim (ADR-021)</h4>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "0.75rem" }}>
                  <input
                    type="checkbox"
                    checked={!!editing.transforms.trim}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        transforms: {
                          ...editing.transforms,
                          trim: e.target.checked ? { snap: "hour" } : undefined,
                        },
                      })
                    }
                  />
                  Snap start to boundary
                </label>
              </div>
              {editing.transforms.trim && (
                <div className="form-field">
                  <label htmlFor={`${panelId}-trim-snap`}>Snap to</label>
                  <select
                    id={`${panelId}-trim-snap`}
                    value={editing.transforms.trim.snap}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        transforms: {
                          ...editing.transforms,
                          trim: { snap: e.target.value as TrimSnapMode },
                        },
                      })
                    }
                    style={{ padding: "5px 8px", fontSize: "0.75rem", border: "1px solid var(--border)", borderRadius: 4, background: "var(--surface)", color: "var(--text)", width: "100%" }}
                  >
                    <option value="hour">:00 (top of hour only)</option>
                    <option value="half">:00 / :30</option>
                    <option value="quarter">:00 / :15 / :30 / :45</option>
                  </select>
                </div>
              )}

              {/* Privacy */}
              <div className="form-field" style={{ marginTop: 8 }}>
                <label htmlFor={`${panelId}-privacy`}>Privacy status</label>
                <select
                  id={`${panelId}-privacy`}
                  value={editing.transforms.privacy_status ?? ""}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      transforms: {
                        ...editing.transforms,
                        privacy_status: e.target.value
                          ? (e.target.value as "private" | "unlisted" | "public")
                          : undefined,
                      },
                    })
                  }
                  style={{ padding: "5px 8px", fontSize: "0.75rem", border: "1px solid var(--border)", borderRadius: 4, background: "var(--surface)", color: "var(--text)", width: "100%" }}
                >
                  <option value="">(use default: unlisted)</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
              </div>

              {editError && (
                <div id={`${panelId}-error`} className="form-message form-message-error" role="alert">{editError}</div>
              )}

              <div className="form-actions">
                <button type="submit" className="btn btn-sm btn-green">Save rule</button>
                <button type="button" className="btn btn-sm" onClick={() => { setEditing(null); setEditError(null); }}>Cancel</button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
