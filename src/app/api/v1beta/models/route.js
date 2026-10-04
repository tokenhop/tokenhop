import { PROVIDER_MODELS } from "@/shared/constants/models";
import { resolveGatewayAuth } from "@/lib/auth/gatewayAuth.js";
import { requireClientApiKey } from "@/lib/auth/requireClientApiKey";
import { buildModelsList } from "../../v1/models/route.js";

const GEMINI_PREFIX = "gemini/";
const CHAT_METHODS = ["generateContent", "streamGenerateContent", "countTokens"];

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

function getGeminiTtsModelIds() {
  return [
    ...(PROVIDER_MODELS.gemini || []).filter((m) => (m.kind || m.type) === "tts"),
    ...(PROVIDER_MODELS["gemini-tts-models"] || []),
  ].map((m) => m.id);
}

/**
 * GET /v1beta/models - Gemini compatible models list.
 * Same routable LLM set as /v1/models (active connections, no disabled or
 * non-chat models), in Gemini API format.
 */
export async function GET(request) {
  const denied = await requireClientApiKey(request);
  if (denied) return denied;
  // Best-effort principal (same rationale as /v1/models: gate already enforced).
  let principal = null;
  try {
    const auth = await resolveGatewayAuth(request);
    if (!(auth instanceof Response) && !auth?.legacy) principal = auth?.principal || null;
  } catch {
    principal = null;
  }
  try {
    const models = [];
    const seen = new Set();

    function addModel(name, description, methods, entry = {}) {
      if (seen.has(name)) return;
      seen.add(name);
      models.push({
        name,
        displayName: name.slice("models/".length),
        description,
        supportedGenerationMethods: methods,
        inputTokenLimit: entry.context_length || 128000,
        outputTokenLimit: entry.max_completion_tokens || 8192,
      });
    }

    let hasGemini = false;
    const llmEntries = principal
      ? await buildModelsList(["llm"], { principal })
      : await buildModelsList(["llm"]);
    for (const entry of llmEntries) {
      const description = `${entry.owned_by} model: ${entry.id}`;
      addModel(`models/${entry.id}`, description, CHAT_METHODS, entry);
      // ponytail: keyed on the default "gemini/" alias; a Gemini connection with
      // a custom prefix still routes but gets no bare/TTS aliases listed.
      if (entry.id.startsWith(GEMINI_PREFIX)) {
        hasGemini = true;
        // Gemini SDKs address models by their bare Google name.
        addModel(
          `models/${entry.id.slice(GEMINI_PREFIX.length)}`,
          description,
          CHAT_METHODS,
          entry,
        );
      }
    }

    // Native Gemini TTS passthrough (generateContent with AUDIO modality).
    if (hasGemini) {
      for (const id of getGeminiTtsModelIds()) {
        addModel(`models/${id}`, `Gemini TTS model: ${id}`, ["generateContent"]);
      }
    }

    return Response.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}
