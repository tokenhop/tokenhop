/**
 * Proxy pool helpers shared by the Proxy pools dashboard page.
 *
 * - `maskProxyUrl` strips credentials from proxy URLs before display. It never
 *   throws and never logs the input.
 * - `parseProxyLine` parses one batch-import line (`url` or
 *   `host:port:user:pass`).
 * - `selectionReducer` manages the pool-list selection bar state.
 */

export const PROXY_URL_SCHEMES = ["http:", "https:", "socks5:", "socks4:", "socks5h:", "socks4a:"];

/**
 * Mask credentials in a proxy URL for display.
 * `http://user:pass@host:8080` -> `http://host:8080`.
 * Unparseable input is returned unchanged (never throws, never logs).
 *
 * @param {string} url Raw proxy URL, possibly with credentials.
 * @returns {string} URL with userinfo removed, or `""` for empty input.
 */
export function maskProxyUrl(url) {
  if (!url) return "";
  const trimmed = String(url).trim();
  if (!trimmed) return "";
  // ponytail: userinfo split only handles rfc3986 userinfo; full WHATWG parse is the upgrade path.
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex === -1) return trimmed;
  const schemeEnd = trimmed.indexOf("://");
  const authStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const auth = trimmed.slice(authStart, atIndex);
  if (!auth || /[\s/]/.test(auth)) return trimmed;
  return `${trimmed.slice(0, authStart)}${trimmed.slice(atIndex + 1)}`;
}

/**
 * Validate a proxy URL value (client-side mirror of the outbound proxy
 * allowlist). Relay entries deployed by 9router use `https:` and pass.
 *
 * @param {string} url Candidate proxy URL.
 * @returns {string|null} Error message, or `null` when valid.
 */
export function validateProxyUrl(url) {
  if (!url || !String(url).trim()) return "Proxy URL is required";
  const trimmed = String(url).trim();
  if (/[\n\r`$]/.test(trimmed)) return "Proxy URL contains invalid characters";
  try {
    const parsed = new URL(trimmed);
    if (!PROXY_URL_SCHEMES.includes(parsed.protocol)) {
      return "Use an http, https or socks proxy URL";
    }
  } catch {
    return "Enter a valid proxy URL";
  }
  return null;
}

function inferName(host, port) {
  return port ? `Imported ${host}:${port}` : `Imported ${host}`;
}

/**
 * Parse one batch-import line into `{ proxyUrl, name }`.
 * Accepts full URLs (`scheme://...`) or `host:port:user:pass`.
 * Returns `null` for blank lines. Throws `Error` with a human message for
 * invalid lines.
 *
 * @param {string} line One raw line from the import textarea.
 * @returns {{ proxyUrl: string, name: string } | null}
 */
export function parseProxyLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return null;

  if (trimmed.includes("://")) {
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error("Invalid proxy URL");
    }
    if (!parsed.hostname) throw new Error("Invalid proxy URL");
    const hostLabel = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    return { proxyUrl: parsed.toString(), name: `Imported ${hostLabel}` };
  }

  const parts = trimmed.split(":");
  if (parts.length === 4) {
    const [host, port, username, password] = parts;
    if (!host || !port || !username || !password) {
      throw new Error("Invalid host:port:user:pass format");
    }
    // ponytail: IPv6 hosts and ":" inside user/pass unsupported in this
    // shorthand; paste a full URL for those. Upgrade: bracket-host parsing.
    let proxyUrl;
    try {
      proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
      new URL(proxyUrl);
    } catch {
      throw new Error("Invalid host:port:user:pass format");
    }
    return { proxyUrl: new URL(proxyUrl).toString(), name: inferName(host, port) };
  }

  throw new Error("Unsupported format");
}

/**
 * Parse a whole batch-import textarea into entries and per-line errors.
 *
 * @param {string} text Raw textarea content.
 * @returns {{ entries: Array<{ proxyUrl: string, name: string, lineNumber: number }>, errors: string[] }}
 */
export function parseBatchImport(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const entries = [];
  const errors = [];
  lines.forEach((line, index) => {
    if (!String(line).trim()) return;
    try {
      const parsed = parseProxyLine(line);
      if (parsed) entries.push({ ...parsed, lineNumber: index + 1 });
    } catch (error) {
      errors.push(`Line ${index + 1}: ${error.message}`);
    }
  });
  return { entries, errors };
}

export const SELECTION_INITIAL = { selectedIds: [], checking: false, progress: null };

/**
 * Reducer for the pool-list selection bar: selection, health-check progress,
 * and reset. `progress` is `{ current, total }` while checking.
 */
export function selectionReducer(state = SELECTION_INITIAL, action = {}) {
  switch (action.type) {
    case "toggle":
      return {
        ...state,
        selectedIds: state.selectedIds.includes(action.id)
          ? state.selectedIds.filter((x) => x !== action.id)
          : [...state.selectedIds, action.id],
      };
    case "select-all":
      return { ...state, selectedIds: [...(action.ids || [])] };
    case "clear":
      return { ...state, selectedIds: [] };
    case "prune":
      return {
        ...state,
        selectedIds: state.selectedIds.filter((id) => (action.ids || []).includes(id)),
      };
    case "check-start":
      return { ...state, checking: true, progress: { current: 0, total: action.total || 0 } };
    case "check-progress":
      return {
        ...state,
        progress: { current: action.current || 0, total: state.progress?.total || 0 },
      };
    case "check-done":
      return { ...state, checking: false, progress: null };
    default:
      return state;
  }
}
