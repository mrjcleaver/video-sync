"use client";

import { useState, useEffect, useMemo } from "react";
import HelpTip from "./HelpTip";
import { useCurrentActor } from "../lib/useCurrentActor";

const STORAGE_KEY = "video-sync:connections";

type CredentialType = "OAUTH2" | "API_KEY";

/**
 * Platforms whose credentials can be served from the server's shared
 * Secret Manager (ADR-042). Must match SHARED_PLATFORMS in
 * lib/sharedCredentials.ts on the server. YouTube and Loom are absent
 * by design (per-operator OAuth / discontinued API).
 */
const SHARED_PLATFORM_NAMES = ["Zoom", "Fireflies", "Kaltura", "OpenRouter", "OpusClip"] as const;
type SharedPlatformName = (typeof SHARED_PLATFORM_NAMES)[number];
function isSharedPlatformName(s: string): s is SharedPlatformName {
  return (SHARED_PLATFORM_NAMES as readonly string[]).includes(s);
}

/** Server platform key (lowercase) — what the API routes expect on the path. */
function sharedPlatformKey(name: SharedPlatformName): string {
  return name.toLowerCase();
}

/** Platforms that ONLY allow shared (admin-managed) credentials —
 *  no per-operator override. ADR-042: Kaltura admin secret is too
 *  high-blast-radius to type into operator browsers. */
const SHARED_ONLY_PLATFORMS = new Set<string>(["Kaltura"]);

interface PlatformInfo {
  name: string;
  description: string;
  credentialType: CredentialType;
  fields: FieldDef[];
}

interface FieldDef {
  key: string;
  label: string;
  type: "text" | "password";
  placeholder: string;
  required: boolean;
}

const PLATFORMS: PlatformInfo[] = [
  {
    name: "Zoom",
    description: "Cloud meeting recordings",
    credentialType: "OAUTH2",
    fields: [
      { key: "accountId", label: "Account ID", type: "text", placeholder: "Your Zoom Account ID", required: true },
      { key: "clientId", label: "Client ID", type: "text", placeholder: "Your Zoom OAuth Client ID", required: true },
      { key: "clientSecret", label: "Client Secret", type: "password", placeholder: "Your Zoom OAuth Client Secret", required: true },
    ],
  },
  {
    name: "Fireflies",
    description: "AI meeting notes",
    credentialType: "API_KEY",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "Your Fireflies API key", required: true },
    ],
  },
  {
    name: "YouTube",
    description: "Video publishing",
    credentialType: "OAUTH2",
    fields: [
      { key: "googleApiKey", label: "Google API Key (for YouTube Data API metadata lookups)", type: "password", placeholder: "AIza...", required: false },
      { key: "ytCookies", label: "YouTube Cookies (Netscape format — required to download videos via yt-dlp)", type: "password", placeholder: "Export with browser extension e.g. 'Get cookies.txt LOCALLY', paste here", required: false },
      { key: "clientId", label: "Client ID", type: "text", placeholder: "Google OAuth Client ID", required: true },
      { key: "clientSecret", label: "Client Secret", type: "password", placeholder: "Google OAuth Client Secret", required: true },
      { key: "channelId", label: "Channel ID", type: "text", placeholder: "UC... channel ID", required: true },
      { key: "refreshToken", label: "Refresh Token (optional — paste to skip OAuth)", type: "password", placeholder: "Paste from OAuth Playground or existing token", required: false },
    ],
  },
  {
    name: "Kaltura",
    description: "Enterprise video",
    credentialType: "API_KEY",
    fields: [
      { key: "partnerId", label: "Partner ID", type: "text", placeholder: "Your Kaltura Partner ID", required: true },
      // Field key matches the server-side resolver (`adminSecret`), not
      // the user-facing label "Admin Secret". Legacy local-storage entries
      // wrote this under `apiKey` — handlers accept either form.
      { key: "adminSecret", label: "Admin Secret", type: "password", placeholder: "Your Kaltura Admin Secret", required: true },
    ],
  },
  {
    name: "OpenRouter",
    description: "LLM transcript summarisation",
    credentialType: "API_KEY",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "sk-or-...", required: true },
      { key: "model", label: "Model (optional)", type: "text", placeholder: "google/gemini-2.0-flash-001", required: false },
    ],
  },
  {
    name: "OpusClip",
    description: "Auto short-form clip generation (ADR-029)",
    credentialType: "API_KEY",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "Opus Clip API key from dashboard", required: true },
    ],
  },
];

