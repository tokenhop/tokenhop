"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Button from "@/shared/components/Button";
import ProviderTile from "@/shared/components/ProviderTile";
import StatusPill from "@/shared/components/StatusPill";
import { formatProbeLatency, probeLastRunLabel } from "./routeTestFormat";

/**
 * Test-this-route panel: runs a dry-run probe through the real combo pipeline
 * and shows the per-step timeline (status pill in mono, model, reason +
 * latency, skipped/served), the served step, total time and a summary line.
 * @param {object} props
 * @param {string} props.comboId - Combo id for POST /api/combos/[id]/test.
 */
export default function RouteTestPanel({ comboId }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [ranAt, setRanAt] = useState(null);

  // Disable while running to prevent duplicate POSTs (rate limit would turn
  // the second into a confusing 429). Client-side timeout (~65s) just past
  // the server 60s timeout surfaces the real 504 instead of hanging.
  const runTest = async () => {
    if (running || !comboId) return;
    setRunning(true);
    setError("");
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

  const attempts = result?.attempts || [];
  const lastRun = probeLastRunLabel(ranAt);

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
          variant="primary"
          icon="play_arrow"
          onClick={runTest}
          loading={running}
          disabled={!comboId}
          className="ms-auto"
        >
          Run test
        </Button>
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

      {attempts.length > 0 && (
        <ul aria-label="Probe steps" className="m-0 flex list-none flex-col p-0">
          {attempts.map((step, index) => {
            const ok = step.status != null && step.status >= 200 && step.status < 300;
            const isServed = step.outcome === "served";
            const reason =
              step.outcome === "served" || step.outcome === "answered"
                ? "answered"
                : (step.errorType ?? `error ${step.status ?? "unknown"}`);
            return (
              <li key={`${step.model}-${index}`} className="flex items-center gap-3 text-[13px]">
                <StatusPill
                  variant={ok ? "ok" : "err"}
                  size="sm"
                  className="min-w-10 justify-center"
                >
                  <span className="font-mono">{step.status ?? "—"}</span>
                </StatusPill>
                <ProviderTile providerId={step.model} size="sm" />
                <span className="min-w-0 truncate font-mono">{step.model}</span>
                <span className="truncate text-muted">
                  {reason} · {formatProbeLatency(step.latencyMs)}
                  {step.account ? ` · ${step.account}` : ""}
                  {step.role === "panel" ? " · panel" : ""}
                  {step.role === "judge" ? " · judge" : ""}
                  {step.role === "nested" && step.via ? ` · via ${step.via}` : ""}
                </span>
                <span
                  className={`ms-auto shrink-0 font-semibold ${isServed ? "text-ok" : "text-muted"}`}
                >
                  {isServed ? "Served" : step.outcome === "answered" ? "OK" : "skipped"}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {result?.summary && (
        <p className="m-0 border-t border-line pt-2.5 text-[13px]">
          <strong>{result.summary}</strong>
        </p>
      )}
    </section>
  );
}

RouteTestPanel.propTypes = {
  comboId: PropTypes.string,
};
