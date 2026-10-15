"use client";

import { useMemo } from "react";
import { layoutFor } from "@/app/(dashboard)/dashboard/settings/settingsTiers";
import { useAuthStatusState } from "@/shared/hooks/useAuthStatus";
import { accountView } from "@/shared/utils/account";

/**
 * Settings scope for pages outside Settings (YAN-749), derived exactly like
 * the Settings page. Inactive (switch off, one user): `scope` null and every
 * capability true, so every call keeps going to the legacy endpoints.
 * `canManageInstance` gates instance settings; `canHostOps` gates host-level
 * routes (tunnel status/mutations, MITM) — owner/admin hold both.
 * `canReadConnections` mirrors the server gate on `/api/providers` and
 * `/api/combos` (`workspace.connections.metadata.read`); `canUseConnections`
 * mirrors `/api/workspaces/:id/settings` (`workspace.connections.use`),
 * so members/viewers never fire reads that would 403/404 (YAN-1159).
 * @returns {{ ready: boolean, scope: { workspaceId: string|null }|null, canManageInstance: boolean, canHostOps: boolean, canReadConnections: boolean, canUseConnections: boolean }}
 */
export function useSettingsScope() {
  const { status, loaded } = useAuthStatusState();
  return useMemo(() => {
    const view = accountView(status);
    const { canManageInstance } = layoutFor(view);
    const canHostOps = view.active ? view.can("instance.hostOps") : true;
    const canReadConnections = view.active ? view.can("workspace.connections.metadata.read") : true;
    const canUseConnections = view.active ? view.can("workspace.connections.use") : true;
    const scope = view.active ? { workspaceId: view.activeWorkspace?.id ?? null } : null;
    return {
      ready: loaded,
      scope,
      canManageInstance,
      canHostOps,
      canReadConnections,
      canUseConnections,
    };
  }, [status, loaded]);
}