interface ConnectionState {
  connected: boolean;
  credentials: Record<string, string>;
}

interface SharedMetaEntry {
  configured: boolean;
  set_by?: string;
  set_at?: string;
  version_count?: number;
}

function loadConnections(): Record<string, ConnectionState> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveConnections(data: Record<string, ConnectionState>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

interface Props { open: boolean; onToggle: () => void; }

type EditorMode = "override" | "shared";

interface EditorState {
  platform: string;
  mode: EditorMode;
}

export default function ConnectionsPanel({ open }: Props) {
  const [connections, setConnections] = useState<Record<string, ConnectionState>>({});
  const [sharedMeta, setSharedMeta] = useState<Record<string, SharedMetaEntry>>({});
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savingShared, setSavingShared] = useState(false);
  const actorState = useCurrentActor();
  const isAdmin = actorState.actor?.role === "Admin";

  useEffect(() => { setConnections(loadConnections()); }, []);

  // Fetch shared metadata on mount + after admin writes (refreshTick).
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/credentials/shared", { cache: "no-store" })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data: { shared?: Record<string, SharedMetaEntry> }) => {
        if (cancelled) return;
        setSharedMeta(data.shared ?? {});
      })
      .catch(() => { /* silent — non-fatal */ });
    return () => { cancelled = true; };
  }, [refreshTick]);

  function openEditor(platform: PlatformInfo, mode: EditorMode) {
    if (mode === "shared" && SHARED_ONLY_PLATFORMS.has(platform.name) && !isAdmin) return;
    if (mode === "override" && SHARED_ONLY_PLATFORMS.has(platform.name)) return;
    const seed = mode === "override"
      ? (connections[platform.name]?.credentials ?? {})
      : {}; // Always start blank for shared edits — secret values are write-only
    setDraft({ ...seed });
    setErrors({});
    setEditor({ platform: platform.name, mode });
  }

  function closeEditor() {
    setEditor(null);
    setDraft({});
    setErrors({});
  }

  async function handleSave(platform: PlatformInfo) {
    const newErrors: Record<string, string> = {};
    for (const field of platform.fields) {
      if (field.required && !draft[field.key]?.trim()) {
        newErrors[field.key] = `${field.label} is required`;
      }
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    if (editor?.mode === "shared") {
      if (!isSharedPlatformName(platform.name)) return;
      setSavingShared(true);
      try {
        const res = await fetch(`/api/credentials/shared/${sharedPlatformKey(platform.name)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setErrors({ _form: (data as { error?: string }).error ?? `Save failed (${res.status})` });
          return;
        }
        setRefreshTick(t => t + 1);
        closeEditor();
      } catch (err) {
        setErrors({ _form: `Network error: ${String(err)}` });
      } finally {
        setSavingShared(false);
      }
    } else {
      // Local override → localStorage only
      const next = {
        ...connections,
        [platform.name]: { connected: true, credentials: { ...draft } },
      };
      setConnections(next);
      saveConnections(next);
      closeEditor();
    }
  }

  function handleDisconnect(platformName: string) {
    const next = { ...connections };
    delete next[platformName];
    setConnections(next);
    saveConnections(next);
    closeEditor();
  }

  async function handleDeleteShared(platformName: string) {
    if (!isSharedPlatformName(platformName)) return;
    if (!isAdmin) return;
    if (!confirm(`Remove the shared ${platformName} credential? Operators without their own override will fall back to "unconfigured".`)) return;
    setSavingShared(true);
    try {
      const res = await fetch(`/api/credentials/shared/${sharedPlatformKey(platformName)}`, { method: "DELETE" });
      if (!res.ok) {
        alert(`Delete failed (${res.status})`);
        return;
      }
      setRefreshTick(t => t + 1);
    } finally {
      setSavingShared(false);
    }
  }

  function handleDropOverride(platformName: string) {
    if (!confirm(`Drop your local ${platformName} override and use the shared default instead?`)) return;
    handleDisconnect(platformName);
  }

  function handleReauthorize(platformName: string) {
    const next = { ...connections };
    const conn = next[platformName];
    if (conn?.credentials) {
      delete conn.credentials.refreshToken;
      delete conn.credentials.accessToken;
      delete conn.credentials.tokenExpiresAt;
    }
    setConnections(next);
    saveConnections(next);
    if (platformName === "YouTube" && conn?.credentials?.clientId) {
      window.location.href = `/api/youtube/auth?clientId=${encodeURIComponent(conn.credentials.clientId)}`;
    }
  }

  function handleYouTubeAuth() {
    const yt = connections["YouTube"];
    if (!yt?.credentials?.clientId) {
      alert("Please configure YouTube Client ID and Client Secret first.");
      return;
    }
    window.location.href = `/api/youtube/auth?clientId=${encodeURIComponent(yt.credentials.clientId)}`;
  }

  function platformStatus(name: string): { source: "override" | "shared" | "none"; sharedSetBy?: string; sharedSetAt?: string } {
    const overrideOn = connections[name]?.connected === true;
    const sharedOn = isSharedPlatformName(name) && sharedMeta[sharedPlatformKey(name)]?.configured;
    if (overrideOn) {
      return {
        source: "override",
        sharedSetBy: sharedOn ? sharedMeta[sharedPlatformKey(name as SharedPlatformName)]?.set_by : undefined,
        sharedSetAt: sharedOn ? sharedMeta[sharedPlatformKey(name as SharedPlatformName)]?.set_at : undefined,
      };
    }
    if (sharedOn) {
      const m = sharedMeta[sharedPlatformKey(name as SharedPlatformName)];
      return { source: "shared", sharedSetBy: m?.set_by, sharedSetAt: m?.set_at };
    }
    return { source: "none" };
  }

  const isYouTubeAuthorized = () => !!connections["YouTube"]?.credentials?.refreshToken;

  // Memoize the Kaltura admin-only banner copy
  const adminCanShare = useMemo(() => isAdmin, [isAdmin]);

  if (!open) return null;

  return (
    <div className="connections-panel">
      <h2>Connections</h2>
      <HelpTip>
        Two sources for credentials (ADR-042): your <strong>local override</strong>{" "}
        (browser localStorage) takes precedence over the org&apos;s{" "}
        <strong>shared default</strong> (Google Secret Manager, set by a key admin).
        <br /><br />
        <strong>Kaltura</strong> is shared-only — its admin secret is too privileged
        for per-operator overrides. <strong>YouTube</strong> is per-operator only,
        so brand-account uploads carry the actual operator&apos;s identity (audit
        and copyright trail).
      </HelpTip>

      <div className="connections-grid">
        {PLATFORMS.map((p) => {
          const status = platformStatus(p.name);
          const editingThis = editor?.platform === p.name;
          const sharedSupported = isSharedPlatformName(p.name);
          const sharedOnly = SHARED_ONLY_PLATFORMS.has(p.name);
          const showOverrideEdit = !sharedOnly;

          return (
            <div
              key={p.name}
              className={`connection-card ${status.source !== "none" ? "connected" : ""}`}
            >
              <h3>{p.name}</h3>
              <p>{p.description}</p>
              <span className="connection-badge">{p.credentialType === "OAUTH2" ? "OAuth 2.0" : "API Key"}</span>

              {/* Source line */}
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: 6 }}>
                {/* YouTube is per-operator by design (ADR-042 §"YouTube
                    brand account") — uploads go out under the operator's
                    own identity inside the brand account, so the audit
                    trail at YouTube's layer is accurate. The "not
                    configured" badge would otherwise read as generic. */}
                {p.name === "YouTube" && status.source === "override" && (
                  <span style={{ color: "var(--green)" }}>● Authorised (per-user, via Brand Account)</span>
                )}
                {p.name === "YouTube" && status.source === "none" && (
                  <span>
                    ○ Per-user — not yet authorised. YouTube credentials are deliberately
                    not shared so that uploads carry your identity inside the brand
                    account (accountability + Content ID audit).
                  </span>
                )}
                {p.name !== "YouTube" && status.source === "override" && (
                  <span style={{ color: "var(--green)" }}>● Override active (your browser)</span>
                )}
                {p.name !== "YouTube" && status.source === "shared" && (
                  <span style={{ color: "#a78bfa" }}>
                    ● Shared default
                    {status.sharedSetBy ? ` · set by ${status.sharedSetBy}` : ""}
                    {status.sharedSetAt ? ` on ${status.sharedSetAt.slice(0, 10)}` : ""}
                  </span>
                )}
                {p.name !== "YouTube" && status.source === "none" && (
                  <span>
                    ○ {sharedOnly && !adminCanShare
                      ? "The key admin has chosen not to make this available."
                      : "Not configured"}
                  </span>
                )}
              </div>

              {/* Action row */}
              {!editingThis && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                  {showOverrideEdit && (
                    <button
                      className="btn btn-sm"
                      onClick={() => openEditor(p, "override")}
                    >
                      {status.source === "override" ? "Edit override" : "Override locally"}
                    </button>
                  )}
                  {status.source === "override" && sharedSupported && sharedMeta[sharedPlatformKey(p.name as SharedPlatformName)]?.configured && (
                    <button
                      className="btn btn-sm"
                      onClick={() => handleDropOverride(p.name)}
                      title="Use the shared default instead of your local override"
                    >
                      Drop override → use shared
                    </button>
                  )}
                  {sharedSupported && isAdmin && (
                    <button
                      className="btn btn-sm"
                      onClick={() => openEditor(p, "shared")}
                      title="Set the org-wide default for this platform"
                      style={{ borderColor: "#a78bfa", color: "#a78bfa" }}
                    >
                      {status.source === "shared" || sharedMeta[sharedPlatformKey(p.name as SharedPlatformName)]?.configured
                        ? "Edit shared default…"
                        : "Set as shared default…"}
                    </button>
                  )}
                  {sharedSupported && isAdmin && sharedMeta[sharedPlatformKey(p.name as SharedPlatformName)]?.configured && (
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => handleDeleteShared(p.name)}
                      title="Remove the shared default — operators without overrides will see 'not configured'"
                      disabled={savingShared}
                    >
                      Remove shared
                    </button>
                  )}
                </div>
              )}

              {/* YouTube OAuth flow — unchanged from pre-ADR-042 */}
              {p.name === "YouTube" && status.source === "override" && !editingThis && (
                <div className="yt-auth-row" style={{ marginTop: 6 }}>
                  {isYouTubeAuthorized() ? (
                    <>
                      <span className="yt-authorized">
                        {connections["YouTube"]?.credentials?.authorizedChannelTitle
                          ? `Authorized: ${connections["YouTube"].credentials.authorizedChannelTitle}`
                          : "Authorized"}
                      </span>
                      <button
                        className="btn btn-sm"
                        style={{ marginLeft: 8, fontSize: "0.65rem" }}
                        onClick={() => handleReauthorize("YouTube")}
                      >
                        Re-authorize
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-sm btn-primary" onClick={handleYouTubeAuth}>
                      Authorize YouTube
                    </button>
                  )}
                </div>
              )}

              {/* Editor — rendered when this card is being edited */}
              {editingThis && (
                <div className="credential-form" onClick={(e) => e.stopPropagation()}>
                  {editor.mode === "shared" && (
                    <div style={{
                      background: "rgba(168,85,247,0.08)",
                      border: "1px solid rgba(168,85,247,0.3)",
                      borderRadius: 6,
                      padding: "6px 10px",
                      marginBottom: 8,
                      fontSize: "0.75rem",
                      color: "var(--text)",
                    }}>
                      <strong style={{ color: "#a78bfa" }}>⚠ Editing shared default.</strong>{" "}
                      Saving here writes to Google Secret Manager and affects every operator
                      who doesn&apos;t have a local override. To test changes against your own
                      account first, cancel and choose <em>Override locally</em> instead.
                    </div>
                  )}
                  {editor.mode === "override" && (
                    <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: 6 }}>
                      Local override — saved only in this browser&apos;s localStorage.
                    </div>
                  )}
                  {p.fields.map((f) => (
                    <div key={f.key} className="form-field">
                      <label htmlFor={`${p.name}-${f.key}`}>{f.label}</label>
                      <input
                        id={`${p.name}-${f.key}`}
                        type={f.type}
                        placeholder={f.placeholder}
                        value={draft[f.key] || ""}
                        onChange={(e) => {
                          setDraft((prev) => ({ ...prev, [f.key]: e.target.value }));
                          setErrors((prev) => {
                            const next = { ...prev };
                            delete next[f.key];
                            return next;
                          });
                        }}
                        autoComplete="off"
                      />
                      {errors[f.key] && <span className="field-error">{errors[f.key]}</span>}
                    </div>
                  ))}
                  {errors._form && (
                    <div className="field-error" style={{ marginBottom: 6 }}>{errors._form}</div>
                  )}
                  <div className="form-actions">
                    <button
                      className="btn btn-primary"
                      onClick={() => handleSave(p)}
                      disabled={savingShared}
                    >
                      {editor.mode === "shared"
                        ? (savingShared ? "Saving…" : "Save shared default")
                        : (status.source === "override" ? "Update override" : "Save override")}
                    </button>
                    {editor.mode === "override" && status.source === "override" && (
                      <button className="btn btn-danger" onClick={() => handleDisconnect(p.name)}>
                        Drop override
                      </button>
                    )}
                    <button className="btn btn-sm" onClick={closeEditor}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
