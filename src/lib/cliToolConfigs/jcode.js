// Pure jcode config fragments, shared by the Apply route and the manual
// snippet in the dashboard. No fs/env access: the route resolves real paths.
import { CLIENT_KEY, JCODE_API_KEY_ENV } from "@/lib/cliToolBrand";
import { withV1 } from "./shared";

// Matches the jcode tool definition's first default model (cliTools.js).
export const JCODE_DEFAULT_MODEL = "cc/claude-opus-5";

/**
 * `buildJcodeConfig({ baseUrl, apiKey, model, envDir = "~/.config/jcode" })` →
 * fragments for `~/.jcode/config.toml` (merge) and `<envDir>/provider-<key>.env`
 * (merge). `null` when no model is given. `envDir` is a display path; the Apply
 * route passes its XDG-resolved directory so the env_file name matches.
 */
export function buildJcodeConfig({ baseUrl, apiKey, model, envDir = "~/.config/jcode" }) {
  if (!model) return null;
  const envFile = `provider-${CLIENT_KEY.toLowerCase()}.env`;
  return [
    {
      file: "~/.jcode/config.toml",
      format: "toml",
      merge: true,
      value: {
        providers: {
          [CLIENT_KEY]: {
            type: "openai-compatible",
            base_url: withV1(baseUrl),
            auth: "bearer",
            api_key_env: JCODE_API_KEY_ENV,
            env_file: envFile,
            default_model: model,
            requires_api_key: true,
            models: [{ id: model }],
          },
        },
      },
    },
    {
      file: `${envDir}/${envFile}`,
      format: "text",
      merge: true,
      value: `# jcode provider environment variables\n${JCODE_API_KEY_ENV}="${apiKey}"\n`,
    },
  ];
}
