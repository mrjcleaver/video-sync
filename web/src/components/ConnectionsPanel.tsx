"use client";

import { useState, useEffect } from "react";
import HelpTip from "./HelpTip";

const STORAGE_KEY = "video-sync:connections";

type CredentialType = "OAUTH2" | "API_KEY";

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
    name: "Loom",
    description: "Async video messaging",
    credentialType: "API_KEY",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "Your Loom API key", required: true },
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
      { key: "apiKey", label: "Admin Secret", type: "password", placeholder: "Your Kaltura Admin Secret", required: true },
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
];

interface ConnectionState {
  connected: boolean;
  credentials: Record<string, string>;
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

export default function ConnectionsPanel() {
  const [show, setShow] = useState(false);
  const [connections, setConnections] = useState<Record<string, ConnectionState>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setConnections(loadConnections());
  }, []);

  function openEditor(platform: PlatformInfo) {
    const existing = connections[platform.name]?.credentials || {};
    setDraft({ ...existing });
    setErrors({});
    setEditing(platform.name);
  }

  function closeEditor() {
    setEditing(null);
    setDraft({});
    setErrors({});
  }

  function handleSave(platform: PlatformInfo) {
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

    const next = {
      ...connections,
      [platform.name]: { connected: true, credentials: { ...draft } },
    };
    setConnections(next);
    saveConnections(next);
    closeEditor();
  }

  function handleDisconnect(platformName: string) {
    const next = { ...connections };
    delete next[platformName];
    setConnections(next);
    saveConnections(next);
    closeEditor();
  }

  function handleReauthorize(platformName: string) {
    // Clear only the refreshToken so user can re-do OAuth without losing clientId/clientSecret
    const next = { ...connections };
    const conn = next[platformName];
    if (conn?.credentials) {
      delete conn.credentials.refreshToken;
      delete conn.credentials.accessToken;
      delete conn.credentials.tokenExpiresAt;
    }
    setConnections(next);
    saveConnections(next);
    // Trigger OAuth flow
    if (platformName === "YouTube" && conn?.credentials?.clientId) {
      window.location.href = `/api/youtube/auth?clientId=${encodeURIComponent(conn.credentials.clientId)}`;
    }
  }

  const isConnected = (name: string) => connections[name]?.connected === true;
  const isYouTubeAuthorized = () => !!connections["YouTube"]?.credentials?.refreshToken;

  function handleYouTubeAuth() {
    const yt = connections["YouTube"];
    if (!yt?.credentials?.clientId) {
      alert("Please configure YouTube Client ID and Client Secret first.");
      return;
    }
    window.location.href = `/api/youtube/auth?clientId=${encodeURIComponent(yt.credentials.clientId)}`;
  }

  return (
    <div className="connections-panel">
      <h2>
        Connections
        <button className="btn btn-sm" onClick={() => setShow(!show)}>
          {show ? "Hide" : "Configure"}
        </button>
      </h2>
      <HelpTip>
        Store API credentials for external services. Credentials are saved only in your
        browser&apos;s localStorage — nothing is sent to any server until you use a feature that
        requires them. <strong>Zoom</strong> and <strong>YouTube</strong> use OAuth 2.0
        (Account ID + Client ID + Secret). <strong>Fireflies</strong>, <strong>Loom</strong>,
        and <strong>Kaltura</strong> use API keys. <strong>OpenRouter</strong> powers LLM
        transcript summarisation in Processing Rules.
      </HelpTip>

      {show && (
        <div className="connections-grid">
          {PLATFORMS.map((p) => (
            <div
              key={p.name}
              className={`connection-card ${isConnected(p.name) ? "connected" : ""}`}
              onClick={() => editing !== p.name && openEditor(p)}
            >
              <h3>{p.name}</h3>
              <p>{p.description}</p>
              <span className="connection-badge">{p.credentialType === "OAUTH2" ? "OAuth 2.0" : "API Key"}</span>
              <span className="connection-status">
                {isConnected(p.name) ? "Connected" : "Not connected"}
              </span>

              {p.name === "YouTube" && isConnected("YouTube") && editing !== "YouTube" && (
                <div className="yt-auth-row">
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
                        onClick={(e) => { e.stopPropagation(); handleReauthorize("YouTube"); }}
                      >
                        Re-authorize
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-sm btn-primary" onClick={(e) => { e.stopPropagation(); handleYouTubeAuth(); }}>
                      Authorize YouTube
                    </button>
                  )}
                </div>
              )}

              {editing === p.name && (
                <div className="credential-form" onClick={(e) => e.stopPropagation()}>
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
                  <div className="form-actions">
                    <button className="btn btn-primary" onClick={() => handleSave(p)}>
                      {isConnected(p.name) ? "Update" : "Connect"}
                    </button>
                    {isConnected(p.name) && (
                      <button className="btn btn-danger" onClick={() => handleDisconnect(p.name)}>
                        Disconnect
                      </button>
                    )}
                    <button className="btn btn-sm" onClick={closeEditor}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
