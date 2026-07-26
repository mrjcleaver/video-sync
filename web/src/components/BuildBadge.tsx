/**
 * Build-info badge shown in the app shell header.
 * Extracted from the pre-ADR-057 monolithic page.tsx.
 */

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export default function BuildBadge() {
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
  const sha = process.env.NEXT_PUBLIC_BUILD_SHA ?? "local";
  const date = process.env.NEXT_PUBLIC_BUILD_DATE ?? "";
  const ago = date ? timeAgo(date) : "";
  const fullDate = date ? new Date(date).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "";
  return (
    <span title={fullDate} style={{ fontSize: "0.7rem", color: "var(--text-muted)", fontFamily: "monospace", cursor: "default" }}>
      v{version} · {sha}{ago ? ` · ${ago}` : ""}
    </span>
  );
}
