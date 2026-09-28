"use client";

import { useEffect, useState } from "react";
import { FREE_PROVIDERS, AI_PROVIDERS } from "@/shared/constants/providers";

function isLLMProvider(id) {
  const p = AI_PROVIDERS[id];
  if (!p?.serviceKinds) return true;
  return p.serviceKinds.includes("llm");
}

/**
 * Connected-provider list for the topology. Copied from the retired
 * `UsageStats.js` provider fetch: dedupe by provider type, drop inactive and
 * non-LLM providers, always include noAuth free providers.
 *
 * @returns {Array<object>} providers with `{provider, name, nodeName?}`
 */
export default function useProviders() {
  const [providers, setProviders] = useState([]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/providers").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/provider-nodes").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([d, nodesData]) => {
        if (cancelled) return;
        const nodeNameMap = {};
        for (const node of nodesData?.nodes || []) nodeNameMap[node.id] = node.name;
        const seen = new Set();
        const unique = (d?.connections || [])
          .filter((c) => {
            if (c.isActive === false) return false;
            if (!isLLMProvider(c.provider)) return false;
            if (seen.has(c.provider)) return false;
            seen.add(c.provider);
            return true;
          })
          .map((c) => ({ ...c, nodeName: nodeNameMap[c.provider] || null }));
        const noAuthProviders = Object.values(FREE_PROVIDERS)
          .filter((p) => p.noAuth && !seen.has(p.id) && isLLMProvider(p.id))
          .map((p) => ({ provider: p.id, name: p.name }));
        setProviders([...unique, ...noAuthProviders]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return providers;
}
