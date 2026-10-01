import { CLIENT_KEY, CLIENT_NAME } from "@/lib/cliToolBrand";
import { withV1 } from "./shared";

/** Codex CLI: `~/.codex/config.toml`. `null` when no model is picked. */
export const buildCodexConfig = ({ baseUrl, apiKey, model, subagentModel } = {}) => {
  if (!model) return null;
  return [
    {
      file: "~/.codex/config.toml",
      format: "toml",
      merge: true,
      value: {
        model,
        model_provider: CLIENT_KEY,
        model_providers: {
          [CLIENT_KEY]: {
            name: CLIENT_NAME,
            base_url: withV1(baseUrl),
            wire_api: "responses",
            // Custom providers ignore auth.json - the key must travel as a static header
            http_headers: { Authorization: `Bearer ${apiKey}` },
          },
        },
        agents: { default_subagent_model: subagentModel || model },
      },
    },
  ];
};
