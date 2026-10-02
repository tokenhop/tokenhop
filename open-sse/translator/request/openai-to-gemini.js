import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import {
  DEFAULT_THINKING_AG_SIGNATURE,
  DEFAULT_THINKING_GEMINI_CLI_SIGNATURE,
} from "../../config/defaultThinkingSignature.js";
import { openaiToClaudeRequestForAntigravity } from "./openai-to-claude.js";
import { getGeminiThoughtSignatureSync } from "../../services/thoughtSignatureStore.js";
function generateUUID() {
  return crypto.randomUUID();
}

import {
  DEFAULT_SAFETY_SETTINGS,
  convertOpenAIContentToParts,
  extractTextContent,
  tryParseJSON,
  generateRequestId,
  generateSessionId,
  generateProjectId,
  cleanJSONSchemaForAntigravity,
  normalizeGeminiContents,
} from "../formats/gemini.js";
import { deriveSessionId, toNumericSessionId } from "../../utils/sessionManager.js";
import { parseDataUri } from "../concerns/image.js";
import { extractThinking, parseSuffix } from "../concerns/thinkingUnified.js";
import { ROLE, GEMINI_ROLE, OPENAI_BLOCK, CLAUDE_BLOCK } from "../schema/index.js";

// Sanitize function names for Gemini API.
// Gemini requires: starts with [a-zA-Z_], followed by [a-zA-Z0-9_.:\-], max 64 chars.
// Replace any invalid character with '_' and truncate to 64.
function sanitizeGeminiFunctionName(name) {
  if (!name) return "_unknown";
  // Replace any char not in [a-zA-Z0-9_.:\-] with '_'
  let sanitized = name.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  // First char must be letter or underscore
  if (!/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = "_" + sanitized;
  }
  // Truncate to 64 chars
  return sanitized.substring(0, 64);
}

