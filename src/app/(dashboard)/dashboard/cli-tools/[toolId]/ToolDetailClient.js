"use client";

import Link from "next/link";
import { CardSkeleton } from "@/shared/components";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { useToolSetupData } from "../hooks/useToolSetupData";
import { deriveToolStatus } from "../lib/toolStatus";
import { useCliAccessStore } from "@/store/cliAccessStore";
import ToolSetupPanel from "../components/ToolSetupPanel";
import LocalOnlyNotice from "../components/LocalOnlyNotice";

/**
 * Narrow-screen + deep-link route: back link, tool title and the same
 * shared setup panel used inline on the list page.
 */
export default function ToolDetailClient({ toolId }) {
  const tool = CLI_TOOLS[toolId];
  const data = useToolSetupData();
  const localOnly = useCliAccessStore((s) => s.localOnly);

  if (!tool) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:px-0">
        <Link
          href="/dashboard/cli-tools"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted hover:text-text"
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
            arrow_back
          </span>
          Back to CLI tools
        </Link>
        <p className="text-sm text-muted">Tool not found or disabled.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:px-0">
      <Link
        href="/dashboard/cli-tools"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted hover:text-text"
      >
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
          arrow_back
        </span>
        Back to CLI tools
      </Link>
      {localOnly && <LocalOnlyNotice manualBelow />}
      {data.loading ? (
        <CardSkeleton />
      ) : (
        <ToolSetupPanel toolId={toolId} data={data} onStatusUpdate={() => {}} />
      )}
    </div>
  );
}

// Re-export kept for unit tests importing the derivation from this module.
export { deriveToolStatus };
