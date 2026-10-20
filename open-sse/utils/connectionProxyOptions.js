/**
 * Build proxyAwareFetch options from the connection-resolved
 * providerSpecificData stamped by getProviderCredentials. Carries the pool's
 * strictProxy so upstream calls and token refreshes never fall back to a
 * direct connection when strict mode is on (YAN-651, YAN-1036).
 *
 * @param {object|null|undefined} credentials
 * @returns {{
 *   connectionProxyEnabled: boolean,
 *   connectionProxyUrl: string,
 *   connectionNoProxy: string,
 *   vercelRelayUrl: string,
 *   strictProxy: boolean,
 *   connectionProxyPoolId: string|null,
 * }}
 */
export function proxyOptionsFromCredentials(credentials) {
  const psd = credentials?.providerSpecificData || {};
  return {
    connectionProxyEnabled: psd.connectionProxyEnabled === true,
    connectionProxyUrl: psd.connectionProxyUrl || "",
    connectionNoProxy: psd.connectionNoProxy || "",
    vercelRelayUrl: psd.vercelRelayUrl || "",
    strictProxy: psd.strictProxy === true,
    connectionProxyPoolId: psd.connectionProxyPoolId || null,
  };
}
