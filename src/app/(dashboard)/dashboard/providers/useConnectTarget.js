"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuthStatusState } from "@/shared/hooks/useAuthStatus";
import { accountView } from "@/shared/utils/account";
import { defaultTarget, manageableWorkspaces, withWorkspace } from "./connectTarget";

/** Selected manageable workspace for new provider connections; legacy stays unscoped. */
export default function useConnectTarget() {
  const { status, loaded } = useAuthStatusState();
  const view = useMemo(() => accountView(status), [status]);
  const initial = defaultTarget(view);
  const [selected, setWorkspaceId] = useState(null);
  useEffect(() => setWorkspaceId(initial), [initial]);
  const workspaces = manageableWorkspaces(view);
  const workspaceId = workspaces.some((w) => w.id === selected) ? selected : initial;
  return {
    ready: loaded,
    workspaceId,
    workspaces,
    setWorkspaceId,
    url: (path) => withWorkspace(path, workspaceId),
  };
}
