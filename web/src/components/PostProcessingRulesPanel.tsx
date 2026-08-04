"use client";

import { useState, useCallback } from "react";
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
  const [expanded, setExpanded] = useState(false);
  const [rules, setRules] = useState<PostProcessingRule[]>(() => loadPostProcessingRules());
  const [editing, setEditing] = useState<PostProcessingRule | null>(null);

  const persist = useCallback((updated: PostProcessingRule[]) => {
    setRules(updated);
    savePostProcessingRules(updated);
  }, []);

  function toggleEnabled(id: string) {
    persist(rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  }

  function deleteRule(id: string) {
    persist(rules.filter((r) => r.id !== id));
  }

  function startEdit(rule?: PostProcessingRule) {
    setEditing(rule ? JSON.parse(JSON.stringify(rule)) : emptyRule());
  }

  function saveEdit() {
    if (!editing || !editing.name.trim()) return;
    if (editing.action.type === "webhook" && !editing.action.url.trim()) return;
    if (editing.action.type === "email" && !editing.action.to.trim()) return;
    const idx = rules.findIndex((r) => r.id === editing.id);
    persist(idx >= 0 ? rules.map((r) => (r.id === editing.id ? editing : r)) : [...rules, editing]);
    setEditing(null);
  }

  function setActionType(type: PostProcessingAction["type"]) {
    if (!editing) return;
    const action: PostProcessingAction =
      type === "webhook"
        ? { type: "webhook", url: "" }
        : { type: "email", to: "", subject_template: "" };
    setEditing({ ...editing, action });
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
          className="panel-heading-button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls="post-processing-rules-content"
        >
        <span>Post-processing Rules {rules.length > 0 && `(${rules.length})`}</span>
        <span style={{ fontSize: "0.8rem" }}>{expanded ? "▲" : "▼"}</span>
        </button>
      </h2>

      {expanded && (
        <div id="post-processing-rules-content">
          <HelpTip>
            Post-processing rules fire non-blocking after a YouTube upload completes (success or
            failure). Each rule sends a <strong>webhook</strong> POST or a <strong>Gmail email</strong>.
            Credentials for Gmail are set via <code>GMAIL_FROM</code> and{" "}
            <code>GMAIL_APP_PASSWORD</code> environment variables. All events are logged.
          </HelpTip>

          <div style={{ marginBottom: 12 }}>
            <button className="btn btn-sm btn-primary" onClick={() => startEdit()}>
              Add Rule
            </button>
          </div>

          {rules.length === 0 && (
            <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", padding: "12px 0" }}>
              No post-processing rules. Add a rule to fire webhooks or send emails after upload.
            </div>
          )}

          {rules.map((rule) => (
            <div key={rule.id} className="rule-item">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
                <button className="btn btn-sm" onClick={() => startEdit(rule)}>Edit</button>
                <button className="btn btn-sm btn-red" onClick={() => deleteRule(rule.id)}>Del</button>
              </div>
              <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 4 }}>
                {rule.action.type === "webhook"
                  ? `→ ${rule.action.url}`
                  : `→ ${rule.action.to}`}
              </div>
            </div>
          ))}

          {editing && (
            <div className="rule-form">
              <div style={{ fontSize: "0.75rem", color: "var(--accent)", marginBottom: 8, fontWeight: 600 }}>
                {rules.find((r) => r.id === editing.id) ? "Edit" : "New"} Post-processing Rule
              </div>

              <div className="form-field">
                <label>Name</label>
                <input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="e.g. Notify Slack on publish"
                />
              </div>

              <div className="form-field">
                <label>Trigger</label>
                <select
                  value={editing.trigger}
                  onChange={(e) => setEditing({ ...editing, trigger: e.target.value as PostProcessingTrigger })}
                  style={{ padding: "5px 8px", fontSize: "0.75rem", border: "1px solid var(--border)", borderRadius: 4, background: "var(--surface)", color: "var(--text)", width: "100%" }}
                >
                  <option value="success">On success</option>
                  <option value="failure">On failure</option>
                  <option value="always">Always (success or failure)</option>
                </select>
              </div>

              <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", margin: "8px 0 4px", fontWeight: 600 }}>
                Action
              </div>

              <div className="form-field">
                <label>Type</label>
                <select
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
                  <label>Webhook URL</label>
                  <input
                    value={editing.action.url}
                    onChange={(e) => patchAction({ url: e.target.value })}
                    placeholder="https://hooks.example.com/..."
                  />
                </div>
              )}

              {editing.action.type === "email" && (
                <>
                  <div className="form-field">
                    <label>To address</label>
                    <input
                      value={editing.action.to}
                      onChange={(e) => patchAction({ to: e.target.value })}
                      placeholder="you@example.com"
                    />
                  </div>
                  <div className="form-field">
                    <label>Subject template (optional)</label>
                    <input
                      value={editing.action.subject_template ?? ""}
                      onChange={(e) => patchAction({ subject_template: e.target.value || undefined })}
                      placeholder="Video {{status}}: {{title}}"
                    />
                    <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 2 }}>
                      Variables: {"{{title}}"} {"{{status}}"}. Leave empty for default subject.
                    </div>
                  </div>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", padding: "6px 0" }}>
                    Requires <code>GMAIL_FROM</code> and <code>GMAIL_APP_PASSWORD</code> in environment.
                  </div>
                </>
              )}

              <div className="form-actions">
                <button className="btn btn-sm btn-green" onClick={saveEdit}>Save</button>
                <button className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
