"use client";

import { useEffect, useState } from "react";
import SectionCard from "@/shared/components/SectionCard";
import CopyField from "@/shared/components/CopyField";
import Callout from "@/shared/components/Callout";
import { Skeleton } from "@/shared/components/Loading";

/**
 * Environment section: read-only allowlisted non-secret env readout from
 * GET /api/settings/environment. Secrets never leave the server: the
 * allowlist excludes them and the denylist wins on misconfiguration.
 */
export default function EnvironmentSection() {
  const [values, setValues] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings/environment", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setValues(data.values || {});
      } catch {
        if (!cancelled) setError("Could not load environment values");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const entries = values ? Object.entries(values) : [];

  return (
    <div id="environment" className="scroll-mt-24 space-y-4">
      <SectionCard
        icon="terminal"
        title="Environment"
        subtitle="Read from .env at startup. Edit the file and restart."
      />
      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card space-y-4">
        <Callout variant="info" title=".env · restart">
          Values come from the server environment. Change them in .env and restart 9router.
        </Callout>
        {error ? (
          <p className="text-sm text-err" role="alert">
            {error}
          </p>
        ) : !values ? (
          <Skeleton />
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted">No environment values set.</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            {entries.map(([key, value]) => (
              <div
                key={key}
                className="contents sm:[&>dd]:border-t-0 sm:[&>dt]:border-t-0 [&>*]:border-t [&>*]:border-line [&>*]:py-2"
              >
                <dt className="font-mono text-[13px] text-text">{key}</dt>
                <dd className="min-w-0">
                  <CopyField value={String(value)} label={`Copy ${key}`} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}
