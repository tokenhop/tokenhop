/**
 * Split media providers into owned and catalog sections without changing their
 * source order. Any stored connection counts as owned, including disabled or
 * auth-error connections, so providers needing attention stay easy to find.
 * No-auth providers without stored connections remain in the catalog.
 *
 * @param {Array<{id: string}>} providers Catalog and custom embedding providers.
 * @param {Array<{provider: string}>} connections Stored provider connections.
 * @returns {{ connected: Array<{id: string}>, others: Array<{id: string}> }}
 */
export function partitionMediaProviders(providers, connections) {
  const owned = new Set((connections || []).map((connection) => connection.provider));
  const connected = [];
  const others = [];
  for (const provider of providers || []) {
    (owned.has(provider.id) ? connected : others).push(provider);
  }
  return { connected, others };
}
