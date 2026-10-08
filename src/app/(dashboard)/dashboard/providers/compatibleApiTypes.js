// One source of truth for OpenAI-compatible node API types and FIM templates
// across the provider dashboard. Template values derive from the runtime's
// FIM table (concerns/fim.js is a pure module — no node-only imports, safe in
// client components). Keep the API type values in sync with
// OPENAI_COMPATIBLE_API_TYPES in open-sse/services/provider.js.
import { FIM_TEMPLATE_NAMES } from "open-sse/translator/concerns/fim.js";

export const API_TYPE_OPTIONS = [
  { value: "chat", label: "Chat Completions" },
  { value: "responses", label: "Responses API" },
  { value: "completions", label: "Completions (FIM)" },
];

const FIM_TEMPLATE_LABELS = {
  qwen: "Qwen (<|fim_prefix|>)",
  star_coder: "StarCoder",
  code_llama: "Code Llama",
  deepseek_coder: "DeepSeek Coder",
  codestral: "Codestral",
  glm: "GLM",
  suffix: "Send suffix field (server applies template)",
};

export const FIM_TEMPLATE_OPTIONS = FIM_TEMPLATE_NAMES.map((value) => ({
  value,
  label: FIM_TEMPLATE_LABELS[value] ?? value,
}));

export const apiTypeLabel = (apiType) =>
  API_TYPE_OPTIONS.find((o) => o.value === apiType)?.label ?? "Chat Completions";

export const fimTemplateLabel = (fimTemplate) => FIM_TEMPLATE_LABELS[fimTemplate];
