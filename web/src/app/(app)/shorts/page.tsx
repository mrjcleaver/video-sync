"use client";

/**
 * ADR-057 Option A — Shorts page. ShortsPanel (Opus Clip
 * integration, ADR-029 + ADR-055 title alignment consumers).
 */

import ShortsPanel from "../../../components/ShortsPanel";
import { useApp } from "../AppContext";

export default function ShortsPage() {
  const { videos, addEvent, refresh } = useApp();
  return (
    <>
      <div className="header">
        <h1>Shorts</h1>
      </div>
      <ShortsPanel videos={videos} onEvent={addEvent} onMutated={refresh} />
    </>
  );
}
