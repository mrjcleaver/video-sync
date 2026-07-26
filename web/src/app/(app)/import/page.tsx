"use client";

/**
 * ADR-057 Option A — Import activity page. Groups: bulk imports
 * (ImportPanel), retrospective backfill (BackfillPanel), and the
 * Overview/Calendar summary of what's already synced
 * (SyncStatusPanel — kept adjacent because "did my import land?"
 * is the natural next question after clicking Import).
 */

import ImportPanel from "../../../components/ImportPanel";
import BackfillPanel from "../../../components/BackfillPanel";
import SyncStatusPanel from "../../../components/SyncStatusPanel";
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
      <SyncStatusPanel videos={visibleVideos} onNavigateToVideo={ensureVideoVisible} />
      <BackfillPanel videos={visibleVideos} onEvent={addEvent} onMutated={refresh} onNavigateToVideo={ensureVideoVisible} />
    </>
  );
}
