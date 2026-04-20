/**
 * React hook that periodically evaluates ingestion rules against the video store.
 * ADR-013 MVP — runs every 60s in the browser, pauses when tab is hidden.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { videoStore } from "./store";
import { loadRules, runRules, type RuleAction } from "./rules";

const ADMIN_ACTOR = JSON.stringify({
  user_id: "00000000-0000-0000-0000-000000000001",
  role: "Admin",
});

interface UseRuleRunnerOpts {
  intervalMs?: number;
  onEvent?: (ev: string, fields?: { video_id?: string }) => void;
  onMutated?: () => void;
}

interface UseRuleRunnerResult {
  isRunning: boolean;
  lastRun: Date | null;
  matchCount: number;
  runNow: () => void;
}

export function useRuleRunner(opts: UseRuleRunnerOpts = {}): UseRuleRunnerResult {
  const { intervalMs = 60_000, onEvent, onMutated } = opts;
  const [isRunning, setIsRunning] = useState(false);
  const [lastRun, setLastRun] = useState<Date | null>(null);
  const [matchCount, setMatchCount] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const executeRules = useCallback(() => {
    const rules = loadRules();
    if (rules.length === 0) return;

    const videos = videoStore.getAll();
    const result = runRules(rules, videos);

    if (result.actions.length === 0) {
      setLastRun(new Date());
      setMatchCount(0);
      return;
    }

    setIsRunning(true);
    let applied = 0;

    for (const { videoId, action, ruleId } of result.actions) {
      try {
        const record = videoStore.get(videoId);
        if (!record) continue;

        if (action === "mark_in_scope") {
          videoStore.mutate(videoId, (r) =>
            r.mark_in_scope(
              JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR), rule_id: ruleId })
            )
          );
          onEvent?.(`Rule "${ruleId}" scoped: video ${videoId}`, { video_id: videoId });
        } else if (action === "auto_approve") {
          videoStore.mutate(videoId, (r) =>
            r.approve(JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR) }))
          );
          onEvent?.(`Rule "${ruleId}" auto-approved: video ${videoId}`, { video_id: videoId });
        } else if (action === "auto_skip") {
          videoStore.mutate(videoId, (r) =>
            r.skip(
              JSON.stringify({
                actor: JSON.parse(ADMIN_ACTOR),
                reason: `Auto-skipped by rule ${ruleId}`,
              })
            )
          );
          onEvent?.(`Rule "${ruleId}" auto-skipped: video ${videoId}`, { video_id: videoId });
        }
        applied++;
      } catch (err) {
        console.warn(`Rule action failed for video ${videoId}:`, err);
      }
    }

    if (applied > 0) onMutated?.();
    setMatchCount(applied);
    setLastRun(new Date());
    setIsRunning(false);
  }, [onEvent, onMutated]);

  // Set up interval, pause when hidden
  useEffect(() => {
    function start() {
      if (timerRef.current) return;
      timerRef.current = setInterval(executeRules, intervalMs);
    }

    function stop() {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }

    function onVisibility() {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    }

    start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [executeRules, intervalMs]);

  return { isRunning, lastRun, matchCount, runNow: executeRules };
}
