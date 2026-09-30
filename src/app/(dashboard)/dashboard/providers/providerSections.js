import { PROVIDER_SECTIONS } from "./sections";
import {
  LIST_FILTERS,
  buildProviderListFilterCounts,
  getProviderStats,
  matchesProviderListFilter,
  needsAttention,
} from "./utils";

const ATTENTION_LIMIT = 6;

/** A provider the viewer has set up: any stored account, enabled or not. */
export function isYourProvider(entry) {
  return !entry.isNoAuth && (entry.stats?.total || 0) > 0;
}

function byAttentionThenName(a, b) {
  const aLook = needsAttention(a.stats, a.isNoAuth) ? 0 : 1;
  const bLook = needsAttention(b.stats, b.isNoAuth) ? 0 : 1;
  if (aLook !== bLook) return aLook - bLook;
  return (a.info.name || a.id).localeCompare(b.info.name || b.id);
}

/**
 * Pure derivation for the Providers list: splits the catalog into the
 * viewer's providers (pinned) and the remaining catalog groups, applying the
 * search query and filter to both.
 *
 * @param {{ connections: object[], providerNodes: object[], query?: string, filter?: string }} input
 */
export function buildProviderSections({
  connections,
  providerNodes,
  query = "",
  filter = LIST_FILTERS.ALL,
}) {
  const sections = PROVIDER_SECTIONS({
    connections,
    providerNodes,
    statsFor: (providerId, authType) => getProviderStats(connections, providerId, authType),
  });
  const allEntries = sections.flatMap((s) => s.entries);
  const needle = query.trim().toLowerCase();
  const matches = (entry) =>
    (!needle || (entry.info.name || "").toLowerCase().includes(needle)) &&
    matchesProviderListFilter(filter, entry.stats, entry.isNoAuth, entry.authGroup);

  const yourProviders = allEntries.filter(isYourProvider).sort(byAttentionThenName);
  const catalogSections = sections
    .map((section) => {
      const entries = section.entries.filter((e) => !isYourProvider(e));
      return {
        ...section,
        catalogCount: entries.length,
        entries: entries.filter(matches),
      };
    })
    .filter((section) => section.entries.length > 0 || section.id === "custom");

  const filterCounts = buildProviderListFilterCounts(allEntries);
  return {
    allEntries,
    yourProviders: yourProviders.filter(matches),
    yourProvidersTotal: yourProviders.length,
    catalogSections,
    filterCounts,
    needsAttention: allEntries
      .filter((e) => needsAttention(e.stats, e.isNoAuth))
      .slice(0, ATTENTION_LIMIT),
    totals: {
      available: sections.reduce((sum, s) => sum + s.totalCount, 0),
      connected: filterCounts[LIST_FILTERS.CONNECTED],
      attention: filterCounts[LIST_FILTERS.NEEDS_ATTENTION],
      noAuthReady: allEntries.filter((e) => e.isNoAuth).length,
    },
  };
}
