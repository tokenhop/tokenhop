// Pure helpers for the Signal CLI-tools list: status derivation, filter
// counts, filtering, endpoint options and tool brand tiles.
// No React, no I/O — unit-tested in tests/unit/cli-tools-status.test.js.

/**
 * Status keys shown as pills on the tool grid.
 * connected: tool installed + points at 9Router.
 * notConfigured: installed but no 9Router config.
 * notInstalled: CLI not detected on this machine.
 * error: detection request failed, so install state is unknown.
 * guide: configType "guide" tools are docs, not detection.
 * manual: remote dashboard, where install detection never runs.
 */
export const TOOL_STATUS_KEYS = [
  "connected",
  "notConfigured",
  "notInstalled",
  "error",
  "guide",
  "manual",
];

/**
 * Derive a grid status from a tool def and its detection payload.
 * A failed detection always reports "error", even for guide tools that own a
 * writer card (Copilot), so a real failure is never masked. Otherwise guide
 * tools report "guide" regardless of detection.
 * Remote mode skips detection: writer tools are "manual", guide tools stay "guide".
 *
 * @param {object} tool CLI_TOOLS entry (may carry configType)
 * @param {object|null|undefined} status Detection payload (installed, hasTokenhop, error)
 * @param {{ remote?: boolean }} [options]
 * @returns {{ key: "connected"|"notConfigured"|"notInstalled"|"error"|"guide"|"manual", label: string, variant: "ok"|"warn"|"info"|"neutral"|"err" }}
 */
export function deriveToolStatus(tool, status, { remote = false } = {}) {
  if (remote) {
    if (tool?.configType === "guide") return { key: "guide", label: "Guide", variant: "info" };
    return { key: "manual", label: "Manual setup", variant: "info" };
  }
  if (status?.error) return { key: "error", label: "Detection failed", variant: "err" };
  if (tool?.configType === "guide") return { key: "guide", label: "Guide", variant: "info" };
  if (!status) return { key: "notInstalled", label: "Not installed", variant: "neutral" };
  if (!status.installed) return { key: "notInstalled", label: "Not installed", variant: "neutral" };
  if (status.hasTokenhop) return { key: "connected", label: "Connected", variant: "ok" };
  return { key: "notConfigured", label: "Not configured", variant: "warn" };
}

/** Status keys that land in the "Needs setup" bucket (unknown state included). */
const NEEDS_SETUP_KEYS = new Set(["notConfigured", "notInstalled", "error"]);

/**
 * Count tools per filter bucket. "needsSetup" covers notConfigured,
 * notInstalled and error (failed detection); "guides" covers configType guide.
 * Uses the same bucket rule as filterToolEntries, so a count always equals
 * the filtered list length.
 *
 * @param {Array<[string, object]>} entries [toolId, tool] pairs
 * @param {Record<string, object>} statuses Detection payloads by toolId
 * @param {{ remote?: boolean }} [options]
 * @returns {{ all: number, connected: number, needsSetup: number, guides: number, manual: number }}
 */
export function countToolsByFilter(entries, statuses = {}, options = {}) {
  const counts = { all: entries.length, connected: 0, needsSetup: 0, guides: 0, manual: 0 };
  for (const [toolId, tool] of entries) {
    const { key } = deriveToolStatus(tool, statuses[toolId], options);
    if (key === "guide") counts.guides += 1;
    else if (key === "manual") counts.manual += 1;
    else if (key === "connected") counts.connected += 1;
    else if (NEEDS_SETUP_KEYS.has(key)) counts.needsSetup += 1;
    else throw new Error(`countToolsByFilter: unbucketed status "${key}"`);
  }
  return counts;
}

/**
 * Filter grid entries by bucket and free-text query (name match).
 *
 * @param {Array<[string, object]>} entries [toolId, tool] pairs
 * @param {Record<string, object>} statuses Detection payloads by toolId
 * @param {"all"|"connected"|"needsSetup"|"guides"} filter Active bucket
 * @param {string} query Free-text match against tool name
 * @param {{ remote?: boolean }} [options]
 * @returns {Array<[string, object]>} Matching entries
 */
