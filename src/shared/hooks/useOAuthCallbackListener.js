"use client";

import { useEffect } from "react";
import { isTrustedCallbackOrigin } from "@/shared/components/oauth/authFlowHelpers";

/** Listen for a popup callback once via postMessage, BroadcastChannel, or localStorage. */
export default function useOAuthCallbackListener({
  authData,
  callbackProcessedRef,
  exchangeTokens,
  setError,
  setStep,
}) {
  useEffect(() => {
    if (!authData) return;
    callbackProcessedRef.current = false;

    const handleCallback = async (data) => {
      if (callbackProcessedRef.current) return;
      const { code, token, state, error: callbackError, errorDescription } = data;
      if (callbackError) {
        callbackProcessedRef.current = true;
        setError(errorDescription || callbackError);
        setStep("error");
        return;
      }
      if (token || code) {
        callbackProcessedRef.current = true;
        await exchangeTokens(token || code, state);
      }
    };

    const handleMessage = (event) => {
      if (!isTrustedCallbackOrigin(event.origin, window.location.origin)) return;
      if (event.data?.type === "oauth_callback") handleCallback(event.data.data);
    };
    window.addEventListener("message", handleMessage);

    let channel;
    try {
      channel = new BroadcastChannel("oauth_callback");
      channel.onmessage = (event) => handleCallback(event.data);
    } catch {
      console.log("BroadcastChannel not supported");
    }

    const handleStorage = (event) => {
      if (event.key === "oauth_callback" && event.newValue) {
        try {
          handleCallback(JSON.parse(event.newValue));
          localStorage.removeItem("oauth_callback");
        } catch {
          console.log("Failed to parse localStorage data");
        }
      }
    };
    window.addEventListener("storage", handleStorage);

    try {
      const stored = localStorage.getItem("oauth_callback");
      if (stored) {
        const data = JSON.parse(stored);
        if (data.timestamp && Date.now() - data.timestamp < 30000) handleCallback(data);
        localStorage.removeItem("oauth_callback");
      }
    } catch {
      // localStorage may be unavailable or data may be malformed.
    }

    return () => {
      window.removeEventListener("message", handleMessage);
      window.removeEventListener("storage", handleStorage);
      if (channel) channel.close();
    };
  }, [authData, exchangeTokens, callbackProcessedRef, setError, setStep]);
}
