"use client";

// YAN-373: draft SSO preview state. The result lives in component memory only;
// it is never written to storage, logs, or the URL.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PREVIEW_FAILED_MESSAGE,
  fetchSsoPreviewResult,
  previewResultMessage,
  previewStartMessage,
  startSsoPreview,
} from "./ssoApi";

export function useSsoPreview() {
  const [provider, setProvider] = useState("oidc");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [result, setResult] = useState(null);
  const [resultError, setResultError] = useState("");
  const [resultLoading, setResultLoading] = useState(false);
  // StrictMode re-runs effects but keeps refs: `consumed` makes the one-shot
  // GET fire once; `alive` stops state writes after a real unmount.
  const consumed = useRef(false);
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    const flag = new URLSearchParams(window.location.search).get("ssoPreview");
    if (!consumed.current && (flag === "1" || flag === "failed")) {
      consumed.current = true;
      window.history.replaceState(null, "", window.location.pathname);
      // Failed round trip: show the error, never call the one-shot GET.
      if (flag === "failed") {
        setResultError(PREVIEW_FAILED_MESSAGE);
        return undefined;
      }
      setResultLoading(true);
      fetchSsoPreviewResult()
        .then((next) => alive.current && setResult(next))
        .catch((err) => alive.current && setResultError(previewResultMessage(err)))
        .finally(() => alive.current && setResultLoading(false));
    }
    return () => {
      alive.current = false;
    };
  }, []);

  const start = useCallback(
    async (policy) => {
      setStarting(true);
      setStartError("");
      try {
        const url = await startSsoPreview(provider, policy);
        window.location.assign(url);
      } catch (err) {
        setStartError(previewStartMessage(err));
        setStarting(false);
      }
    },
    [provider],
  );

  return {
    provider,
    setProvider,
    starting,
    startError,
    start,
    result,
    resultError,
    resultLoading,
  };
}
