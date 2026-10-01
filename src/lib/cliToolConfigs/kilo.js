// Kilo Code: openai-compatible entry in auth.json plus the VS Code extension settings.
import { CLIENT_NAME } from "@/lib/cliToolBrand";
import { withV1 } from "@/lib/cliToolConfigs/shared";

/** Keys merged into Kilo's auth.json and VS Code settings.json; `null` without a model. */
export const buildKiloConfig = ({ baseUrl, apiKey, model }) => {
  if (!model) return null;
  const normalizedBaseUrl = withV1(baseUrl);
  return [
    {
      file: "~/.local/share/kilo/auth.json",
      format: "json",
      merge: true,
      value: {
        "openai-compatible": { type: "api-key", apiKey, baseUrl: normalizedBaseUrl, model },
      },
    },
    {
      file: "~/.config/Code/User/settings.json",
      format: "json",
      merge: true,
      value: {
        "kilocode.customProvider": { name: CLIENT_NAME, baseURL: normalizedBaseUrl, apiKey },
        "kilocode.defaultModel": model,
      },
    },
  ];
};
