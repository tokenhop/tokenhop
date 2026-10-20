import { updateProviderCredentials } from "@/sse/services/tokenRefresh";

// Generic model-list resolver for OAuth providers that need refresh-on-401 + token persist.
// `fetchFn(token, connection)` returns a Response; `parseFn(data)` returns the model list.
// Resolves to { models } on success, { models: [], warning } on an upstream failure, or
// { error, status } when the connection has no token.
export const buildOAuthResolver =
  ({ refreshFn, fetchFn, parseFn, errorLabel }) =>
  async (connection) => {
    const { accessToken, refreshToken } = connection;
    if (!accessToken) {
      return { error: "No valid token found", status: 401 };
    }
    let warning;
    try {
      let response = await fetchFn(accessToken, connection);
      if (!response.ok && (response.status === 401 || response.status === 403) && refreshToken) {
        const refreshed = await refreshFn(connection);
        if (refreshed?.accessToken) {
          await updateProviderCredentials(connection.id, {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken || refreshToken,
            expiresIn: refreshed.expiresIn,
            // Only refreshers that stamp it (codex) set this; others are unchanged.
            ...(refreshed.lastRefreshAt ? { lastRefreshAt: refreshed.lastRefreshAt } : {}),
          });
          connection.accessToken = refreshed.accessToken;
          if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
          response = await fetchFn(refreshed.accessToken, connection);
        }
      }
      if (response.ok) {
        const data = await response.json();
        const models = parseFn(data);
        if (models.length > 0) return { models };
      } else {
        const errorText = await response.text();
        warning = `${errorLabel}: ${response.status} ${errorText}`;
        console.log(`${errorLabel} (falling back to static):`, errorText);
      }
    } catch (error) {
      warning = `${errorLabel}: ${error.message}`;
      console.log(`${errorLabel} (falling back to static):`, error.message);
    }
    return { models: [], warning };
  };
