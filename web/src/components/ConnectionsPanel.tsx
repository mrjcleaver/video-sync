"use client";

import { useState, useEffect } from "react";

const STORAGE_KEY = "video-sync:connections";

interface PlatformInfo {
  name: string;
  description: string;
}

const PLATFORMS: PlatformInfo[] = [
  { name: "Zoom", description: "Cloud meeting recordings" },
  { name: "Loom", description: "Async video messaging" },
  { name: "Fireflies", description: "AI meeting notes" },
  { name: "YouTube", description: "Video publishing" },
  { name: "Kaltura", description: "Enterprise video" },
];

function loadConnections(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

export default function ConnectionsPanel() {
  const [show, setShow] = useState(false);
  const [connections, setConnections] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setConnections(loadConnections());
  }, []);

  function toggle(name: string) {
    const next = { ...connections, [name]: !connections[name] };
    setConnections(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  return (
    <div className="connections-panel">
      <h2>
        Connections
        <button className="btn btn-sm" onClick={() => setShow(!show)}>
          {show ? "Hide" : "Configure"}
        </button>
      </h2>
      {show && (
        <div className="connections-grid">
          {PLATFORMS.map((p) => (
            <div
              key={p.name}
              className={`connection-card ${connections[p.name] ? "connected" : ""}`}
              onClick={() => toggle(p.name)}
            >
              <h3>{p.name}</h3>
              <p>{p.description}</p>
              <span className="connection-status">
                {connections[p.name] ? "Connected" : "Not connected"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
