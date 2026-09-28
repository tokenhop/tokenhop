// Provider icon paths under /public/providers.
// Alias related brands; session-cache 404s so one miss never spams again.

const ICON_ALIASES = {
  "perplexity-agent": "perplexity",
  "gitlab-duo": "gitlab",
  "vercel-ai-gateway": "vercel",
  "ollama-search": "ollama",
};

// User-created compatible nodes (`openai-compatible-<uuid>`) share their family's logo.
function compatibleIconId(id) {
  if (id.startsWith("openai-compatible")) return "oai-cc";
  if (id.startsWith("anthropic-compatible")) return "anthropic-m";
  return "";
}

// Runtime only — first 404 remembers id for the whole session
const failedIds = new Set();

function normalizeId(providerId) {
  if (!providerId || typeof providerId !== "string") return "";
  return providerId.trim().toLowerCase();
}

/** Resolve icon file id (after alias). Empty if previously failed this session. */
export function resolveProviderIconId(providerId) {
  const id = normalizeId(providerId);
  if (!id) return "";
  if (failedIds.has(id)) return "";
  const aliased = ICON_ALIASES[id] || compatibleIconId(id) || id;
  if (failedIds.has(aliased)) return "";
  return aliased;
}

// Logos shipped as vector (no WebP). ponytail: explicit list; switch to a manifest if many land.
const SVG_ICONS = new Set(["meta-code"]);

/** `/providers/{id}.webp` (or `.svg` for vector logos), null when previously failed. */
export function getProviderIconSrc(providerId) {
  const id = resolveProviderIconId(providerId);
  if (!id) return null;
  return `/providers/${id}.${SVG_ICONS.has(id) ? "svg" : "webp"}`;
}

/** Call from img onError so later mounts skip the request. */
export function markProviderIconMissing(providerId) {
  const id = normalizeId(providerId);
  if (id) failedIds.add(id);
  const aliased = ICON_ALIASES[id] || compatibleIconId(id);
  if (aliased) failedIds.add(aliased);
}
