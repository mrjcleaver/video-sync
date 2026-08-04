"use client";

import { useState, useCallback, useRef } from "react";
import {
  loadRules,
  saveRules,
  runRules,
  type IngestionRule,
  type RuleCriteria,
  type RuleAction,
} from "../lib/rules";
import { videoStore } from "../lib/store";
import HelpTip from "./HelpTip";
import ConfirmDialog from "./ConfirmDialog";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function emptyRule(): IngestionRule {
  return {
    id: `rule-${Date.now()}`,
    name: "",
    enabled: true,
    priority: 10,
    criteria: { min_duration_secs: 25 * 60 },
    action: "mark_in_scope",
  };
}

interface Props {
  isRunnerRunning: boolean;
  lastRun: Date | null;
  matchCount: number;
  onRunNow: () => void;
}

export default function RulesPanel({
  isRunnerRunning,
  lastRun,
  matchCount,
  onRunNow,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [rules, setRules] = useState<IngestionRule[]>(() => loadRules());
  const [editing, setEditing] = useState<IngestionRule | null>(null);
  const [dryRunResult, setDryRunResult] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<IngestionRule | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const persist = useCallback(
    (updated: IngestionRule[]) => {
      setRules(updated);
      saveRules(updated);
    },
    []
  );

  function toggleEnabled(id: string) {
    const updated = rules.map((r) =>
      r.id === id ? { ...r, enabled: !r.enabled } : r
    );
    persist(updated);
  }

  function deleteRule(id: string) {
    persist(rules.filter((r) => r.id !== id));
  }

  function startEdit(rule?: IngestionRule) {
    setEditing(rule ? { ...rule, criteria: { ...rule.criteria } } : emptyRule());
    setEditError(null);
  }

  function saveEdit() {
    if (!editing) return;
    if (!editing.name.trim()) {
      setEditError("Enter a rule name.");
      nameInputRef.current?.focus();
      return;
    }
    const idx = rules.findIndex((r) => r.id === editing.id);
    const updated = idx >= 0
      ? rules.map((r) => (r.id === editing.id ? editing : r))
      : [...rules, editing];
    persist(updated);
    setEditing(null);
    setEditError(null);
  }

  function dryRun() {
    const videos = videoStore.getAll();
    const result = runRules(rules, videos);
    setDryRunResult(
      `${result.actions.length} video(s) would match across ${new Set(result.actions.map((a) => a.ruleId)).size} rule(s)`
    );
    setTimeout(() => setDryRunResult(null), 5000);
  }

  function updateCriteria(patch: Partial<RuleCriteria>) {
    if (!editing) return;
    setEditing({ ...editing, criteria: { ...editing.criteria, ...patch } });
  }

  function toggleDay(day: number) {
    if (!editing) return;
    const current = editing.criteria.days_of_week ?? [];
    const next = current.includes(day)
      ? current.filter((d) => d !== day)
      : [...current, day];
    updateCriteria({ days_of_week: next.length > 0 ? next : undefined });
  }

  return (
    <div className="rules-panel">
      <h2>
        <button
          type="button"
          className="panel-heading-button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls={expanded ? "ingestion-rules-content" : undefined}
        >
          <span>Ingestion rules {rules.length > 0 && `(${rules.length})`}</span>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {isRunnerRunning && (
            <span style={{ fontSize: "0.7rem", color: "var(--green)" }}>running</span>
          )}
          {lastRun && (
            <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>
              last: {lastRun.toLocaleTimeString()} ({matchCount} matched)
            </span>
          )}
          <span style={{ fontSize: "0.8rem" }}>{expanded ? "\u25B2" : "\u25BC"}</span>
          </span>
        </button>
      </h2>

      {expanded && (
        <div id="ingestion-rules-content">
          <HelpTip>
            Ingestion rules auto-classify recordings as they arrive. Each rule has criteria
            (title pattern, day of week, duration range, date window) and an action:{" "}
            <em>Mark In Scope</em> flags a video for review, <em>Auto Approve</em> immediately
            approves it for publishing, and <em>Auto Skip</em> excludes it permanently. Rules
            run in priority order (lower number = first). Use <em>Dry Run</em> to preview
            matches without applying changes, or <em>Run Now</em> to apply all rules
            to the current library immediately.
          </HelpTip>

          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => startEdit()}>
              Add rule
            </button>
            <button type="button" className="btn btn-sm" onClick={dryRun}>
              Dry run
            </button>
            <button type="button" className="btn btn-sm btn-green" onClick={onRunNow}>
              Run now
            </button>
          </div>

          {dryRunResult && (
            <div role="status" style={{ fontSize: "0.8rem", color: "var(--accent)", marginBottom: 8 }}>
              {dryRunResult}
            </div>
          )}

          {rules.length === 0 && (
            <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", padding: "12px 0" }}>
              No rules defined. Add a rule to auto-classify recordings.
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
                <span className="rule-item-name">
                  {rule.name}
                </span>
                <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                  P{rule.priority}
                </span>
                <span
                  className={`status-badge ${
                    rule.action === "mark_in_scope"
                      ? "status-InScope"
                      : rule.action === "auto_approve"
                      ? "status-Approved"
                      : "status-Skipped"
                  }`}
                  style={{ fontSize: "0.65rem" }}
                >
                  {rule.action.replace("_", " ")}
                </span>
                <button type="button" className="btn btn-sm" onClick={() => startEdit(rule)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-red"
                  onClick={() => setPendingDelete(rule)}
                >
                  Delete
                </button>
              </div>
              {rule.criteria.title_pattern && (
                <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 4 }}>
                  title: /{rule.criteria.title_pattern}/i
                  {rule.criteria.title_exclude && ` exclude: /${rule.criteria.title_exclude}/i`}
                </div>
              )}
            </div>
          ))}

          {/* Edit form */}
          {editing && (
            <div className="rule-form">
              <div className="form-field">
                <label htmlFor="ingestion-rule-name">Name</label>
                <input
                  ref={nameInputRef}
                  id="ingestion-rule-name"
                  value={editing.name}
                  onChange={(e) => {
                    setEditing({ ...editing, name: e.target.value });
                    setEditError(null);
                  }}
                  placeholder="Rule name"
                  required
                  aria-invalid={!!editError}
                  aria-describedby={editError ? "ingestion-rule-name-error" : undefined}
                />
                {editError && (
                  <span id="ingestion-rule-name-error" className="field-error" role="alert" aria-live="assertive">
                    {editError}
                  </span>
                )}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <div className="form-field">
                  <label htmlFor="ingestion-rule-priority">Priority (lower = first)</label>
                  <input
                    id="ingestion-rule-priority"
                    type="number"
                    value={editing.priority}
                    onChange={(e) =>
                      setEditing({ ...editing, priority: parseInt(e.target.value) || 0 })
                    }
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="ingestion-rule-action">Action</label>
                  <select
                    id="ingestion-rule-action"
                    value={editing.action}
                    onChange={(e) =>
                      setEditing({ ...editing, action: e.target.value as RuleAction })
                    }
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      fontSize: "0.75rem",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      background: "var(--surface)",
                      color: "var(--text)",
                    }}
                  >
                    <option value="mark_in_scope">Mark In Scope</option>
                    <option value="auto_approve">Auto Approve</option>
                    <option value="auto_skip">Auto Skip</option>
                  </select>
                </div>
              </div>

              <div className="form-field">
                <label htmlFor="ingestion-rule-title-pattern">Title pattern (regex)</label>
                <input
                  id="ingestion-rule-title-pattern"
                  value={editing.criteria.title_pattern ?? ""}
                  onChange={(e) =>
                    updateCriteria({ title_pattern: e.target.value || undefined })
                  }
                  placeholder="e.g. standup|retro"
                />
              </div>

              <div className="form-field">
                <label htmlFor="ingestion-rule-title-exclude">Title exclude (regex)</label>
                <input
                  id="ingestion-rule-title-exclude"
                  value={editing.criteria.title_exclude ?? ""}
                  onChange={(e) =>
                    updateCriteria({ title_exclude: e.target.value || undefined })
                  }
                  placeholder="e.g. test|sandbox"
                />
              </div>

              <div className="form-field">
                <span className="field-label">Days of week</span>
                <div role="group" aria-label="Days of week" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {DAYS.map((label, i) => (
                    <button
                      key={i}
                      type="button"
                      className={`btn btn-sm ${
                        (editing.criteria.days_of_week ?? []).includes(i)
                          ? "btn-primary"
                          : ""
                      }`}
                      onClick={() => toggleDay(i)}
                      aria-pressed={(editing.criteria.days_of_week ?? []).includes(i)}
                      style={{ minWidth: 36 }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <div className="form-field">
                  <label htmlFor="ingestion-rule-min-duration">Minimum duration (minutes)</label>
                  <input
                    id="ingestion-rule-min-duration"
                    type="number"
                    value={editing.criteria.min_duration_secs != null ? Math.round(editing.criteria.min_duration_secs / 60) : ""}
                    onChange={(e) =>
                      updateCriteria({
                        min_duration_secs: e.target.value
                          ? parseInt(e.target.value) * 60
                          : undefined,
                      })
                    }
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="ingestion-rule-max-duration">Maximum duration (minutes)</label>
                  <input
                    id="ingestion-rule-max-duration"
                    type="number"
                    value={editing.criteria.max_duration_secs != null ? Math.round(editing.criteria.max_duration_secs / 60) : ""}
                    onChange={(e) =>
                      updateCriteria({
                        max_duration_secs: e.target.value
                          ? parseInt(e.target.value) * 60
                          : undefined,
                      })
                    }
                  />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <div className="form-field">
                  <label htmlFor="ingestion-rule-date-from">Date from</label>
                  <input
                    id="ingestion-rule-date-from"
                    type="date"
                    value={editing.criteria.date_from ?? ""}
                    onChange={(e) =>
                      updateCriteria({ date_from: e.target.value || undefined })
                    }
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="ingestion-rule-date-to">Date to</label>
                  <input
                    id="ingestion-rule-date-to"
                    type="date"
                    value={editing.criteria.date_to ?? ""}
                    onChange={(e) =>
                      updateCriteria({ date_to: e.target.value || undefined })
                    }
                  />
                </div>
              </div>

              <div className="form-actions">
                <button type="button" className="btn btn-sm btn-green" onClick={saveEdit}>
                  Save
                </button>
                <button type="button" className="btn btn-sm" onClick={() => { setEditing(null); setEditError(null); }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          <ConfirmDialog
            open={!!pendingDelete}
            title="Delete ingestion rule?"
            description={`This permanently removes ${pendingDelete?.name || "the selected rule"}. Existing video states will not change.`}
            confirmLabel="Delete rule"
            onCancel={() => setPendingDelete(null)}
            onConfirm={() => {
              if (pendingDelete) deleteRule(pendingDelete.id);
              setPendingDelete(null);
            }}
          />
        </div>
      )}
    </div>
  );
}
