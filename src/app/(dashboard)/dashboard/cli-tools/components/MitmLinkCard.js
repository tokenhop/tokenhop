"use client";

import Link from "next/link";
import { Card, StatusPill } from "@/shared/components";
import Image from "next/image";

/**
 * Clickable card for MITM tools — navigates to /dashboard/mitm on click.
 */
export default function MitmLinkCard({ tool }) {
  return (
    <Link href="/dashboard/mitm" className="block" aria-label={`${tool.name} — open MITM setup`}>
      <Card
        padding="sm"
        className="overflow-hidden hover:border-coral/50 transition-colors cursor-pointer"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="size-8 flex items-center justify-center shrink-0">
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
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{tool.name}</span>
                <StatusPill variant="info" size="sm">
                  MITM
                </StatusPill>
              </div>
              <p className="text-xs text-muted truncate">{tool.description}</p>
            </div>
          </div>
          <span className="material-symbols-outlined text-muted text-[20px]">chevron_right</span>
        </div>
      </Card>
    </Link>
  );
}