// Core: Convert OpenAI request to Gemini format (base for all variants)
function openaiToGeminiBase(
  model,
  body,
  stream,
  signature = DEFAULT_THINKING_AG_SIGNATURE,
  sessionId = null,
) {
  const result = {
    model: model,
    contents: [],
    generationConfig: {},
    safetySettings: DEFAULT_SAFETY_SETTINGS,
  };

  // Generation config
  if (body.temperature !== undefined) {
    result.generationConfig.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    result.generationConfig.topP = body.top_p;
  }
  if (body.top_k !== undefined) {
    result.generationConfig.topK = body.top_k;
  }
  const maxOutputTokens = body.max_tokens ?? body.max_completion_tokens;
  if (maxOutputTokens !== undefined) {
    result.generationConfig.maxOutputTokens = maxOutputTokens;
  }
  // Gemini accepts at most 5 stop sequences
  const stopSequences = [body.stop]
    .flat()
    .filter((s) => typeof s === "string" && s)
    .slice(0, 5);
  if (stopSequences.length > 0) {
    result.generationConfig.stopSequences = stopSequences;
  }

  // Tool-call ids can repeat across turns (some clients/upstreams reuse them),
  // but Gemini pairs functionCall/functionResponse by id. Make every occurrence
  // unique by suffixing repeats (call_1 -> call_1__2) on both call and response.
  // The conversion loop consumes uniqueCallId once per occurrence in message
  // order, so a per-occurrence counter assigns the same suffixes deterministically.
  const idUseCount = new Map();
  const uniqueCallId = (id) => {
    if (!id) return id;
    const count = (idUseCount.get(id) || 0) + 1;
    idUseCount.set(id, count);
    return count === 1 ? id : `${id}__${count}`;
  };

  // Convert messages
  if (body.messages && Array.isArray(body.messages)) {
    const instructionParts = body.messages
      .filter((msg) => msg.role === ROLE.SYSTEM || msg.role === ROLE.DEVELOPER)
      .map((msg) => ({
        text: typeof msg.content === "string" ? msg.content : extractTextContent(msg.content, "\n"),
      }))
      .filter((part) => part.text);
    if (instructionParts.length > 0 && body.messages.length > 1) {
      result.systemInstruction = { role: GEMINI_ROLE.USER, parts: instructionParts };
    }

    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i];
      const role = msg.role;
      const content = msg.content;

      if (role === ROLE.SYSTEM || role === ROLE.DEVELOPER) {
        if (body.messages.length === 1) {
          const parts = convertOpenAIContentToParts(content);
          if (parts.length > 0) result.contents.push({ role: GEMINI_ROLE.USER, parts });
        }
      } else if (role === ROLE.USER) {
        const parts = convertOpenAIContentToParts(content);
        if (parts.length > 0) {
          result.contents.push({ role: GEMINI_ROLE.USER, parts });
        }
      } else if (role === ROLE.ASSISTANT) {
        const parts = [];

        // Thinking/reasoning → thought part with signature
        if (msg.reasoning_content) {
          parts.push({
            thought: true,
            text: msg.reasoning_content,
          });
          parts.push({
            thoughtSignature: signature,
            text: "",
          });
        }

        if (content) {
          const text = typeof content === "string" ? content : extractTextContent(content);
          if (text) {
            parts.push({ text });
          }
        }

        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          const calls = [];
          let firstFunctionCallSeen = false;
          for (const tc of msg.tool_calls) {
            if (tc.type !== OPENAI_BLOCK.FUNCTION) continue;

            const args = tryParseJSON(tc.function?.arguments || "{}");
            const cachedSig = tc.id ? getGeminiThoughtSignatureSync(tc.id, sessionId, model) : null;
            // First call gets cached signature or fallback; sibling calls remain unsigned if no cached sig
            const callSig = cachedSig || (!firstFunctionCallSeen ? signature : undefined);
            firstFunctionCallSeen = true;

            // Repeated ids (reused across turns) are made unique so every
            // functionCall/functionResponse pair matches by id
            const callId = uniqueCallId(tc.id);
            const name = tc.function?.name || "";
            const part = {
              functionCall: {
                id: callId,
                name: sanitizeGeminiFunctionName(name),
                args: args,
              },
            };
            if (callSig) {
              part.thoughtSignature = callSig;
            }
            parts.push(part);
            calls.push({ id: callId, origId: tc.id, name });
          }

          if (parts.length > 0) {
            result.contents.push({ role: GEMINI_ROLE.MODEL, parts });
          }

          // Pair this turn with the tool messages that follow it, up to the next
          // assistant turn — ids can repeat across turns, so never match against
          // the whole conversation.
          const responses = new Map();
          for (let j = i + 1; j < body.messages.length; j++) {
            const tm = body.messages[j];
            if (tm.role === ROLE.ASSISTANT) break;
            if (tm.role === ROLE.TOOL) {
              responses.set(tm.tool_call_id, tm.content);
            }
          }

          // Check if there are actual tool responses in the next messages
          const isIntermediate = i < body.messages.length - 1;
          const hasActualResponses = calls.some((c) => responses.has(c.origId));

          if (hasActualResponses || isIntermediate) {
            const toolParts = [];
            for (const call of calls) {
              let resp = responses.get(call.origId);
              if (resp === undefined) resp = "";

              let name = call.name;
              if (!name) {
                const idParts = call.origId.split("-");
                if (idParts.length > 2) {
                  name = idParts.slice(0, -2).join("-");
                } else {
                  name = call.origId;
                }
              }

              let parsedResp = tryParseJSON(resp);
              if (parsedResp === null) {
                parsedResp = { result: resp };
              } else if (typeof parsedResp !== "object") {
                parsedResp = { result: parsedResp };
              }

              toolParts.push({
                functionResponse: {
                  id: call.id,
                  name: sanitizeGeminiFunctionName(name),
                  response: { result: parsedResp },
                },
              });
            }
            if (toolParts.length > 0) {
              result.contents.push({ role: GEMINI_ROLE.USER, parts: toolParts });
            }
          }
        } else if (parts.length > 0) {
          result.contents.push({ role: GEMINI_ROLE.MODEL, parts });
        }
      }
    }
  }

  // Convert tools
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const functionDeclarations = [];
    for (const t of body.tools) {
      // Check if already in Anthropic/Claude format (no type field, direct name/description/input_schema)
      if (t.name && t.input_schema) {
        const cleanedSchema = cleanJSONSchemaForAntigravity(
          structuredClone(t.input_schema || { type: "object", properties: {} }),
        );
        functionDeclarations.push({
          name: sanitizeGeminiFunctionName(t.name),
          description: t.description || "",
          parameters: cleanedSchema,
        });
      }
      // OpenAI format
      else if (t.type === OPENAI_BLOCK.FUNCTION && t.function) {
        const fn = t.function;
        const cleanedSchema = cleanJSONSchemaForAntigravity(
          structuredClone(fn.parameters || { type: "object", properties: {} }),
        );
        functionDeclarations.push({
          name: sanitizeGeminiFunctionName(fn.name),
          description: fn.description || "",
          parameters: cleanedSchema,
        });
      }
    }

    if (functionDeclarations.length > 0) {
      result.tools = [{ functionDeclarations }];
    }
  }

  result.contents = normalizeGeminiContents(result.contents);
  return result;
}

