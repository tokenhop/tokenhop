"use client";

import { useDeferredValue, useMemo } from "react";
import { buildProviderSections } from "./providerSections";

/**
 * Memoised providers-list derivation. The search query is deferred so typing
 * stays responsive; `isStale` marks the render where the input is ahead of
 * the deferred query.
 */
export default function useProviderSections({ connections, providerNodes, query, filter }) {
  const deferredQuery = useDeferredValue(query);
  const sections = useMemo(
    () => buildProviderSections({ connections, providerNodes, query: deferredQuery, filter }),
    [connections, providerNodes, deferredQuery, filter],
  );
  return { ...sections, isStale: query !== deferredQuery };
}
