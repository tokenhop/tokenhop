"use client";

import useAuthStatus from "@/shared/hooks/useAuthStatus";
import { accountView } from "@/shared/utils/account";

/** True when Users & teams is active for this session (switch off: always false). */
export function useMultiUserActive() {
  return accountView(useAuthStatus()).active;
}
