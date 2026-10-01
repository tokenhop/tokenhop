import { ACTIVE } from "@/shared/brand";
import { CLIENT_KEY, modelRef } from "@/lib/cliToolBrand";
import { withV1 } from "./shared";

/**
 * ~/.config/opencode/opencode.json. `activeModel === ""` clears the active
 * model; the subagent falls back to the active model, then the first model.
 * `null` when there are no models.
 */
export function buildOpenCodeConfig({ baseUrl, apiKey, models, activeModel, subagentModel }) {
  if (!models?.length) return null;

  const modelMap = {};
  for (const m of models) {
    if (!m || typeof m !== "string") continue;
    modelMap[m] = { name: m, modalities: { input: ["text", "image"], output: ["text"] } };
  }

  return [
    {
      file: "~/.config/opencode/opencode.json",
      format: "json",
      merge: true,
      value: {
        provider: {
          [CLIENT_KEY]: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: withV1(baseUrl), apiKey: apiKey || ACTIVE.defaultApiKey },
            models: modelMap,
          },
        },
        model: activeModel === "" ? "" : modelRef(activeModel || models[0]),
        agent: {
          explorer: {
            description: "Fast explorer subagent for codebase exploration",
            mode: "subagent",
            model: modelRef(subagentModel || activeModel || models[0]),
          },
        },
      },
    },
  ];
}
