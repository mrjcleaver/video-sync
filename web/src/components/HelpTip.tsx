"use client";

import { useState, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

export default function HelpTip({ children }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: open ? 10 : 2 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={() => setOpen((v) => !v)}
          title={open ? "Hide help" : "Show help"}
          aria-label="Help"
          style={{
            background: open ? "var(--info-soft)" : "none",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: "1px 8px",
            fontSize: "0.68rem",
            color: open ? "var(--info)" : "var(--text-muted)",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            lineHeight: 1.6,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: "0.75rem" }}>?</span> help
        </button>
      </div>
      {open && (
        <div
          style={{
            marginTop: 6,
            padding: "10px 14px",
            background: "var(--info-soft)",
            border: "1px solid var(--info-border)",
            borderRadius: 8,
            fontSize: "0.8rem",
            color: "var(--text-muted)",
            lineHeight: 1.65,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
