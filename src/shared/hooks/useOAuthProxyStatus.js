"use client";

import { useEffect } from "react";
import { resolveProxyPollProvider } from "@/shared/components/oauth/authFlowHelpers";

const POLL_INTERVAL_MS = 1500;
const MAX_ATTEMPTS = 200; // ~5 minutes

/** Poll poll-status until the server-side proxy exchanges the code, errors, or times out. */
export default function useOAuthProxyStatus({
  isOpen,
  authData,
  callbackProcessedRef,
  onSuccessRef,
  setError,
  setStep,
}) {
  useEffect(() => {
    if (!isOpen) return;
    const pollProvider = resolveProxyPollProvider(authData);
    if (!pollProvider) return;
    if (callbackProcessedRef.current) return;
    let cancelled = false;
    let attempts = 0;

    const tick = async () => {
      if (cancelled || callbackProcessedRef.current) return;
      attempts += 1;
      try {
        const res = await fetch(
          `/api/oauth/${pollProvider}/poll-status?state=${encodeURIComponent(authData.state)}`,
        );
        const data = await res.json();
        if (cancelled || callbackProcessedRef.current) return;
        if (data.status === "done") {
          callbackProcessedRef.current = true;
          setStep("success");
          onSuccessRef.current?.();
          return;
        }
        if (data.status === "error") {
          callbackProcessedRef.current = true;
          setError(data.error || "Authentication failed");
          setStep("error");
          return;
        }
      } catch {
        // Network error, keep polling
      }
      if (attempts >= MAX_ATTEMPTS) {
        callbackProcessedRef.current = true;
        setError("Authentication timeout");
        setStep("error");
        return;
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
    };
  }, [isOpen, authData, callbackProcessedRef, onSuccessRef, setError, setStep]);
}
