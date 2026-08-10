"use client";

/**
 * ADR-057 Option A — Config page. Setup and admin surface:
 * platform credentials (Connections), rules for automation
 * (Ingestion / Processing / Post-Processing), and the summary
 * prompt version (ADR-046).
 *
 * ADR-064 adds the description-strategy panel (copy vs generate)
 * and moves the Show Notes prompt editor here from Maintain so
 * both operator-tunable prompts live in the same place.
 */

import ConnectionsPanel from "../../../components/ConnectionsPanel";
import RulesPanel from "../../../components/RulesPanel";
import ProcessingRulesPanel from "../../../components/ProcessingRulesPanel";
import PostProcessingRulesPanel from "../../../components/PostProcessingRulesPanel";
import SeriesRegistryPanel from "../../../components/SeriesRegistryPanel";
import DescriptionConfigPanel from "../../../components/DescriptionConfigPanel";
import SummaryPromptPanel from "../../../components/SummaryPromptPanel";
import McpTokensPanel from "../../../components/McpTokensPanel";
import AccessLogPanel from "../../../components/AccessLogPanel";
import { useApp } from "../AppContext";
import { useEffect, useRef, useState } from "react";

export default function ConfigPage() {
  const [showConnections, setShowConnections] = useState(true);
  const [showPrompt, setShowPrompt] = useState(false);
  const { ruleRunner, videos, addEvent } = useApp();
  const connectionsRef = useRef<HTMLDivElement>(null);

  // Scroll the Connections panel into view when linked to with
  // #connections (e.g. from "YouTube not authorised — configure" hints
  // across the app). Also make sure the panel is expanded.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash === "#connections") {
      setShowConnections(true);
      connectionsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  return (
    <>
      <div className="header">
        <h1>Config</h1>
      </div>
      <div id="connections" ref={connectionsRef}>
        <ConnectionsPanel open={showConnections} onToggle={() => setShowConnections(v => !v)} />
      </div>
      <RulesPanel
        isRunnerRunning={ruleRunner.isRunning}
        lastRun={ruleRunner.lastRun}
        matchCount={ruleRunner.matchCount}
        onRunNow={ruleRunner.runNow}
      />
      <ProcessingRulesPanel />
      <PostProcessingRulesPanel />
      <SeriesRegistryPanel />
      <DescriptionConfigPanel />
      <McpTokensPanel />
      <AccessLogPanel />
      <div className="panel" style={{ marginBottom: 12 }}>
        <div
          className="panel-header"
          onClick={() => setShowPrompt(v => !v)}
          style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
        >
          <div>
            <strong>📄 Show Notes prompt (ADR-046)</strong>
            <span style={{ color: "var(--text-muted)", marginLeft: 8, fontSize: "0.85rem" }}>
              Edit the org-shared chapter-oriented prompt and bulk-regenerate unlocked docs.
            </span>
          </div>
          <span>{showPrompt ? "▾" : "▸"}</span>
        </div>
        {showPrompt && (
          <SummaryPromptPanel
            open
            videos={videos}
            onEvent={addEvent}
            onClose={() => setShowPrompt(false)}
          />
        )}
      </div>
    </>
  );
}
