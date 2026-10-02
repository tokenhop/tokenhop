import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { transformToOllama } from "open-sse/utils/ollamaTransform.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function POST(request) {
  await ensureInitialized();

  let modelName = "llama3.2";
  let upstream = request;
  try {
    const body = await request.clone().json();
    modelName = body.model || "llama3.2";
    // Ollama's API streams by default; the shared chat path now defaults a
    // missing field to false, so make the Ollama default explicit.
    if (body && typeof body === "object" && body.stream === undefined) {
      upstream = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({ ...body, stream: true }),
      });
    }
  } catch {}

  const response = await handleChat(upstream);
  return transformToOllama(response, modelName);
}
