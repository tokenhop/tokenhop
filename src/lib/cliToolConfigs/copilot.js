// VS Code Copilot: one azure-vendor entry in chatLanguageModels.json.
import { CLIENT_NAME } from "@/lib/cliToolBrand";

/** Display path of chatLanguageModels.json for an OS platform name. */
export const copilotConfigFile = (platform) => {
  if (platform === "win32") return "%APPDATA%\\Code\\User\\chatLanguageModels.json";
  if (platform === "darwin") {
    return "~/Library/Application Support/Code/User/chatLanguageModels.json";
  }
  return "~/.config/Code/User/chatLanguageModels.json";
};

/** Our entry in chatLanguageModels.json (a JSON array); `null` without models. */
export const buildCopilotConfig = ({ baseUrl, apiKey, models, platform }) => {
  if (!models?.length) return null;
  const url = `${baseUrl}/chat/completions#models.ai.azure.com`;
  return [
    {
      file: copilotConfigFile(platform),
      format: "json",
      merge: true,
      note: "Add this entry to the array in the existing file, replacing any entry with the same name.",
      value: [
        {
          name: CLIENT_NAME,
          vendor: "azure",
          apiKey,
          models: models.map((id) => ({
            id,
            name: id,
            url,
            toolCalling: true,
            vision: false,
            maxInputTokens: 128000,
            maxOutputTokens: 16000,
          })),
        },
      ],
    },
  ];
};
