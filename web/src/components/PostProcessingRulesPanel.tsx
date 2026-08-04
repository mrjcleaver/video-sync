"use client";

import { useState, useCallback, useId } from "react";
import {
  loadPostProcessingRules,
  savePostProcessingRules,
  type PostProcessingRule,
  type PostProcessingTrigger,
  type PostProcessingAction,
} from "../lib/processingRules";
import HelpTip from "./HelpTip";

function emptyRule(): PostProcessingRule {
  return {
    id: `post-${Date.now()}`,
    name: "",
    enabled: true,
    trigger: "success",
    action: { type: "webhook", url: "" },
  };
}

export default function PostProcessingRulesPanel() {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [rules, setRules] = useState<PostProcessingRule[]>(() => loadPostProcessingRules());
  const [editing, setEditing] = useState<PostProcessingRule | null>(null);
  const [deletePendingId, setDeletePendingId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const persist = useCallback((updated: PostProcessingRule[]) => {
    setRules(updated);
    savePostProcessingRules(updated);
  }, []);

  function toggleEnabled(id: string) {
    const rule = rules.find((r) => r.id === id);
    persist(rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
    if (rule) setStatusMessage(`${rule.name} ${rule.enabled ? "disabled" : "enabled"}.`);
  }

  function deleteRule(id: string) {
    const rule = rules.find((r) => r.id === id);
    persist(rules.filter((r) => r.id !== id));
    setDeletePendingId(null);
    if (rule) setStatusMessage(`${rule.name} deleted.`);
  }

  function startEdit(rule?: PostProcessingRule) {
    setEditing(rule ? JSON.parse(JSON.stringify(rule)) : emptyRule());
    setEditError(null);
    setDeletePendingId(null);
  }

  function saveEdit() {
    if (!editing) return;
    if (!editing.name.trim()) {
      setEditError("Enter a rule name.");
      return;
    }
    if (editing.action.type === "webhook" && !editing.action.url.trim()) {
      setEditError("Enter a webhook URL.");
      return;
    }
    if (editing.action.type === "email" && !editing.action.to.trim()) {
      setEditError("Enter an email address.");
      return;
    }
    const idx = rules.findIndex((r) => r.id === editing.id);
    persist(idx >= 0 ? rules.map((r) => (r.id === editing.id ? editing : r)) : [...rules, editing]);
    setStatusMessage(`${editing.name} saved.`);
    setEditing(null);
    setEditError(null);
  }

  function setActionType(type: PostProcessingAction["type"]) {
    if (!editing) return;
    const action: PostProcessingAction =
      type === "webhook"
        ? { type: "webhook", url: "" }
        : { type: "email", to: "", subject_template: "" };
    setEditing({ ...editing, action });
    setEditError(null);
  }

  function patchAction(patch: Partial<PostProcessingAction>) {
    if (!editing) return;
    setEditing({ ...editing, action: { ...editing.action, ...patch } as PostProcessingAction });
  }

  const triggerLabel: Record<PostProcessingTrigger, string> = {
    success: "On success",
    failure: "On failure",
    always: "Always",
  };

  return (
    <div className="rules-panel">
      <h2>
        <button
          type="button"
          className="rules-panel-toggle"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls={`${panelId}-content`}
        >
          <span>Post-processing rules {rules.length > 0 && `(${rules.length})`}</span>
          <span aria-hidden="true" style={{ fontSize: "0.8rem" }}>{expanded ? "▲" : "▼"}</span>
        </button>
      </h2>

      {expanded && (
        <div id={`${panelId}-content`}>
          <HelpTip>
            Post-processing rules fire non-blocking after a YouTube upload completes (success or
            failure). Each rule sends a <strong>webhook</strong> POST or a <strong>Gmail email</strong>.
            Credentials for Gmail are set via <code>GMAIL_FROM</code> and{" "}
            <code>GMAIL_APP_PASSWORD</code> environment variables. All events are logged.
          </HelpTip>

          <div style={{ marginBottom: 12 }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => startEdit()}>
              Add rule
            </button>
          </div>

          {statusMessage && (
            <div className="form-message" role="status" aria-live="polite">{statusMessage}</div>
          )}

          {rules.length === 0 && (
            <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", padding: "12px 0" }}>
              No post-processing rules. Add a rule to fire webhooks or send emails after upload.
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
                <span style={{ fontWeight: 500, fontSize: "0.85rem", flex: 1 }}>{rule.name}</span>
                <span className="status-badge" style={{ fontSize: "0.65rem", background: "var(--surface)" }}>
                  {triggerLabel[rule.trigger]}
                </span>
                <span className="status-badge" style={{ fontSize: "0.65rem", background: "var(--surface)" }}>
                  {rule.action.type}
                </span>
                <button type="button" className="btn btn-sm" onClick={() => startEdit(rule)}>Edit</button>
                {deletePendingId === rule.id ? (
                  <span className="inline-confirm" role="group" aria-label={`Confirm deletion of ${rule.name}`}>
                    <span>Delete this rule?</span>
                    <button type="button" className="btn btn-sm btn-red" onClick={() => deleteRule(rule.id)}>Yes, delete</button>
                    <button type="button" className="btn btn-sm" onClick={() => setDeletePendingId(null)} autoFocus>Cancel</button>
                  </span>
                ) : (
                  <button type="button" className="btn btn-sm btn-red" onClick={() => setDeletePendingId(rule.id)}>Delete</button>
                )}
              </div>
              <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 4 }}>
                {rule.action.type === "webhook"
                  ? `→ ${rule.action.url}`
                  : `→ ${rule.action.to}`}
              </div>
            </div>
          ))}

          {editing && (
            <form className="rule-form rule-editor" onSubmit={(event) => { event.preventDefault(); saveEdit(); }} noValidate>
              <h3 className="rule-editor-title">
                {rules.find((r) => r.id === editing.id) ? "Edit" : "New"} post-processing rule
              </h3>

              <div className="form-field">
                <label htmlFor={`${panelId}-name`}>Name</label>
                <input
                  id={`${panelId}-name`}
                  value={editing.name}
                  onChange={(e) => { setEditing({ ...editing, name: e.target.value }); setEditError(null); }}
                  placeholder="e.g. Notify Slack on publish"
                  aria-invalid={editError === "Enter a rule name."}
                  aria-describedby={editError ? `${panelId}-error` : undefined}
                />
              </div>

              <div className="form-field">
                <label htmlFor={`${panelId}-trigger`}>Trigger</label>
                <select
                  id={`${panelId}-trigger`}
                  value={editing.trigger}
                  onChange={(e) => setEditing({ ...editing, trigger: e.target.value as PostProcessingTrigger })}
                  style={{ padding: "5px 8px", fontSize: "0.75rem", border: "1px solid var(--border)", borderRadius: 4, background: "var(--surface)", color: "var(--text)", width: "100%" }}
                >
                  <option value="success">On success</option>
                  <option value="failure">On failure</option>
                  <option value="always">Always (success or failure)</option>
                </select>
              </div>

              <h4 className="rule-section-title">Action</h4>

              <div className="form-field">
                <label htmlFor={`${panelId}-action-type`}>Type</label>
                <select
                  id={`${panelId}-action-type`}
                  value={editing.action.type}
                  onChange={(e) => setActionType(e.target.value as PostProcessingAction["type"])}
                  style={{ padding: "5px 8px", fontSize: "0.75rem", border: "1px solid var(--border)", borderRadius: 4, background: "var(--surface)", color: "var(--text)", width: "100%" }}
                >
                  <option value="webhook">Webhook (HTTP POST)</option>
                  <option value="email">Email (Gmail)</option>
                </select>
              </div>

              {editing.action.type === "webhook" && (
                <div className="form-field">
                  <label htmlFor={`${panelId}-webhook-url`}>Webhook URL</label>
                  <input
                    id={`${panelId}-webhook-url`}
                    value={editing.action.url}
                    onChange={(e) => { patchAction({ url: e.target.value }); setEditError(null); }}
                    placeholder="https://hooks.example.com/..."
                    aria-invalid={editError === "Enter a webhook URL."}
                    aria-describedby={editError ? `${panelId}-error` : undefined}
                  />
                </div>
              )}

              {editing.action.type === "email" && (
                <>
                  <div className="form-field">
                    <label htmlFor={`${panelId}-email-to`}>To address</label>
                    <input
                      id={`${panelId}-email-to`}
                      value={editing.action.to}
                      onChange={(e) => { patchAction({ to: e.target.value }); setEditError(null); }}
                      placeholder="you@example.com"
                      aria-invalid={editError === "Enter an email address."}
                      aria-describedby={editError ? `${panelId}-error` : undefined}
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor={`${panelId}-email-subject`}>Subject template (optional)</label>
                    <input
                      id={`${panelId}-email-subject`}
                      value={editing.action.subject_template ?? ""}
                      onChange={(e) => patchAction({ subject_template: e.target.value || undefined })}
                      placeholder="Video {{status}}: {{title}}"
                    />
                    <div className="field-help">
                      Variables: {"{{title}}"} {"{{status}}"}. Leave empty for default subject.
                    </div>
                  </div>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", padding: "6px 0" }}>
                    Requires <code>GMAIL_FROM</code> and <code>GMAIL_APP_PASSWORD</code> in environment.
                  </div>
                </>
              )}

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
