// UI display config — all providers derive from registry.display.
import REGISTRY from "open-sse/providers/registry/index.js";
import { getProviderBrand } from "./providerBrands";

export const RISK_NOTICE =
  "⚠️ Risk Notice: This provider uses a subscription/OAuth session not officially licensed for proxy/router use. Account may be restricted or banned. Use at your own risk.";

// Resolve "RISK_NOTICE" token → real notice text (registry stores token to avoid import cycle)
// Tile color: registry color darkened for white-monogram contrast (providerBrands).
const resolveDisplay = (id, display) => ({
  ...display,
  ...(display.color ? { color: getProviderBrand(id).color } : {}),
  ...(display.deprecationNotice === "RISK_NOTICE" ? { deprecationNotice: RISK_NOTICE } : {}),
});

export const PROVIDER_DISPLAY = Object.fromEntries(
  REGISTRY.filter((r) => r.display).map((r) => [r.id, resolveDisplay(r.id, r.display)]),
);
