"use client";

import PropTypes from "prop-types";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CardSkeleton, EmptyState } from "@/shared/components";
import Button from "@/shared/components/Button";
import StatusPill from "@/shared/components/StatusPill";
import ToolTile from "./ToolTile";
import { readInterceptStatus } from "../lib/interceptStatus";
import { markLocalOnly } from "@/store/cliAccessStore";
import { isLocalOnlyResponse } from "@/shared/utils/localOnly";

// Client-side ceiling; the route success path already sets real data.
const INTERCEPT_TIMEOUT_MS = 8000;

/** MITM status cards; an idle server is a resolved "Off" state, not loading. */
export default function InterceptTools({ tools }) {
  // Retry remounts the section: a fresh mount is the one refetch trigger.
  const [attempt, setAttempt] = useState(0);
  return (
    <InterceptToolsSection key={attempt} tools={tools} onRetry={() => setAttempt((n) => n + 1)} />
  );
}

function InterceptToolsSection({ tools, onRetry }) {
  const [dnsStatus, setDnsStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let unmounted = false;
    let timedOut = false;
    // The MITM status endpoint can wait on OS checks. Abort after 8s and
    // surface Retry instead of leaving skeletons forever.
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, INTERCEPT_TIMEOUT_MS);
    (async () => {
      try {
        const res = await fetch("/api/cli-tools/antigravity-mitm", {
          signal: controller.signal,
        });
        if (await isLocalOnlyResponse(res)) return markLocalOnly();
        const status = await readInterceptStatus(
          res,
          tools.map(([toolId]) => toolId),
        );
        if (!unmounted) setDnsStatus(status);
      } catch (err) {
        if (!unmounted) {
          setError(timedOut ? "MITM status took too long to respond." : err.message);
        }
      } finally {
        clearTimeout(timer);
        if (!unmounted) setLoading(false);
      }
    })();
    return () => {
      unmounted = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [tools]);

  if (!tools?.length) return null;

  return (
    <section aria-labelledby="intercept-tools-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2
          id="intercept-tools-heading"
          className="font-display text-xl font-bold tracking-[-0.02em] text-text"
        >
          Intercept tools
        </h2>
        <p className="text-[13px] text-muted">
          For IDEs that can’t change their endpoint, 9router listens in (MITM) and reroutes.
        </p>
      </div>
      {loading ? (
        <div
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          role="status"
          aria-label="Loading intercept tools"
        >
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : error ? (
        <div role="alert" className="rounded-2xl border border-err bg-err-bg">
          <EmptyState
            icon="error"
            title="Intercept status unavailable"
            body={error}
            as="h3"
            action={
              <Button variant="secondary" onClick={onRetry}>
                Retry
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {tools.map(([toolId, tool]) => {
            const on = dnsStatus[toolId] === true;
            return (
              <Link
                key={toolId}
                href="/dashboard/mitm"
                aria-label={`${tool.name} — MITM ${on ? "on" : "off"}. Open MITM setup.`}
                className="flex min-h-11 items-center gap-3 rounded-2xl border border-line bg-panel p-4 shadow-card transition-colors duration-150 hover:border-subtle focus-visible:outline-none focus-visible:shadow-focus motion-reduce:transition-none"
              >
                <ToolTile tool={tool} size="md" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[15px] font-semibold text-text">{tool.name}</span>
                  <span className="truncate text-[13px] text-muted">{tool.description}</span>
                </span>
                <StatusPill variant={on ? "ok" : "neutral"} size="sm" dot={on}>
                  {on ? "On" : "Off"}
                </StatusPill>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

InterceptToolsSection.propTypes = {
  tools: PropTypes.array,
  onRetry: PropTypes.func.isRequired,
};

InterceptTools.propTypes = {
  tools: PropTypes.arrayOf(
    PropTypes.arrayOf(PropTypes.oneOfType([PropTypes.string, PropTypes.object])).isRequired,
  ),
};
