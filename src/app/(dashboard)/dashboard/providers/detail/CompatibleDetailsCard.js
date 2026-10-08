"use client";

import PropTypes from "prop-types";
import { Button, Card } from "@/shared/components";

const FIM_TEMPLATE_LABELS = {
  qwen: "Qwen (<|fim_prefix|>)",
  star_coder: "StarCoder",
  code_llama: "Code Llama",
  deepseek_coder: "DeepSeek Coder",
  codestral: "Codestral",
  glm: "GLM",
  suffix: "Server applies template",
};

/**
 * Signal compatible-provider details card: API type, base URL,
 * Add key / Edit / Delete actions.
 */
export default function CompatibleDetailsCard({
  isAnthropic,
  apiType,
  fimTemplate,
  baseUrl,
  onAddKey,
  onEdit,
  onDelete,
}) {
  const apiLabel = isAnthropic
    ? "Messages API"
    : apiType === "responses"
      ? "Responses API"
      : apiType === "completions"
        ? "Completions API (FIM)"
        : "Chat Completions";
  const path = isAnthropic
    ? "messages"
    : apiType === "responses"
      ? "responses"
      : apiType === "completions"
        ? "completions"
        : "chat/completions";
  const templateLabel = FIM_TEMPLATE_LABELS[fimTemplate];

  return (
    <Card
      title={isAnthropic ? "Anthropic Compatible Details" : "OpenAI Compatible Details"}
      subtitle={
        <span className="break-all font-mono text-[13px]">
          {apiLabel} · {(baseUrl || "").replace(/\/$/, "")}/{path}
          {apiType === "completions" && templateLabel ? ` · FIM: ${templateLabel}` : ""}
        </span>
      }
      action={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon="add" onClick={onAddKey}>
            Add API key
          </Button>
          <Button size="sm" variant="secondary" icon="edit" onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="secondary" icon="delete" onClick={onDelete}>
            Delete
          </Button>
        </div>
      }
    />
  );
}

CompatibleDetailsCard.propTypes = {
  isAnthropic: PropTypes.bool.isRequired,
  apiType: PropTypes.string,
  fimTemplate: PropTypes.string,
  baseUrl: PropTypes.string,
  onAddKey: PropTypes.func.isRequired,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
};
