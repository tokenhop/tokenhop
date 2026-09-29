"use client";

import { useEffect, useRef, useState } from "react";
import { useNotificationStore } from "@/store/notificationStore";
import useShellStatus from "@/shared/hooks/useShellStatus";
import { SAVINGS_MILESTONE_COPY } from "@/shared/constants/savingsMilestones.js";

/** Retry cadence for a failed claim: the shell summary poll interval. */
const CLAIM_RETRY_MS = 60_000;

/**
 * Claim a milestone on the server (YAN-408). Resolves true when this call is
 * what acknowledged the milestone (this client shows the toast), false when
 * another client already claimed it, and rejects on a failed request so the
 * caller can retry.
 * @param {number} milestone
 * @param {(input: RequestInfo, init?: RequestInit) => Promise<Response>} [fetchImpl]
 * @returns {Promise<boolean>}
 */
export async function claimSavingsMilestoneOnServer(milestone, fetchImpl = fetch) {
  const res = await fetchImpl("/api/shell/savings-milestone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ milestone }),
  });
  if (!res.ok) throw new Error(`savings milestone claim failed: ${res.status}`);
  const body = await res.json().catch(() => null);
  return body?.claimedMilestone === milestone;
}

/**
 * Show each savings milestone toast once per install (YAN-408). When the
 * shared shell summary reports a pending milestone, the watcher claims it on
 * the server (an atomic settings write) and shows the success toast only when
 * the claim succeeds — so two tabs racing never double-fire, and the
 * acknowledgement is per-install (never localStorage). A failed claim retries
 * on a timer until it succeeds (the poll keeps reporting the same number, so
 * a dep change alone would never re-run). A successful claim always shows the
 * toast: the claim is durable server-side, so an unmount (StrictMode remount)
 * must not drop it.
 */
export default function SavingsMilestoneWatcher() {
  const { savingsMilestone } = useShellStatus();
  const addNotification = useNotificationStore((state) => state.addNotification);
  const showingRef = useRef(null);
  // Bumped by the retry timer so a failed claim re-attempts.
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is an intentional re-run trigger (retry timer), mirroring refreshKey in useSavingsWithFallback.
  useEffect(() => {
    if (!savingsMilestone || showingRef.current === savingsMilestone) return undefined;
    const milestone = savingsMilestone;
    const copy = SAVINGS_MILESTONE_COPY[milestone];
    if (!copy) return undefined;
    showingRef.current = milestone;
    let retryTimer = null;
    (async () => {
      try {
        if (await claimSavingsMilestoneOnServer(milestone)) {
          addNotification({ type: "success", message: copy, accent: "lime", duration: 8000 });
        }
      } catch {
        // Claim failed: release the in-flight guard so the retry (or a poll
        // delivering a new milestone) can run again.
        showingRef.current = null;
        retryTimer = setTimeout(() => setAttempt((n) => n + 1), CLAIM_RETRY_MS);
      }
    })();
    return () => clearTimeout(retryTimer);
  }, [savingsMilestone, addNotification, attempt]);

  return null;
}
