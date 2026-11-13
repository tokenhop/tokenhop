import { handleChat } from "@/sse/handlers/chat.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { errorResponse } from "open-sse/utils/error.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /v1/responses/compact - Compact conversation context
 * Reuses the same handleChat pipeline, signals compact via body._compact
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  body._compact = true;
  const newRequest = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(body),
  });
  return await handleChat(newRequest);
}
