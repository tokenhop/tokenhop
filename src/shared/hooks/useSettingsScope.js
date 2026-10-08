"use client";

import { useMemo } from "react";
import { layoutFor } from "@/app/(dashboard)/dashboard/settings/settingsTiers";
import { useAuthStatusState } from "@/shared/hooks/useAuthStatus";
import { accountView } from "@/shared/utils/account";

/**
 * Settings scope for pages outside Settings (YAN-749), derived exactly like
 * the Settings page. Inactive (switch off, one user): `scope` null and
 * `canManageInstance` true, so every call keeps going to /api/settings.
 * @returns {{ ready: boolean, scope: { workspaceId: string|null }|null, canManageInstance: boolean }}
 */
export function useSettingsScope() {
  const { status, loaded } = useAuthStatusState();
  return useMemo(() => {
    const view = accountView(status);
    const { canManageInstance } = layoutFor(view);
    const scope = view.active ? { workspaceId: view.activeWorkspace?.id ?? null } : null;
    return { ready: loaded, scope, canManageInstance };
  }, [status, loaded]);
}
