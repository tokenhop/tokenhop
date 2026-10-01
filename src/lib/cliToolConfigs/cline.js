// Cline CLI: provider/model in globalState.json, key in secrets.json.
import { withoutV1 } from "@/lib/cliToolConfigs/shared";

/** Keys merged into the two Cline data files; `null` without a model. */
export const buildClineConfig = ({ baseUrl, apiKey, model }) => {
  if (!model) return null;
  return [
    {
      file: "~/.cline/data/globalState.json",
      format: "json",
      merge: true,
      value: {
        actModeApiProvider: "openai",
        planModeApiProvider: "openai",
        openAiBaseUrl: withoutV1(baseUrl),
        openAiModelId: model,
        planModeOpenAiModelId: model,
      },
    },
    {
      file: "~/.cline/data/secrets.json",
      format: "json",
      merge: true,
      value: { openAiApiKey: apiKey },
    },
  ];
};
