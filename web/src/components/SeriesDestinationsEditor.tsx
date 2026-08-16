"use client";

/**
 * ADR-075 Phase 2 — inline editor for a series entry's destinations
 * array. Renders below a SeriesRegistryPanel row when the operator
 * clicks Edit. Each row in this editor is a DestinationSpec with
 * platform-specific fields.
 */

import type { DestinationSpec } from "../lib/youtubeTitleAlign";

interface Props {
  value: DestinationSpec[] | undefined;
  onChange: (next: DestinationSpec[]) => void;
}

const PLATFORMS: Array<DestinationSpec["platform"]> = ["YouTube", "Kaltura", "GoogleDrive", "Other"];

function blankSpec(platform: DestinationSpec["platform"]): DestinationSpec {
  switch (platform) {
    case "YouTube":     return { platform: "YouTube", visibility: "unlisted" };
    case "Kaltura":     return { platform: "Kaltura", visibility: "members" };
    case "GoogleDrive": return { platform: "GoogleDrive", folder_id: "", share_scope: "inherit" };
    case "Other":       return { platform: "Other", label: "" };
  }
}

const cellInput: React.CSSProperties = {
  padding: "3px 6px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--text)",
  fontSize: "0.78rem",
  fontFamily: "monospace",
};

export default function SeriesDestinationsEditor({ value, onChange }: Props) {
  const list = value ?? [];

  function replaceAt(i: number, next: DestinationSpec) {
    const nextList = list.slice();
    nextList[i] = next;
    onChange(nextList);
  }
  function removeAt(i: number) {
    const nextList = list.slice();
    nextList.splice(i, 1);
    onChange(nextList);
  }
  function add(platform: DestinationSpec["platform"]) {
    onChange([...list, blankSpec(platform)]);
  }

  return (
    <div style={{ padding: "8px 8px 12px", background: "var(--bg-card, rgba(99,102,241,0.03))", borderTop: "1px dashed var(--border)" }}>
      <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: 6 }}>
        <strong>Destinations</strong> — where records matching this series publish (ADR-075 Phase 2).
        Empty = fall back to profile default_privacy / global default.
      </div>

      {list.length === 0 ? (
        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontStyle: "italic", marginBottom: 8 }}>
          No destinations configured; profile default applies.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
          {list.map((d, i) => (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ minWidth: 90, fontSize: "0.75rem", fontWeight: 600 }}>{d.platform}</span>
              {d.platform === "YouTube" && (
                <>
                  <label style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>visibility:</label>
                  <select
                    value={d.visibility}
                    onChange={e => replaceAt(i, { ...d, visibility: e.target.value as "public" | "unlisted" | "private" })}
                    style={cellInput}
                  >
                    <option value="public">public</option>
                    <option value="unlisted">unlisted</option>
                    <option value="private">private</option>
                  </select>
                  <input
                    value={d.playlist_id ?? ""}
                    onChange={e => replaceAt(i, { ...d, playlist_id: e.target.value || undefined })}
                    placeholder="playlist id (optional)"
                    style={{ ...cellInput, flex: "1 1 180px", minWidth: 140 }}
                  />
                </>
              )}
              {d.platform === "Kaltura" && (
                <>
                  <label style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>visibility:</label>
                  <select
                    value={d.visibility}
                    onChange={e => replaceAt(i, { ...d, visibility: e.target.value as "public" | "members" | "unlisted" })}
                    style={cellInput}
                  >
                    <option value="public">public</option>
                    <option value="members">members</option>
                    <option value="unlisted">unlisted</option>
                  </select>
                  <input
                    value={(d.category_ids ?? []).join(",")}
                    onChange={e => replaceAt(i, { ...d, category_ids: e.target.value ? e.target.value.split(",").map(s => s.trim()).filter(Boolean) : undefined })}
                    placeholder="category ids (comma-separated, optional)"
                    style={{ ...cellInput, flex: "1 1 240px", minWidth: 160 }}
                  />
                </>
              )}
              {d.platform === "GoogleDrive" && (
                <>
                  <input
                    value={d.folder_id}
                    onChange={e => {
                      // Accept either a bare folder id or a pasted Drive URL;
                      // normalise to just the id so downstream consumers
                      // don't have to strip it again.
                      const raw = e.target.value;
                      const m1 = raw.match(/\/folders\/([A-Za-z0-9_-]{20,})/);
                      const m2 = raw.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
                      const normalised = m1?.[1] ?? m2?.[1] ?? raw;
                      replaceAt(i, { ...d, folder_id: normalised });
                    }}
                    placeholder="Drive folder id (or paste the folder URL)"
                    style={{ ...cellInput, flex: "1 1 200px", minWidth: 160 }}
                  />
                  <label style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>share:</label>
                  <select
                    value={d.share_scope}
                    onChange={e => replaceAt(i, { ...d, share_scope: e.target.value as "inherit" | "org_restricted" | "anyone_with_link" })}
                    style={cellInput}
                  >
                    <option value="inherit">inherit</option>
                    <option value="org_restricted">org_restricted</option>
                    <option value="anyone_with_link">anyone_with_link</option>
                  </select>
                </>
              )}
              {d.platform === "Other" && (
                <>
                  <input
                    value={d.label}
                    onChange={e => replaceAt(i, { ...d, label: e.target.value })}
                    placeholder="e.g. Vimeo, private-server"
                    style={{ ...cellInput, flex: "1 1 200px", minWidth: 160 }}
                  />
                  <span
                    style={{ fontSize: "0.7rem", color: "var(--yellow)" }}
                    title="Manual destinations aren't automated by the tool — Publish preview shows a checklist marker; the operator must action them by hand."
                  >
                    ⚠ manual
                  </span>
                </>
              )}
              <button
                className="btn btn-sm"
                onClick={() => removeAt(i)}
                title="Remove this destination"
                style={{ padding: "2px 8px", marginLeft: "auto" }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "0.72rem" }}>
        <span style={{ color: "var(--text-muted)" }}>+ Add:</span>
        {PLATFORMS.map(p => (
          <button
            key={p}
            className="btn btn-sm"
            onClick={() => add(p)}
            style={{ padding: "2px 8px", fontSize: "0.72rem" }}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
