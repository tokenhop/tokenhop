"use client";

import Link from "next/link";
import Image from "next/image";
import { Card, StatusPill } from "@/shared/components";

// Derive simple connected/configured/not-installed status from API payload
function getStatus(status, tool) {
  if (tool?.configType === "guide") return { label: "Guide", variant: "info" };
  if (!status) return { label: "Unknown", variant: "neutral" };
  if (!status.installed) return { label: "Not installed", variant: "neutral" };
  if (status.hasTokenhop) return { label: "Connected", variant: "ok" };
  return { label: "Not configured", variant: "warn" };
}

export default function ToolSummaryCard({ toolId, tool, status }) {
  const s = getStatus(status, tool);
  return (
    <Link
      href={`/dashboard/cli-tools/${toolId}`}
      className="block"
      aria-label={`${tool.name} — ${s.label}`}
    >
      <Card
        padding="sm"
        className="h-full overflow-hidden hover:border-coral/50 transition-colors cursor-pointer"
      >
        <div className="flex h-full flex-col gap-2">
          <div className="flex items-center gap-3">
            <div className="size-8 flex items-center justify-center shrink-0">
              {tool.image ? (
                <Image
                  src={tool.image}
                  alt=""
                  width={32}
                  height={32}
                  className="size-8 object-contain rounded-lg"
                  sizes="32px"
                  onError={(e) => {
                    e.target.style.display = "none";
                  }}
                  loading="lazy"
                  decoding="async"
                />
              ) : tool.icon ? (
                <span
                  className="material-symbols-outlined text-[28px]"
                  style={{ color: tool.color }}
                >
                  {tool.icon}
                </span>
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              <span className="font-medium text-sm truncate">{tool.name}</span>
              <div className="mt-1">
                <StatusPill variant={s.variant} size="sm">
                  {s.label}
                </StatusPill>
              </div>
            </div>
            <span className="material-symbols-outlined text-muted text-[18px] shrink-0">
              chevron_right
            </span>
          </div>
        </div>
      </Card>
    </Link>
  );
}
