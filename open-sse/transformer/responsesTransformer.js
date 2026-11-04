/**
 * Responses API Transformer
 * Converts OpenAI Chat Completions SSE to Codex Responses API SSE format
 * Can be used in both Next.js and Cloudflare Workers
 */

import fs from "fs";
import path from "path";
import { FORMATS } from "../translator/formats.js";
import { initState } from "../translator/index.js";
import { openaiToOpenAIResponsesResponse } from "../translator/response/openai-responses.js";

// Create log directory for responses (Node.js only)
export function createResponsesLogger(model, logsDir = null) {
  // Skip logging in worker environment (no fs)
  if (typeof fs.mkdirSync !== "function") {
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const uniqueId = Math.random().toString(36).slice(2, 8);
  const baseDir = logsDir || (typeof process !== "undefined" ? process.cwd() : ".");
  const logDir = path.join(baseDir, "logs", `responses_${model}_${timestamp}_${uniqueId}`);

  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    return null;
  }

  const inputEvents = [];
  const outputEvents = [];

  return {
    logInput: (event) => {
      inputEvents.push(event);
    },
    logOutput: (event) => {
      outputEvents.push(event);
    },
    flush: () => {
      try {
        fs.writeFileSync(path.join(logDir, "1_input_stream.txt"), inputEvents.join("\n"));
        fs.writeFileSync(path.join(logDir, "2_output_stream.txt"), outputEvents.join("\n"));
      } catch (e) {
        console.log("[RESPONSES] Failed to write logs:", e.message);
      }
    },
  };
}

/**
 * Create TransformStream that converts Chat Completions SSE to Responses API SSE.
 * Event building is delegated to the registered openai → openai-responses
 * translator so this path and chatCore streaming emit the same events
 * (output indexes, refusal parts, incomplete terminal, output[]/usage).
 * @param {Object} logger - Optional logger instance
 * @returns {TransformStream}
 */
export function createResponsesApiTransformStream(logger = null) {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  const enqueue = (controller, events) => {
    for (const { event, data } of events) {
      const output = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      logger?.logOutput(output.trim());
      controller.enqueue(encoder.encode(output));
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      logger?.logInput(text.trim());
      buffer += text;

      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        const dataMatch = msg.match(/^data:\s*(.+)$/m);
        if (!dataMatch) continue;

        const dataStr = dataMatch[1].trim();
        if (dataStr === "[DONE]") continue;

        let parsed;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }
        enqueue(controller, openaiToOpenAIResponsesResponse(parsed, state));
      }
    },

    flush(controller) {
      enqueue(controller, openaiToOpenAIResponsesResponse(null, state));

      logger?.logOutput("data: [DONE]");
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      logger?.flush();
    },
  });
}
