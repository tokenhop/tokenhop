"use client";

import { useMemo } from "react";
import { useAuthStatusState } from "@/shared/hooks/useAuthStatus";
import { accountView } from "@/shared/utils/account";
import useIncomingGrants from "../useIncomingGrants";
import { filterIncomingGrants } from "../sharing";
import SharedWithYouCard from "./SharedWithYouCard";

/**
 * "Shared with you" section for the providers list (YAN-376). Owns the auth
 * status, the /api/grants fetch and the active-workspace/user filter. Renders
 * nothing while multi-user is inactive, so single-user installs are unchanged
 * and /api/grants (404 while the switch is off) is never called.
 */
export default function WorkspaceSharedConnections() {
  const { status } = useAuthStatusState();
  const view = useMemo(() => accountView(status), [status]);
  const { grants, loading, error } = useIncomingGrants({ active: view.active });
  const activeWorkspaceId = view.active ? view.activeWorkspace?.id : null;
  const userId = status?.principal?.user?.id;
  const incoming = useMemo(
    () => filterIncomingGrants(grants, { activeWorkspaceId, userId }),
    [grants, activeWorkspaceId, userId],
  );
  if (!view.active) return null;
  return <SharedWithYouCard grants={incoming} loading={loading} error={error} />;
}
