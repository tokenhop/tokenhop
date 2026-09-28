/**
 * Pure status and playground request helpers for Media Providers (YAN-305).
 * No React/DOM dependencies so they are fully testable in Node.
 */

/**
 * Maps connection test status to effective status considering cooldown locks.
 *
 * @param {object} conn Connection object
 * @param {number} [now=Date.now()] Current timestamp in ms
 * @returns {string} Effective status
 */
export function getEffectiveConnectionStatus(conn, now = Date.now()) {
  if (!conn || typeof conn !== "object") return "none";
  const isCooldown = Object.entries(conn).some(
    ([k, v]) => k.startsWith("modelLock_") && v && new Date(v).getTime() > now,
  );
  return conn.testStatus === "unavailable" && !isCooldown ? "active" : conn.testStatus;
}

/**
 * Single-toggle contract for the provider card switch (YAN-305 merge-gate #1):
 * one semantic handler receives the next checked value exactly once per
 * user activation — no wrapper onClick plus inner onChange double-PUT.
 *
 * The card delegates to this pure reducer: given the current disabled state
 * and an activation event, it returns the single onToggle call to make
 * (or null when the event must be ignored).
 *
 * @param {object} params
 * @param {string} params.providerId
 * @param {boolean} params.allDisabled Current all-disabled state
 * @param {boolean} params.nextChecked The switch's next checked value
 * @param {boolean} [params.alreadyHandled] True when the wrapper already consumed the event
 * @returns {{ providerId: string, newActive: boolean } | null}
 */
export function resolveToggleAction({
  providerId,
  allDisabled,
  nextChecked,
  alreadyHandled = false,
}) {
  if (alreadyHandled) return null;
  if (typeof nextChecked !== "boolean") return null;
  // Toggle contract: onChange fires with the NEXT checked value, so the
  // desired active state equals nextChecked directly.
  void allDisabled;
  return { providerId, newActive: nextChecked };
}

/**
 * Computes status pill info for a provider card in media providers view.
 * Status rules:
 * 1. isNoAuth: { label: "Ready · no key", variant: "live" }
 * 2. total > 0 && allDisabled: { label: "Disabled", variant: "neutral" }
 * 3. total === 0: { label: "Not connected", variant: "neutral" }
 * 4. error > 0 && connected === 0: { label: "Auth error", variant: "err" }
 * 5. connected > 0: { label: `${connected} connected`, variant: "ok" }
 * 6. other with total > 0: { label: `${total} added`, variant: "neutral" }
 *
 * @param {object} params
 * @param {boolean} [params.isNoAuth=false]
 * @param {Array<object>} [params.connections=[]]
 * @param {number} [params.now=Date.now()]
 * @returns {{ label: string, variant: "ok" | "warn" | "err" | "info" | "brand" | "live" | "neutral" }}
 */
export function getMediaProviderStatus({
  isNoAuth = false,
  connections = [],
  now = Date.now(),
} = {}) {
  if (isNoAuth) {
    return { label: "Ready · no key", variant: "live" };
  }

  const conns = Array.isArray(connections) ? connections : [];
  const total = conns.length;

  if (total === 0) {
    return { label: "Not connected", variant: "neutral" };
  }

  const allDisabled = conns.every((c) => c && c.isActive === false);
  if (allDisabled) {
    return { label: "Disabled", variant: "neutral" };
  }

  const connected = conns.filter((c) => {
    if (!c || c.isActive === false) return false;
    const s = getEffectiveConnectionStatus(c, now);
    return s === "active" || s === "success";
  }).length;

  const error = conns.filter((c) => {
    if (!c || c.isActive === false) return false;
    const s = getEffectiveConnectionStatus(c, now);
    return s === "error" || s === "expired" || s === "unavailable";
  }).length;

  if (connected > 0) {
    return { label: `${connected} connected`, variant: "ok" };
  }

  if (error > 0) {
    return { label: "Auth error", variant: "err" };
  }

  return { label: `${total} added`, variant: "neutral" };
}

/**
 * Builds cURL preview string for media playground requests.
 * Security: the preview never embeds a live key — `apiKey` is accepted for
 * signature compatibility but always rendered as the YOUR_KEY placeholder.
 * The live key is only sent in the fetch Authorization header at run time.
 *
 * @param {object} params
 * @param {string} params.method HTTP method (POST, etc.)
 * @param {string} params.url Full endpoint URL
 * @param {string} [params.pinnedConnectionId] Optional x-connection-id header
 * @param {object} [params.body] Request payload (JSON kinds)
 * @param {boolean} [params.isBinary] Whether to append --output flag
 * @param {string} [params.binaryFilename="output.bin"]
 * @param {object} [params.form] Multipart fields for STT ({ fileName, model, language, temperature, responseFormat, prompt })
 * @returns {string} Formatted cURL command
 */
export function buildPlaygroundCurl({
  method = "POST",
  url = "",
  pinnedConnectionId = "",
  body = {},
  isBinary = false,
  binaryFilename = "output.bin",
  form = null,
} = {}) {
  const parts = [`curl -X ${method} ${url} \\`];
  // STT runs send multipart form data, so the preview must show -F flags,
  // never a JSON Content-Type header or -d payload.
  if (form) {
    const authLine = `  -H "Authorization: Bearer YOUR_KEY"${pinnedConnectionId ? " \\" : ""}`;
    parts.push(authLine);
    if (pinnedConnectionId) {
      parts.push(`  -H "x-connection-id: ${pinnedConnectionId}"`);
    }
    const fields = [
      ["file", `@${form.fileName || "audio.mp3"}`],
      ["model", form.model || ""],
      ["language", form.language || ""],
      ["temperature", form.temperature || ""],
      ["response_format", form.responseFormat || ""],
      ["prompt", form.prompt || ""],
    ].filter(([, value]) => value !== "");
    fields.forEach(([key, value], index) => {
      const tail = index === fields.length - 1 ? "" : " \\";
      parts[parts.length - 1] = `${parts[parts.length - 1]} \\`;
      parts.push(`  -F "${key}=${value}"${tail}`);
    });
    return parts.join("\n");
  }
  parts.push('  -H "Content-Type: application/json" \\');
  parts.push(`  -H "Authorization: Bearer YOUR_KEY"${pinnedConnectionId ? " \\" : ""}`);
  if (pinnedConnectionId) {
    parts.push(`  -H "x-connection-id: ${pinnedConnectionId}"`);
  }
  const bodyJson = JSON.stringify(body);
  if (isBinary) {
    parts[parts.length - 1] = `${parts[parts.length - 1]} \\`;
    parts.push(`  -d '${bodyJson}' \\`);
    parts.push(`  --output ${binaryFilename}`);
  } else {
    parts[parts.length - 1] = `${parts[parts.length - 1]} \\`;
    parts.push(`  -d '${bodyJson}'`);
  }
  return parts.join("\n");
}
