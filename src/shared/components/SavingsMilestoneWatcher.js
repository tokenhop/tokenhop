"use client";

import { useEffect, useRef } from "react";
import { useNotificationStore } from "@/store/notificationStore";
import useShellStatus from "@/shared/hooks/useShellStatus";
import { SAVINGS_MILESTONE_COPY } from "@/shared/constants/savingsMilestones.js";

/**
 * Show each savings milestone toast once per install (YAN-408). When the
 * shared shell summary reports a pending milestone, the watcher first claims
 * it on the server (POST /api/shell/savings-milestone, an atomic
 * settings write) and only shows the toast when the claim succeeds — so two
 * tabs racing on the same install never double-fire, and the acknowledgement
 * is per-install (never localStorage). A failed claim leaves the milestone
 * pending so the next poll retries.
 */
export default function SavingsMilestoneWatcher() {
  const { savingsMilestone } = useShellStatus();
  const addNotification = useNotificationStore((state) => state.addNotification);
  const showingRef = useRef(null);

  useEffect(() => {
    if (!savingsMilestone || showingRef.current === savingsMilestone) return;
    const milestone = savingsMilestone;
    const copy = SAVINGS_MILESTONE_COPY[milestone];
    if (!copy) return;
    showingRef.current = milestone;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/shell/savings-milestone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ milestone }),
        });
        if (!res.ok || cancelled) {
          showingRef.current = null; // retry on the next poll
          return;
        }
        const body = await res.json().catch(() => null);
        if (body?.claimedMilestone !== milestone) return; // another tab claimed it
        addNotification({
          type: "success",
          message: copy,
          accent: "lime",
          duration: 8000,
        });
      } catch {
        if (!cancelled) showingRef.current = null; // network error: retry later
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [savingsMilestone, addNotification]);

  return null;
}
