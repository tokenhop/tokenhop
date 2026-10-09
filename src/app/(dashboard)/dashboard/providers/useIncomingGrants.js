"use client";

import { useEffect, useState } from "react";

/**
 * Incoming connection grants (YAN-376). /api/grants has no query params — the
 * response lists every grant whose grantee is any workspace the caller
 * belongs to or the caller's own user id; the active-workspace/user filter is
 * client-side (filterIncomingGrants). Never called while the multi-user
 * switch is off (the route 404s there).
 *
 * @param {{active: boolean}} props `active` is accountView(useAuthStatus()).active
 * @returns {{grants: Array|null, loading: boolean, error: string}}
 */
export default function useIncomingGrants({ active }) {
  const [grants, setGrants] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    fetch("/api/grants", { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Failed to load shared connections");
        if (!cancelled) {
          setGrants(Array.isArray(data.grants) ? data.grants : []);
          setError("");
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || "Failed to load shared connections");
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  return { grants, loading: active && grants === null && !error, error };
}