// OpenAI -> Gemini (standard API)
export function openaiToGeminiRequest(model, body, stream, credentials = null) {
  return openaiToGeminiBase(
    model,
    body,
    stream,
    DEFAULT_THINKING_AG_SIGNATURE,
    credentials?._clientSessionId,
  );
}

// OpenAI -> Gemini CLI (Cloud Code Assist)
export function openaiToGeminiCLIRequest(model, body, stream, credentials = null) {
  const gemini = openaiToGeminiBase(
    model,
    body,
    stream,
    DEFAULT_THINKING_GEMINI_CLI_SIGNATURE,
    credentials?._clientSessionId,
  );
  // Thinking is normalized centrally by applyThinking (thinkingUnified.js) after translation.

  // Clean schema for tools
  if (gemini.tools?.[0]?.functionDeclarations) {
    for (const fn of gemini.tools[0].functionDeclarations) {
      if (fn.parameters) {
        const cleanedSchema = cleanJSONSchemaForAntigravity(fn.parameters);
        fn.parameters = cleanedSchema;
        // if (isClaude) {
        //   fn.parameters = cleanedSchema;
        // } else {
        //   fn.parametersJsonSchema = cleanedSchema;
        //   delete fn.parameters;
        // }
      }
    }
  }

  return gemini;
}

// Wrap Gemini CLI format in Cloud Code wrapper
function wrapInCloudCodeEnvelope(model, geminiCLI, credentials = null, isAntigravity = false) {
  const projectId = credentials?.projectId || generateProjectId();

  const envelope = {
    project: projectId,
    model: model,
    userAgent: isAntigravity ? "antigravity" : "gemini-cli",
    requestId: isAntigravity ? `agent-${generateUUID()}` : generateRequestId(),
    request: {
      sessionId:
        toNumericSessionId(credentials?._clientSessionId) ||
        (isAntigravity
          ? deriveSessionId(credentials?.email || credentials?.connectionId)
          : generateSessionId()),
      contents: geminiCLI.contents,
      systemInstruction: geminiCLI.systemInstruction,
      generationConfig: geminiCLI.generationConfig,
      tools: geminiCLI.tools,
    },
  };

  // Antigravity specific fields
  if (isAntigravity) {
    envelope.requestType = "agent";
  } else {
    // Keep safetySettings for Gemini CLI
    envelope.request.safetySettings = geminiCLI.safetySettings;
  }

  if (geminiCLI.tools?.length > 0) {
    envelope.request.toolConfig = {
      functionCallingConfig: { mode: "VALIDATED" },
    };
  }

  return envelope;
}

