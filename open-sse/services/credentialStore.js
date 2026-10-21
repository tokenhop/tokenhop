// YAN-1037/1038: injected credential-store hook. open-sse never imports src/;
// the app installs a store at startup (src/instrumentation.js). The slot lives
// on globalThis so duplicate Next bundle copies of this module agree
// (same pattern as setCatalogSource / catalogOverride). With no store installed
// (standalone open-sse, most tests) behaviour is exactly as before.
const SLOT = Symbol.for("tokenhop.credentialStore");

/** Install (or clear with null) the credential store. */
export function setCredentialStore(store) {
  globalThis[SLOT] = store || null;
}

/** The installed store or null. */
export function getCredentialStore() {
  return globalThis[SLOT] || null;
}

/**
 * @typedef {Object} StoredCredentials
 * @property {string} [accessToken]
 * @property {string} [refreshToken]
 * @property {string} [idToken]
 * @property {string} [expiresAt]
 * @property {number} [expiresIn]
 * @property {string} [lastRefreshAt]
 * @property {Object} [providerSpecificData]
 * @property {Object|null} [reauthRequired]
 *
 * @typedef {Object} CredentialStore
 * @property {(connectionId: string) => Promise<StoredCredentials|null>} load
 * @property {(connectionId: string, args: { expectedRefreshToken?: string, credentials: Object }) => Promise<{ applied: boolean }>} persistRefresh
 *   credentials carries ONLY accessToken, refreshToken, idToken, expiresAt, expiresIn,
 *   lastRefreshAt. Never providerSpecificData: the in-request snapshot carries resolved
 *   proxy fields that must not be persisted.
 * @property {(connectionId: string, args: { expectedRefreshToken?: string, expectedAccessToken?: string, reauthRequired: Object }) => Promise<{ applied: boolean }>} markReauthRequired
 */
