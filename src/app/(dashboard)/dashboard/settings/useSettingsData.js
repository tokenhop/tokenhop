"use client";

import { useCallback, useEffect, useState } from "react";

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Settings values for the page (YAN-371, D12). Inactive (`scope` null): the
 * legacy GET /api/settings, unchanged. Active: instance values (admins only),
 * then the workspace's effective values, then the user's preferences.
 * Waits for `ready` so a non-admin never fires a 403-bound instance GET.
 * @param {{ ready: boolean, scope: { workspaceId?: string }|null, canManageInstance: boolean }} opts
 */
export function useSettingsData({ ready, scope, canManageInstance }) {
  const [settings, setSettings] = useState({ requireLogin: true });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const workspaceId = scope?.workspaceId ?? null;
  const scoped = Boolean(scope);

  const loadSettings = useCallback(async () => {
    if (!ready) return;
    setLoading(true);
    setError("");
    try {
      if (!scoped) {
        setSettings(await getJson("/api/settings"));
        return;
      }
      const [instance, workspace, prefs] = await Promise.all([
        canManageInstance ? getJson("/api/settings") : {},
        workspaceId
          ? getJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/settings`)
          : { effective: {} },
        getJson("/api/me/preferences"),
      ]);
      setSettings({ ...instance, ...(workspace.effective ?? {}), ...(prefs.data ?? {}) });
    } catch {
      setError("Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, [ready, scoped, workspaceId, canManageInstance]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  return { settings, setSettings, loading: loading || !ready, error, loadSettings };
}
