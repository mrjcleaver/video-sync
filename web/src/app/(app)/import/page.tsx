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
import { useRouter } from "next/navigation";

export default function ImportPage() {
  const { videos, broadcastPairs, showPaired, refresh, refreshWithYouTube, addEvent, ensureVideoVisible } = useApp();
  const router = useRouter();
  const visibleVideos = showPaired
    ? videos
    : videos.filter(v => !broadcastPairs.destinationRecordIds.has(v.id));

  // After a successful import, refresh the catalog and — if the
  // importer bubbled up the new record IDs — bounce the operator to
  // /catalog with those IDs pinned as a filter. Reviewing five
  // freshly-arrived items amongst hundreds was the "hard UX" the
  // operator called out; the ?just= query param gives them a
  // focused view they can dismiss with the banner's Show all link.
  const handleImported = (imported?: { ids: string[] }) => {
    refreshWithYouTube();
    if (imported && imported.ids.length > 0) {
      router.push(`/catalog?just=${imported.ids.join(",")}`);
    }
  };

  return (
    <>
      <div className="header">
        <h1>Import</h1>
      </div>
      <ImportPanel onImported={handleImported} onEvent={addEvent} />
      <BackfillPanel videos={visibleVideos} onEvent={addEvent} onMutated={refresh} onNavigateToVideo={ensureVideoVisible} />
    </>
  );
}
