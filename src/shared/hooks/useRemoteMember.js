"use client";

import useAuthStatus from "@/shared/hooks/useAuthStatus";
import { useRemoteHost } from "@/shared/hooks/useEndpointShell";
import { accountView } from "@/shared/utils/account";

export const REMOTE_IMPORT_NOTICE =
  "Host files are not available from this device. Paste a token or API key, or use the browser or device-code sign-in.";

/** True when multi-user is active and the dashboard is opened from another machine (UI hint only). */
export default function useRemoteMember() {
  const remote = useRemoteHost();
  const active = accountView(useAuthStatus()).active;
  return Boolean(remote && active);
}
