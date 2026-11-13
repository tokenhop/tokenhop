import { handleChat } from "@/sse/handlers/chat.js";

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
 * POST /infill (and /v1/infill) - llama.cpp server infill format
 * Handled by translator pattern (llamacpp-infill format auto-detected)
 */
export async function POST(request) {
  return await handleChat(request);
}
