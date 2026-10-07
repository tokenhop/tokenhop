import { FORMATS } from "../formats.js";
import { OPENAI_BLOCK } from "../schema/index.js";

// Rewrites body.tool_choice / body.tools on the final wire body; returns a short
// description only when the choice changes. Never mutates the choice object itself:
// it may be shared with the client body that combo fallbacks reuse.
export function normalizeForcedToolChoice(body, format, caps) {
  const choice = body.tool_choice;
  const claude = format === FORMATS.CLAUDE;
  const openai = format === FORMATS.OPENAI;
  if (!claude && !openai && format !== FORMATS.OPENAI_RESPONSES) return null;
  const forced = claude && body.thinking?.type === "enabled" ? false : caps.forcedToolChoice;
  if (forced === true || choice == null) return null;

  const named = claude
    ? choice.type === "tool"
    : choice.type === OPENAI_BLOCK.FUNCTION || choice.type === "custom";
  const name = named ? (choice.function?.name ?? choice.name) : undefined;
  if (forced === false) {
    if (named || (claude ? choice.type === "any" : choice === "required")) {
      body.tool_choice = claude ? claudeChoice("auto", choice) : "auto";
      return "forced tool_choice → auto";
    }
    if (!claude && choice.type === "allowed_tools") {
      if (choice.allowed_tools?.mode === "required") {
        body.tool_choice = { ...choice, allowed_tools: { ...choice.allowed_tools, mode: "auto" } };
        return "allowed_tools required → auto";
      }
      if (choice.mode === "required") {
        body.tool_choice = { ...choice, mode: "auto" };
        return "allowed_tools required → auto";
      }
    }
  } else if (forced === "any" && named) {
    body.tool_choice = claude ? claudeChoice("any", choice) : "required";
    if (name && Array.isArray(body.tools)) {
      // Keep tools already called in history: strict gateways reject calls to undeclared tools.
      const keep = historyToolNames(body).add(name);
      const toolName = (tool) => (openai ? tool.function?.name : tool.name);
      // Built-ins (web_search, file_search, …) have no callable name: never drop them.
      const builtin = (tool) =>
        !claude && tool.type && tool.type !== OPENAI_BLOCK.FUNCTION && tool.type !== "custom";
      const matching = body.tools.filter((tool) => builtin(tool) || keep.has(toolName(tool)));
      if (matching.some((tool) => toolName(tool) === name)) body.tools = matching;
    }
    return "named tool_choice → required";
  }
  return null;
}

function historyToolNames(body) {
  const names = new Set();
  const items = [...(body.messages ?? []), ...(Array.isArray(body.input) ? body.input : [])];
  for (const item of items) {
    for (const call of item?.tool_calls ?? []) {
      if (call?.function?.name) names.add(call.function.name);
    }
    if ((item?.type === "function_call" || item?.type === "custom_tool_call") && item.name) {
      names.add(item.name);
    }
    if (Array.isArray(item?.content)) {
      for (const block of item.content) {
        if (block?.type === "tool_use" && block.name) names.add(block.name);
      }
    }
  }
  return names;
}

function claudeChoice(type, choice) {
  return {
    type,
    ...(choice.disable_parallel_tool_use !== undefined
      ? { disable_parallel_tool_use: choice.disable_parallel_tool_use }
      : {}),
  };
}
