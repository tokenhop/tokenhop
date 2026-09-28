"use client";

import StatusPill from "@/shared/components/StatusPill";
import Badge from "@/shared/components/Badge";
import ModelChip from "@/shared/components/ModelChip";

/** Kit section: status pills, badges and model chips. */
export default function KitPills() {
  return (
    <section
      aria-labelledby="kit-pills"
      className="rounded-2xl border border-line bg-panel p-6 shadow-card"
    >
      <h2 id="kit-pills" className="font-display text-xl font-bold">
        Pills, badges, chips
      </h2>
      <div className="mt-4 flex flex-wrap gap-2">
        <StatusPill variant="ok" dot>
          Connected
        </StatusPill>
        <StatusPill variant="warn">Cooldown 2m</StatusPill>
        <StatusPill variant="err">Auth error</StatusPill>
        <StatusPill variant="info">OAuth</StatusPill>
        <StatusPill variant="live">Free tier</StatusPill>
        <StatusPill variant="brand">API key</StatusPill>
        <StatusPill variant="neutral">Off</StatusPill>
        <StatusPill variant="ok" size="sm" dot>
          Compact
        </StatusPill>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Badge variant="success" dot size="sm">
          Ready
        </Badge>
        <Badge variant="error" size="sm">
          Failed
        </Badge>
        <Badge variant="primary" icon="key" size="sm">
          API Key
        </Badge>
        <Badge variant="default" size="sm">
          Total: 42
        </Badge>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <ModelChip model="cc/claude-sonnet-4-6" />
        <ModelChip model="cx/gpt-5.1-codex" />
        <ModelChip model="openrouter/qwen3-coder" />
      </div>
    </section>
  );
}
