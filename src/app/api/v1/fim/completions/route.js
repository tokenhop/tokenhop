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
 * POST /v1/fim/completions - Mistral Codestral FIM format
 * Handled by translator pattern (codestral-fim format auto-detected)
 */
export async function POST(request) {
  return await handleChat(request);
}
