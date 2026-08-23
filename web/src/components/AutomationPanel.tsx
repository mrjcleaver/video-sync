"use client";

/**
 * Bulk automation kill switch (Config → Bulk automation).
 *
 * One switch over every background activity that mutates the catalog or
 * pushes to a platform without an operator watching each item. Default is
 * OFF, including on a fresh deployment, so shipping a change to the
 * publish path can't start uploading before someone has looked at it.
 *
 * Read-only polling — the activity feed, the access log, memory health —
 * is not gated and keeps running. Those observe; they don't act.
 */

import { useEffect, useState } from "react";
import {
  getAutomationSettings,
  setBulkAutomation,
  type AutomationSettings,
} from "../lib/bulkAutomation";
import { useCurrentActor } from "../lib/useCurrentActor";

/** What the switch actually gates, in the operator's terms rather than
 *  the code's. Kept beside the toggle because "bulk automation" alone
 *  doesn't tell anyone what will start moving. */
const GATED = [
  "Backfill uploader — publishes queued videos on a 5-minute timer",
  "Ingestion rules — scopes, approves and skips records every minute",
  "Catch-up sweep — bulk summarising and linking, spends LLM budget",
];

export default function AutomationPanel() {
  const actorState = useCurrentActor();
  const isAdmin = actorState.actor?.role === "Admin";

  const [settings, setSettings] = useState<AutomationSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getAutomationSettings().then(setSettings);
  }, []);

  async function toggle() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      setSettings(await setBulkAutomation(!settings.bulk_enabled));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const enabled = settings?.bulk_enabled === true;

  return (
    <div className="zoom-import">
      <div className="zoom-import-header">
        <h2>Bulk automation</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              fontSize: "0.72rem",
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 10,
              color: enabled ? "var(--green)" : "var(--yellow)",
              border: `1px solid ${enabled ? "var(--green)" : "var(--yellow)"}`,
            }}
          >
            {settings === null ? "checking…" : enabled ? "ON" : "OFF"}
          </span>
          <button
            className={`btn btn-sm ${enabled ? "btn-red" : "btn-green"}`}
            onClick={toggle}
            disabled={saving || settings === null || !isAdmin}
            title={
              !isAdmin
                ? "Admin role required to change this"
                : enabled
                  ? "Stop all unattended batch activity"
                  : "Allow unattended batch activity"
            }
          >
            {saving ? "Saving…" : enabled ? "Turn off" : "Turn on"}
          </button>
        </div>
      </div>

      <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: "0 0 8px" }}>
        {enabled
          ? "Unattended batch activity is allowed. The controls below can run on their own timers."
          : "Unattended batch activity is off. These controls are disabled and nothing runs on a timer."}
      </p>

      <ul style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: "0.82rem", color: "var(--text-muted)" }}>
        {GATED.map(item => (
          <li key={item} style={{ marginBottom: 2 }}>{item}</li>
        ))}
      </ul>

      <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", margin: "0 0 8px" }}>
        Publishing a single record by hand is never blocked — this only covers
        activity that runs without someone watching each item. Reading and
        monitoring keep working either way.
      </p>

      {settings?.set_by && settings?.set_at && (
        <p style={{ fontSize: "0.74rem", color: "var(--text-muted)", margin: 0 }}>
          Last changed by {settings.set_by} on{" "}
          {new Date(settings.set_at).toLocaleString()}
        </p>
      )}

      {!isAdmin && (
        <p style={{ fontSize: "0.78rem", color: "var(--yellow)", margin: "6px 0 0" }}>
          Admin role required to change this setting.
        </p>
      )}

      {error && (
        <p style={{ fontSize: "0.78rem", color: "var(--red)", margin: "6px 0 0" }}>
          {error}
        </p>
      )}
    </div>
  );
}
