/**
 * Small fetch helpers for the SSO forms. Both throw with the server's error
 * message so forms can show it inline.
 */

/**
 * PATCH /api/settings with a multi-key payload.
 * @param {object} payload
 * @returns {Promise<object>} Safe settings echoed by the server.
 */
export async function saveSettings(payload) {
  return requestJson("/api/settings", "PATCH", payload);
}

/**
 * POST JSON and require `{ ok: true }` in the response.
 * @param {string} url
 * @param {object} body
 * @returns {Promise<object>}
 */
export async function postJson(url, body) {
  const data = await requestJson(url, "POST", body);
  if (!data?.ok) throw new Error(data?.error || "Request failed");
  return data;
}

async function requestJson(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/**
 * Parse IdP SAML metadata XML. Picks the first SSO location (preferring the
 * HTTP-Redirect binding) and the first signing certificate.
 * @param {string} xmlText
 * @returns {{ entityId: string, ssoUrl: string, cert: string } | null} null when unparseable.
 */
export function parseIdpMetadata(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  if (doc.querySelector("parsererror")) return null;
  let ssoUrl = "";
  for (const node of doc.querySelectorAll("SingleSignOnService, *|SingleSignOnService")) {
    const location = node.getAttribute("Location") || "";
    if (!location) continue;
    ssoUrl = location;
    if ((node.getAttribute("Binding") || "").includes("HTTP-Redirect")) break;
  }
  const certNode = doc.querySelector("X509Certificate, *|X509Certificate");
  return {
    entityId: doc.documentElement.getAttribute("entityID") || "",
    ssoUrl,
    cert: certNode?.textContent.trim() || "",
  };
}
