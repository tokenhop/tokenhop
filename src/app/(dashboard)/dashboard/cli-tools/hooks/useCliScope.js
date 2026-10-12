"use client";

import { useEffect } from "react";
import { useSettingsScope } from "@/shared/hooks/useSettingsScope";
import { useAuthStatusState } from "@/shared/hooks/useAuthStatus";
import { syncCliIdentity } from "@/store/cliAccessStore";

/** Shared CLI gate: auth first, then host access. Login/logout reload the page. */
export function useCliScope() {
  const scope = useSettingsScope();
  const { status } = useAuthStatusState();
  const identity = status?.multiUserActive ? JSON.stringify(status.principal ?? null) : null;
  useEffect(() => {
    if (scope.ready) syncCliIdentity(identity, !scope.canHostOps);
  }, [scope.ready, scope.canHostOps, identity]);
  return { ...scope, identity };
}
