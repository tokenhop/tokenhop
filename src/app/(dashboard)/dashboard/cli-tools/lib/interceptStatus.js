/**
 * Intercept-tool status (YAN-392). DNS may be active while the status
 * endpoint fails, so a failed or unreadable response is "unknown", never Off.
 */

/**
 * Map a /api/cli-tools/antigravity-mitm response to per-tool DNS state.
 * @param {{ ok: boolean, status: number, json: () => Promise<object> }} response
 * @param {string[]} toolIds visible tool IDs whose DNS state must be known
 * @returns {Promise<Record<string, boolean>>} tool id → DNS on
 */
export async function readInterceptStatus(response, toolIds = []) {
  if (!response.ok) throw new Error(`MITM status request failed (${response.status}).`);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("MITM status response was unreadable.");
  }
  if (!data || typeof data !== "object") throw new Error("MITM status response was unreadable.");
  // Only an explicit stopped server proves Off. Missing state remains unknown.
  if (data.running === false) return {};
  if (
    data.running !== true ||
    !data.dnsStatus ||
    typeof data.dnsStatus !== "object" ||
    Array.isArray(data.dnsStatus) ||
    Object.keys(data.dnsStatus).length === 0
  ) {
    throw new Error("MITM status response is missing DNS state.");
  }
  if (toolIds.some((toolId) => typeof data.dnsStatus[toolId] !== "boolean")) {
    throw new Error("MITM status response is missing DNS state.");
  }
  return data.dnsStatus;
}
