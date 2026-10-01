// Pure builder for the DeepSeek TUI config Apply writes and the manual
// snippet shows. Whole-file replace; the route merges nothing.
import { ACTIVE } from "@/shared/brand";
import { withV1 } from "./shared";

const tomlString = (value) => JSON.stringify(String(value));

export const buildDeepSeekTuiConfig = ({ baseUrl, apiKey, model }) => {
  if (!model) return null;
  const value = `provider = "openai"

[providers.openai]
base_url = ${tomlString(withV1(baseUrl))}
api_key = ${tomlString(apiKey || ACTIVE.defaultApiKey)}
model = ${tomlString(model)}
`;
  return [{ file: "~/.deepseek/config.toml", format: "text", merge: false, value }];
};