export function filterToolEntries(
  entries,
  statuses = {},
  filter = "all",
  query = "",
  options = {},
) {
  const q = (query || "").trim().toLowerCase();
  return entries.filter(([toolId, tool]) => {
    if (q && !(tool?.name || "").toLowerCase().includes(q)) return false;
    if (filter === "all") return true;
    const { key } = deriveToolStatus(tool, statuses[toolId], options);
    if (filter === "connected") return key === "connected";
    if (filter === "needsSetup") return NEEDS_SETUP_KEYS.has(key);
    if (filter === "guides") return key === "guide";
    throw new Error(`filterToolEntries: unknown filter "${filter}"`);
  });
}

const CUSTOM_VALUE = "__custom__";

const ensureV1 = (url) => {
  const trimmed = (url || "").replace(/\/+$/, "");
  if (!trimmed) return "";
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
};

const stripSlash = (url) => (url || "").replace(/\/+$/, "");

/**
 * Build the endpoint picker options (Local / Tunnel / Tailscale / Cloud /
 * saved presets / Custom). Pure extraction of the BaseUrlSelect option logic
 * so the segmented UI and the counts stay tested.
 */
export function buildEndpointOptions({
  requiresExternalUrl = false,
  tunnelEnabled = false,
  tunnelPublicUrl = "",
  tailscaleEnabled = false,
  tailscaleUrl = "",
  cloudEnabled = false,
  cloudUrl = "",
  savedPresets = [],
  withV1 = true,
  localOrigin = "",
  remote = false,
} = {}) {
  const wrap = (url) => (withV1 ? ensureV1(url) : stripSlash(url));
  const opts = [];
  if (!requiresExternalUrl && localOrigin) {
    const localUrl = wrap(localOrigin);
    // Opened remotely, the browser origin is the dashboard's address, not localhost.
    opts.push({ value: "local", label: remote ? "Dashboard" : "Local", url: localUrl });
  }
  if (tunnelEnabled && tunnelPublicUrl) {
    opts.push({ value: "tunnel", label: "Tunnel", url: wrap(tunnelPublicUrl) });
  }
  if (tailscaleEnabled && tailscaleUrl) {
    opts.push({ value: "tailscale", label: "Tailscale", url: wrap(tailscaleUrl) });
  }
  if (cloudEnabled && cloudUrl) {
    opts.push({ value: "cloud", label: "Cloud", url: wrap(cloudUrl) });
  }
  for (const p of savedPresets) {
    if (p?.name && p?.baseUrl)
      opts.push({ value: `saved:${p.name}`, label: p.name, url: p.baseUrl });
  }
  opts.push({ value: CUSTOM_VALUE, label: "Custom", url: "" });
  return opts;
}

export const ENDPOINT_CUSTOM_VALUE = CUSTOM_VALUE;

/**
 * URL for a saved endpoint: a built-in or preset id follows that option's current URL;
 * Custom, a legacy row (URL only) or an option that's gone keeps the saved URL.
 */
export function resolveSavedEndpoint({ endpoint = "", endpointId = "" } = {}, ctx = {}) {
  if (!endpointId) return endpoint;
  return buildEndpointOptions(ctx).find((o) => o.value === endpointId)?.url || endpoint;
}

/**
 * Monogram tile for a CLI tool. Colors come from the CLI_TOOLS defs (the
 * single constants map for tool brands); unknown tools get the dark fallback.
 *
 * @param {object} tool CLI_TOOLS entry (may carry color, name)
 * @returns {{ color: string, monogram: string }}
 */
export function getToolBrand(tool) {
  const color =
    typeof tool?.color === "string" && /^#[0-9a-fA-F]{6}$/.test(tool.color)
      ? tool.color
      : "#15171d";
  const words = String(tool?.name || "?")
    .split(/[\s-]+/)
    .filter(Boolean);
  const monogram =
    words.length > 1
      ? `${words[0][0]}${words[1][0]}`.toUpperCase()
      : String(tool?.name || "?")
          .slice(0, 2)
          .toUpperCase();
  return { color, monogram };
}
