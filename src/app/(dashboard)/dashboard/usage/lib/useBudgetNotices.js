"use client";

import { useCallback, useEffect, useState } from "react";
import { useNotificationStore } from "@/store/notificationStore";
import { claimNoticeToast, noticeToast } from "./budgetNoticeToasts";
import { appendUsageFilters } from "./filterParams";

/**
 * Budget notices on every Usage tab (YAN-1830). `onNotice` handles a
 * `budgetNotice` SSE event: one toast per notice id (deduped across
 * reconnects and tabs) and a `noticeKey` bump so the Budgets tab refetches
 * its notice pills. The Overview stream (useUsageStats) calls `onNotice` on
 * its own EventSource; with `listen` set (another tab is active) this hook
 * opens a notice-only stream instead, closed while the page is hidden. The
 * two are never open together. Live only: notices sent while no stream was
 * open still show as Budgets-tab pills.
 * @param {object|null} filters usage scope (workspaceId, view, …)
 * @param {{ listen: boolean }} options open the notice-only stream
 * @returns {{ onNotice: (e: MessageEvent) => void, noticeKey: number }}
 */
export default function useBudgetNotices(filters, { listen }) {
  const addNotification = useNotificationStore((s) => s.addNotification);
  const [noticeKey, setNoticeKey] = useState(0);
  const [hidden, setHidden] = useState(false);
  const scopeKey = appendUsageFilters("", filters);

  const onNotice = useCallback(
    (e) => {
      try {
        const notice = JSON.parse(e.data);
        if (claimNoticeToast(notice)) addNotification(noticeToast(notice));
        setNoticeKey((k) => k + 1);
      } catch (err) {
        console.error("[SSE CLIENT] budget notice parse error:", err);
      }
    },
    [addNotification],
  );

  useEffect(() => {
    setHidden(document.hidden);
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: filters are keyed by scopeKey.
  useEffect(() => {
    if (!listen || hidden) return undefined;
    const es = new EventSource(appendUsageFilters("/api/usage/stream", filters));
    es.addEventListener("budgetNotice", onNotice);
    return () => es.close();
  }, [listen, hidden, scopeKey, onNotice]);

  return { onNotice, noticeKey };
}
