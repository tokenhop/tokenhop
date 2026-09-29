"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "providers:catalog-collapsed";

/**
 * Per-viewer collapse state for catalog groups, persisted in localStorage.
 * All groups default to expanded; stored state applies only after hydration.
 */
export default function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const parsed = saved ? JSON.parse(saved) : null;
      setCollapsed(parsed && typeof parsed === "object" ? parsed : {});
    } catch {
      setCollapsed({});
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsed));
    } catch {}
  }, [collapsed, hydrated]);

  const isCollapsed = useCallback((id) => Boolean(collapsed[id]), [collapsed]);
  const toggle = useCallback((id) => setCollapsed((prev) => ({ ...prev, [id]: !prev[id] })), []);

  return { isCollapsed, toggle };
}
