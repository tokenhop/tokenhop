/**
 * Pure MITM request helpers (YAN-392). A failed MITM request must never look
 * like success, so every non-OK response, and every OK response whose body
 * cannot be read, becomes a thrown Error.
 */

/**
 * Decode a MITM response. Throws on non-OK status with the server error text
 * (else the fallback), and throws when an OK body is not valid JSON so a
 * garbled success is never treated as confirmed state.
 * @param {Response} response
 * @param {string} fallback
 * @returns {Promise<object>}
 */
export async function readMitmResponse(response, fallback) {
  let body;
  try {
    body = await response.json();
  } catch {
    if (response.ok) throw new Error(`${fallback}: unreadable server response`);
    throw new Error(fallback);
  }
  if (!response.ok) throw new Error(body?.error || fallback);
  return body ?? {};
}

/**
 * Mapping state to restore after a failed save: the last server snapshot,
 * including an empty map (never the unsaved edit).
 * @param {object|null|undefined} saved
 * @returns {object}
 */
export function restoredMappings(saved) {
  return saved ? { ...saved } : {};
}

/**
 * Serialize whole-map saves so the latest edit always wins: saves run one at
 * a time, and only the newest request may update visible state.
 * @param {(mappings: object) => Promise<object>} send resolves the saved map
 * @returns {(mappings: object) => Promise<{ latest: boolean, saved?: object, error?: Error }>}
 */
export function createLatestSaveQueue(send) {
  let tail = Promise.resolve();
  let generation = 0;
  return (mappings) => {
    const mine = ++generation;
    const run = tail.then(async () => {
      try {
        const saved = await send(mappings);
        return { latest: mine === generation, saved };
      } catch (error) {
        return { latest: mine === generation, error };
      }
    });
    tail = run.then(() => undefined);
    return run;
  };
}

/**
 * User-facing failure copy for a MITM tool action.
 * @param {"load"|"save"|"enable"|"disable"} action
 * @param {string} toolName
 * @param {string} [detail] server/network error text
 * @returns {string}
 */
export function mitmFailureMessage(action, toolName, detail) {
  const what =
    action === "load"
      ? `load model mappings for ${toolName}`
      : action === "save"
        ? `save model mappings for ${toolName}`
        : `${action === "enable" ? "start" : "stop"} DNS for ${toolName}`;
  const suffix = action === "save" ? " The last saved mappings were restored." : "";
  return `Couldn't ${what}${detail ? `: ${detail}` : ""}.${suffix}`;
}
