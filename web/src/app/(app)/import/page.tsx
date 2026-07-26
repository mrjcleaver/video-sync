"use client";

/**
 * ADR-057 Option A — Import activity page. Bring content in
 * (ImportPanel) + retrospective backfill orchestrator
 * (BackfillPanel). The Overview/Calendar sync-status view was
 * promoted to its own /overview route.
 */

import ImportPanel from "../../../components/ImportPanel";
import BackfillPanel from "../../../components/BackfillPanel";
import { useApp } from "../AppContext";

export default function ImportPage() {
  const { videos, broadcastPairs, showPaired, refresh, refreshWithYouTube, addEvent, ensureVideoVisible } = useApp();
  const visibleVideos = showPaired
    ? videos
    : videos.filter(v => !broadcastPairs.destinationRecordIds.has(v.id));
  return (
    <>
      <div className="header">
        <h1>Import</h1>
      </div>
      <ImportPanel onImported={refreshWithYouTube} onEvent={addEvent} />
      <BackfillPanel videos={visibleVideos} onEvent={addEvent} onMutated={refresh} onNavigateToVideo={ensureVideoVisible} />
    </>
  );
}
