/**
 * Map a resolveConnectionProxyConfig() result onto proxyAwareFetch options.
 * Callers must fail closed on `source === "error"` before using this.
 */
export function proxyOptionsFromConfig(proxy) {
  return {
    connectionProxyEnabled: proxy?.connectionProxyEnabled === true,
    connectionProxyUrl: proxy?.connectionProxyUrl || "",
    connectionNoProxy: proxy?.connectionNoProxy || "",
    vercelRelayUrl: proxy?.vercelRelayUrl || "",
    strictProxy: proxy?.strictProxy === true,
    connectionProxyPoolId: proxy?.proxyPoolId || null,
  };
}