// Claude base64 image/document block or OpenAI data-URI image_url → Gemini inlineData part.
// ponytail: remote URLs are not handled here; prefetchRemoteImages inlines them first.
function toInlineDataPart(block) {
  if (
    (block?.type === CLAUDE_BLOCK.IMAGE || block?.type === CLAUDE_BLOCK.DOCUMENT) &&
    block.source?.type === "base64" &&
    block.source.data
  ) {
    return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
  }
  let url = null;
  if (block?.type === OPENAI_BLOCK.IMAGE_URL) {
    url = typeof block.image_url === "string" ? block.image_url : block.image_url?.url;
  } else if (block?.type === OPENAI_BLOCK.FILE) {
    url = block.file?.file_data;
  }
  const parsed = parseDataUri(url);
  return parsed ? { inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } } : null;
}

// Thinking on this request? Anthropic requires temperature 1 with thinking.
// Same detection applyThinking uses (model suffix, then body intent).
function isThinkingOn(model, body) {
  const intent = parseSuffix(model).override || extractThinking(body);
  return !!intent && intent.mode !== "none";
}

// Wrap Claude format in Cloud Code envelope for Antigravity
function wrapInCloudCodeEnvelopeForClaude(
  model,
  claudeRequest,
  credentials = null,
  signature = DEFAULT_THINKING_AG_SIGNATURE,
  thinkingOn = false,
) {
  const projectId = credentials?.projectId || generateProjectId();

  const envelope = {
    project: projectId,
    model: model,
    userAgent: "antigravity",
    requestId: `agent-${generateUUID()}`,
    requestType: "agent",
    request: {
      sessionId:
        toNumericSessionId(credentials?._clientSessionId) ||
        deriveSessionId(credentials?.email || credentials?.connectionId),
      contents: [],
      generationConfig: {
        temperature: thinkingOn ? 1 : (claudeRequest.temperature ?? 1),
        maxOutputTokens: claudeRequest.max_tokens || 4096,
      },
    },
  };

  // Claude tool_use ids can repeat across turns (some clients/upstreams reuse
  // them), but Gemini pairs functionCall/functionResponse by id. Pair each
  // tool_result with the nearest preceding tool_use of the same id and make
  // repeated ids unique (toolu_1 -> toolu_1__2) on both sides.
  const callIdFor = new WeakMap(); // tool_use/tool_result block -> unique id
  const nameFor = new WeakMap(); // tool_result block -> tool name
  const idUseCount = new Map(); // tool_use id -> occurrence count
  if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
    const openCalls = [];
    for (const msg of claudeRequest.messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === CLAUDE_BLOCK.TOOL_USE && block.id) {
          const count = (idUseCount.get(block.id) || 0) + 1;
          idUseCount.set(block.id, count);
          if (count > 1) callIdFor.set(block, `${block.id}__${count}`);
          openCalls.push(block);
        } else if (block.type === CLAUDE_BLOCK.TOOL_RESULT && block.tool_use_id) {
          for (let k = openCalls.length - 1; k >= 0; k--) {
            if (openCalls[k].id === block.tool_use_id) {
              nameFor.set(block, openCalls[k].name);
              if (callIdFor.has(openCalls[k])) callIdFor.set(block, callIdFor.get(openCalls[k]));
              break;
            }
          }
        }
      }
    }
  }

  // Convert Claude messages to Gemini contents
  if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
    for (const msg of claudeRequest.messages) {
      const parts = [];
      // Media returned by tools; they go after the functionResponses, tagged by call id.
      const toolMedia = [];

      if (Array.isArray(msg.content)) {
        let firstToolUseSeen = false;
        for (const block of msg.content) {
          const inline = toInlineDataPart(block);
          if (inline) {
            parts.push(inline);
          } else if (block.type === CLAUDE_BLOCK.TEXT) {
            parts.push({ text: block.text });
          } else if (block.type === CLAUDE_BLOCK.TOOL_USE) {
            const cachedSig = block.id
              ? getGeminiThoughtSignatureSync(block.id, credentials?._clientSessionId, model)
              : null;
            const callSig = cachedSig || (!firstToolUseSeen ? signature : undefined);
            firstToolUseSeen = true;

            const part = {
              functionCall: {
                id: callIdFor.get(block) || block.id,
                name: sanitizeGeminiFunctionName(block.name),
                args: block.input || {},
              },
            };
            if (callSig) {
              part.thoughtSignature = callSig;
            }
            parts.push(part);
          } else if (block.type === CLAUDE_BLOCK.TOOL_RESULT) {
            let content = block.content;
            if (Array.isArray(content)) {
              const media = [];
              const text = [];
              for (const c of content) {
                const inline = toInlineDataPart(c);
                if (inline) media.push(inline);
                else text.push(c.type === CLAUDE_BLOCK.TEXT ? c.text : JSON.stringify(c));
              }
              if (media.length) {
                toolMedia.push(
                  { text: `[Attachment from tool result ${block.tool_use_id}]` },
                  ...media,
                );
              }
              content = text.join("\n");
            }
            // Resolve the name/id from the paired tool_use — Gemini requires
            // the functionResponse to match its functionCall (ids may have been
            // made unique when repeated across turns)
            const pairedName = nameFor.get(block);
            parts.push({
              functionResponse: {
                id: callIdFor.get(block) || block.tool_use_id,
                name: pairedName ? sanitizeGeminiFunctionName(pairedName) : "tool",
                response: { result: tryParseJSON(content) || content },
              },
            });
          }
        }
      } else if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      }
      parts.push(...toolMedia);

      if (parts.length > 0) {
        envelope.request.contents.push({
          role: msg.role === ROLE.ASSISTANT ? GEMINI_ROLE.MODEL : GEMINI_ROLE.USER,
          parts,
        });
      }
    }
  }

  // Convert Claude tools to Gemini functionDeclarations
  if (claudeRequest.tools && Array.isArray(claudeRequest.tools)) {
    const functionDeclarations = [];
    for (const tool of claudeRequest.tools) {
      if (tool.name && tool.input_schema) {
        const cleanedSchema = cleanJSONSchemaForAntigravity(tool.input_schema);
        functionDeclarations.push({
          name: sanitizeGeminiFunctionName(tool.name),
          description: tool.description || "",
          parameters: cleanedSchema,
        });
      }
    }
    if (functionDeclarations.length > 0) {
      envelope.request.tools = [{ functionDeclarations }];
      envelope.request.toolConfig = {
        functionCallingConfig: { mode: "VALIDATED" },
      };
    }
  }

  const systemParts = [];
  // Merge user system prompt from claudeRequest
  if (claudeRequest.system) {
    if (Array.isArray(claudeRequest.system)) {
      for (const block of claudeRequest.system) {
        if (block.text) systemParts.push({ text: block.text });
      }
    } else if (typeof claudeRequest.system === "string") {
      systemParts.push({ text: claudeRequest.system });
    }
  }

  if (systemParts.length > 0) {
    envelope.request.systemInstruction = { role: GEMINI_ROLE.USER, parts: systemParts };
  }

  envelope.request.contents = normalizeGeminiContents(envelope.request.contents);
  return envelope;
}

