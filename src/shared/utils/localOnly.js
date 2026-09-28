/**
 * Local-only access (YAN-415). The dashboard guard answers spawn-capable and
 * host-secret routes with 403 { code: "LOCAL_ONLY" } when the browser is not
 * on the host (e.g. behind a reverse proxy). Other 403s, such as the MITM
 * route's missing sudo/admin privilege, carry no such code.
 */
export const LOCAL_ONLY_CODE = "LOCAL_ONLY";

/**
 * True when a response is the guard's local-only refusal. Reads a clone so the
 * caller can still consume the body; an unreadable body is not local-only.
 * @param {Response} response
 * @returns {Promise<boolean>}
 */
export async function isLocalOnlyResponse(response) {
  if (response?.status !== 403) return false;
  try {
    const body = await response.clone().json();
    return body?.code === LOCAL_ONLY_CODE;
  } catch {
    return false;
  }
}
