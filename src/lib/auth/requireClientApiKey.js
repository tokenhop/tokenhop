import { resolveGatewayAuth } from "./gatewayAuth.js";

/** @returns {Promise<Response|null>} Denial response, or null when allowed. */
export async function requireClientApiKey(request) {
  const auth = await resolveGatewayAuth(request);
  return auth instanceof Response ? auth : null;
}