// Detect if model should use Claude backend in Antigravity
// Claude models have specific ID patterns — more reliable than caps at routing level
function isClaudeModel(model) {
  return model.toLowerCase().includes("claude");
}

// OpenAI -> Antigravity (Sandbox Cloud Code with wrapper)
export function openaiToAntigravityRequest(model, body, stream, credentials = null) {
  if (isClaudeModel(model)) {
    const claudeRequest = openaiToClaudeRequestForAntigravity(model, body, stream);
    return wrapInCloudCodeEnvelopeForClaude(
      model,
      claudeRequest,
      credentials,
      DEFAULT_THINKING_AG_SIGNATURE,
      isThinkingOn(model, body),
    );
  }

  const geminiCLI = openaiToGeminiCLIRequest(model, body, stream);
  return wrapInCloudCodeEnvelope(model, geminiCLI, credentials, true);
}

// Register
register(FORMATS.OPENAI, FORMATS.GEMINI, openaiToGeminiRequest, null);
register(
  FORMATS.OPENAI,
  FORMATS.GEMINI_CLI,
  (model, body, stream, credentials) =>
    wrapInCloudCodeEnvelope(model, openaiToGeminiCLIRequest(model, body, stream), credentials),
  null,
);
register(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, openaiToAntigravityRequest, null);
