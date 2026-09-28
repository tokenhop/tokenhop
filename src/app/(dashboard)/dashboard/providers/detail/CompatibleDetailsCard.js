"use client";

import PropTypes from "prop-types";
import { Button, Card } from "@/shared/components";

/**
 * Signal compatible-provider details card: API type, base URL,
 * Add key / Edit / Delete actions.
 */
export default function CompatibleDetailsCard({
  isAnthropic,
  apiType,
  baseUrl,
  onAddKey,
  onEdit,
  onDelete,
}) {
  const apiLabel = isAnthropic
    ? "Messages API"
    : apiType === "responses"
      ? "Responses API"
      : "Chat Completions";
  const path = isAnthropic
    ? "messages"
    : apiType === "responses"
      ? "responses"
      : "chat/completions";

  return (
    <Card
      title={isAnthropic ? "Anthropic Compatible Details" : "OpenAI Compatible Details"}
      subtitle={
        <span className="break-all font-mono text-[13px]">
          {apiLabel} · {(baseUrl || "").replace(/\/$/, "")}/{path}
        </span>
      }
      action={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon="add" onClick={onAddKey}>
            Add API Key
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
  baseUrl: PropTypes.string,
  onAddKey: PropTypes.func.isRequired,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
};
