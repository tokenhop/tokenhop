"use client";

import { useEffect, useState } from "react";

/**
 * Client-only endpoint shell hooks: remote-host hint and local base URL.
 * Both are SSR-safe (stable default first render, hydrate from window).
 */

/**
 * Client-side local/remote host hint (UI copy only, never a security gate).
 * @returns {boolean} true when the dashboard is not served from localhost.
 */
export function useRemoteHost() {
  const [isRemoteHost, setIsRemoteHost] = useState(false);
  useEffect(() => {
    if (typeof window !== "undefined") {
      setIsRemoteHost(!["localhost", "127.0.0.1", "::1"].includes(window.location.hostname));
    }
  }, []);
  return isRemoteHost;
}

/**
 * Local `/v1` base URL. SSR-safe: defaults to "/v1" and hydrates from window.
 * @returns {string}
 */
export function useLocalBaseUrl() {
  const [baseUrl, setBaseUrl] = useState("/v1");
  useEffect(() => {
    if (typeof window !== "undefined") {
      setBaseUrl(`${window.location.origin}/v1`);
    }
  }, []);
  return baseUrl;
}
