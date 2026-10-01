// Pure Grok Build config fragment, shared by the Apply route and the manual
// snippet in the dashboard. The value is the text-edit engine's own output, so
// merging it into an empty file gives exactly what Apply writes.
import { applyGrokBuildConfig } from "@/lib/grokBuildConfig";

/**
 * `buildGrokBuildConfig({ baseUrl, apiKey, model, contextWindow, subagentModels, existingToml = "" })`
 * → a `~/.grok/config.toml` text fragment (merge), `null` when no model is
 * given. Arguments are the already-normalised values the route computes today.
 * The card passes the browser's known context window; when it has none the
 * snippet omits `context_window`, while Apply falls back to server capabilities.
 */
export function buildGrokBuildConfig({
  baseUrl,
  apiKey,
  model,
  contextWindow,
  subagentModels,
  existingToml = "",
}) {
  if (!model?.trim()) return null;
  return [
    {
      file: "~/.grok/config.toml",
      format: "text",
      merge: true,
      value: applyGrokBuildConfig(existingToml, {
        baseUrl,
        apiKey,
        model,
        contextWindow,
        subagentModels,
      }),
    },
  ];
}
