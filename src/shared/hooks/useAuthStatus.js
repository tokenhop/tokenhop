"use client";

import { useEffect, useState } from "react";

// One GET /api/auth/status per page load, shared by every shell consumer
// (header SSO pill, sidebar user row). Login state only changes through a
// full navigation (login/logout both reload), so the cached promise is safe.
let pending = null;

function loadAuthStatus() {
  if (!pending) {
    pending = fetch("/api/auth/status", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`auth status ${res.status}`);
        return res.json();
      })
      .then((data) => data || {})
      .catch(() => {
        pending = null;
        return {};
      });
  }
  return pending;
}

/**
 * Auth status plus whether the request has settled (loaded or failed).
 * @returns {{ status: object, loaded: boolean }}
 */
export function useAuthStatusState() {
  const [state, setState] = useState({ status: {}, loaded: false });

  useEffect(() => {
    let cancelled = false;
    loadAuthStatus().then((data) => {
      if (!cancelled) setState({ status: data, loaded: true });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

/**
 * Shared auth status payload from GET /api/auth/status (`{}` until loaded or on failure).
 * @returns {object}
 */
export default function useAuthStatus() {
  return useAuthStatusState().status;
}
