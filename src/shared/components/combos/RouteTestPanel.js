"use client";

import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { useReducedMotion } from "@/shared/hooks";
import Button from "@/shared/components/Button";
import ProviderTile from "@/shared/components/ProviderTile";
import StatusPill from "@/shared/components/StatusPill";
import {
  formatProbeLatency,
  probeLastRunLabel,
  probeTrackEvents,
  PROBE_STEP_MS,
} from "./routeTestFormat";

/**
 * Test-this-route panel: runs a dry-run probe through the real combo pipeline
 * and replays the attempts step by step (~250ms each): attempted (sky),
 * failed/skipped (warn + reason), answered (lime). Matching route-track steps
 * light up through `onTrackStatesChange`; under prefers-reduced-motion every
 * step shows its final state instantly. An sr-only aria-live region narrates
 * the timeline for screen readers.
 *
 * @param {object} props
 * @param {string} props.comboId - Combo id for POST /api/combos/[id]/test.
 * @param {string[]} props.models - Combo member models (the route track).
 * @param {(states: Array<{state: string, reason: string}|null>)} [props.onTrackStatesChange]
 *   Called whenever the per-step replay states change (also with [] when cleared).
 */
export default function RouteTestPanel({ comboId, models, onTrackStatesChange }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [ranAt, setRanAt] = useState(null);
  const [progress, setProgress] = useState(0); // steps fully resolved so far
  const reducedMotion = useReducedMotion();

  const routeModels = Array.isArray(models) ? models : [];
  const events = useMemo(
    () => probeTrackEvents(routeModels, result?.attempts),
    [routeModels, result],
  );
  const total = events.length;

  // Disable while running to prevent duplicate POSTs (rate limit would turn
  // the second into a confusing 429). Client-side timeout (~65s) just past
  // the server 60s timeout surfaces the real 504 instead of hanging.
  const runTest = async () => {
    if (running || !comboId) return;
    setRunning(true);
    setError("");
    setResult(null);
    setProgress(0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 65_000);
    try {
      const res = await fetch(`/api/combos/${comboId}/test`, {
        method: "POST",
        signal: controller.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 429) {
        throw new Error(json.error || "Probe rate limited — wait a few seconds and retry.");
      }
      if (!res.ok) {
        throw new Error(json.error || `Probe failed (${res.status})`);
      }
      setResult(json);
      setRanAt(json.ranAt || new Date().toISOString());
      setProgress(reducedMotion ? (json.attempts || []).length : 0);
    } catch (err) {
      setError(
        err?.name === "AbortError"
          ? "Probe timed out — try again."
          : err?.message || "Probe failed",
      );
    } finally {
      clearTimeout(timer);
      setRunning(false);
    }
  };

  // Replay clock: resolve one step per PROBE_STEP_MS; the step at `progress`
  // is the one being attempted (sky). Reduced motion (or a fresh replay
  // without results) skips straight to the final states.
  useEffect(() => {
    if (!result || reducedMotion || progress >= total) return undefined;
    const timer = setTimeout(() => setProgress((p) => Math.min(total, p + 1)), PROBE_STEP_MS);
    return () => clearTimeout(timer);
  }, [result, reducedMotion, progress, total]);

  // Route-track states: step at `progress` is attempting, earlier ones hold
  // their final state. Cleared whenever the result, the route or the combo
  // changes so stale highlights never outlive an edit.
  useEffect(() => {
    if (!onTrackStatesChange) return;
    if (!result) {
      onTrackStatesChange([]);
      return;
    }
    const states = routeModels.map(() => null);
    events.forEach((event, i) => {
      if (event.index === null || i > progress) return;
      states[event.index] = { state: event.state, reason: event.reason };
    });
    if (progress < total && events[progress] && events[progress].index !== null) {
      states[events[progress].index] = { state: "attempted", reason: "" };
    }
    onTrackStatesChange(states);
  }, [events, progress, result, routeModels, total, onTrackStatesChange]);

  const lastRun = probeLastRunLabel(ranAt);
  const visible = events.slice(0, reducedMotion ? total : progress + 1);

  return (
    <section
      aria-label="Test this route"
      className="mt-auto flex flex-col gap-3 rounded-2xl border border-line bg-bg p-[18px]"
    >
      <div className="flex items-center gap-2.5">
        <h3 className="font-display m-0 text-lg font-bold">Test this route</h3>
        {lastRun && <span className="text-xs text-muted">{lastRun}</span>}
        <Button
          size="sm"
          variant="secondary"
          icon="play_arrow"
          onClick={runTest}
          loading={running}
          disabled={!comboId}
          className="ms-auto"
        >
          Run test
        </Button>
        {total > 0 && !running && !reducedMotion && (
          <Button
            size="sm"
            variant="ghost"
            icon="restart_alt"
            onClick={() => setProgress(0)}
            aria-label="Replay the last run on the route track"
          >
            Replay
          </Button>
        )}
      </div>
      <p className="m-0 text-xs text-muted">
        Uses a tiny amount of quota. Runs the real route, so it also advances rotation.
      </p>

      {error && (
        <p role="alert" className="m-0 text-sm text-err">
          {error}
        </p>
      )}

      {!error && !result && !running && (
        <p className="m-0 text-[13px] text-muted">
          Send a tiny probe through this route to watch the fallback happen.
        </p>
      )}
      {running && !result && (
        <p role="status" className="m-0 text-[13px] text-muted">
          Probing route…
        </p>
      )}

      {visible.length > 0 && (
        <ul aria-label="Probe steps" className="m-0 flex list-none flex-col gap-1 p-0">
          {visible.map((step, index) => {
            const attempting = !reducedMotion && index === progress && index < total;
            const ok = step.status != null && step.status >= 200 && step.status < 300;
            const isServed = step.outcome === "served";
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: probe replay has no step ids from the API; model+position is the stable key.
              <li key={`${step.model}-${index}`} className="flex items-center gap-3 text-[13px]">
                {attempting ? (
                  <StatusPill variant="info" size="sm" className="min-w-10 justify-center">
                    <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                      progress_activity
                    </span>
                    <span className="sr-only">Trying…</span>
                  </StatusPill>
                ) : (
                  <StatusPill
                    variant={ok ? "ok" : "err"}
                    size="sm"
                    className="min-w-10 justify-center"
                  >
                    <span className="font-mono">{step.status ?? "—"}</span>
                  </StatusPill>
                )}
                <ProviderTile providerId={step.model} size="sm" />
                <span className="min-w-0 truncate font-mono">{step.model}</span>
                <span className="truncate text-muted">
                  {attempting ? "Trying…" : step.reason} · {formatProbeLatency(step.latencyMs)}
                  {step.account ? ` · ${step.account}` : ""}
                  {step.role === "panel" ? " · panel" : ""}
                  {step.role === "judge" ? " · judge" : ""}
                  {step.role === "nested" && step.via ? ` · via ${step.via}` : ""}
                </span>
                {!attempting && (
                  <span
                    className={`ms-auto shrink-0 font-semibold ${
                      step.state === "answered" ? "text-lime-ink" : "text-muted"
                    }`}
                  >
                    {isServed ? "Served" : step.state === "answered" ? "Answered" : "Skipped"}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Screen-reader timeline: narrates each step as it resolves. */}
      <p aria-live="polite" className="sr-only m-0">
        {events
          .slice(0, reducedMotion ? total : progress)
          .map((step) => step.text)
          .join(" ")}
      </p>

      {result?.summary && progress >= total && (
        <p className="m-0 border-t border-line pt-2.5 text-[13px]">
          <strong>{result.summary}</strong>
        </p>
      )}
    </section>
  );
}

RouteTestPanel.propTypes = {
  comboId: PropTypes.string,
  models: PropTypes.arrayOf(PropTypes.string),
  onTrackStatesChange: PropTypes.func,
};
