import { AI_PROVIDERS } from "@/shared/constants/providers";
import { resolveGatewayAuth } from "@/lib/auth/gatewayAuth.js";
import { getGatewayConnections } from "@/lib/auth/gatewayResources.js";
import { VOICE_FETCHERS, fetchElevenLabsVoices } from "open-sse/handlers/ttsCore.js";
import { GET as getGenericVoices } from "@/app/api/media-providers/tts/voices/route.js";
import { GET as getElevenLabsVoices } from "@/app/api/media-providers/tts/elevenlabs/voices/route.js";
import { GET as getDeepgramVoices } from "@/app/api/media-providers/tts/deepgram/voices/route.js";
import { GET as getInworldVoices } from "@/app/api/media-providers/tts/inworld/voices/route.js";

// Provider → internal voices handler, called in-process: an HTTP self-fetch
// would hit the login-gated /api/media-providers path without credentials.
// Edge/local-device share the generic handler.
// ponytail: reuses route handlers directly; extract a voices lib if more callers appear.
const PROVIDER_API = {
  elevenlabs: { handler: getElevenLabsVoices, path: "elevenlabs/voices" },
  deepgram: { handler: getDeepgramVoices, path: "deepgram/voices" },
  inworld: { handler: getInworldVoices, path: "inworld/voices" },
  "edge-tts": { handler: getGenericVoices, path: "voices?provider=edge-tts" },
  "local-device": { handler: getGenericVoices, path: "voices?provider=local-device" },
};

const PROVIDERS = Object.keys(PROVIDER_API);

// Gateway principals never inherit dashboard session authority, so the
// login-gated handlers above are legacy-only. Principal path fetches voices
// with the principal's own workspace connection credential — never another
// workspace's, never a global fallback.
const CREDENTIALED_PROVIDERS = new Set(["elevenlabs", "deepgram", "inworld"]);

// Providers where the canonical TTS model identity encodes the voice id:
// elevenlabs adapter synthesizes with voiceId = model (elevenlabs.js:28),
// edge-tts providerModels list voice ids as models, deepgram's voices
// endpoint returns tts models (canonical_name), local-device passes the
// model straight to the synthesizer as the voice. For these, a scoped key
// filters the catalog to entries it could actually synthesize. Inworld's
// voices (voiceId) are distinct from its ttsConfig models, so its catalog
// is only provider-gated, never per-voice filtered.
const VOICE_ID_IS_MODEL = new Set(["elevenlabs", "deepgram", "edge-tts", "local-device"]);

const langNames = new Intl.DisplayNames(["en"], { type: "language" });
function langName(code) {
  try {
    return langNames.of(code);
  } catch {
    return code;
  }
}

function newGroup(code) {
  return { code, name: langName(code), voices: [] };
}

function addToLang(byLang, code, voice) {
  const group = (byLang[code] ||= newGroup(code));
  if (!group.voices.find((v) => v.id === voice.id)) group.voices.push(voice);
}

async function fetchUpstream(url, headers, label) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${label} API ${res.status}: ${text || "Failed"}`);
  }
  return res.json();
}

// Per-provider raw fetch → byLang groups (same shapes as the dashboard
// handlers, minus the session-scoped connection lookup).
async function principalVoicesByLang(provider, apiKey) {
  const byLang = {};
  if (provider === "elevenlabs") {
    const voices = await fetchElevenLabsVoices(apiKey);
    for (const v of voices) {
      const voice = (code) => ({
        id: v.voice_id,
        name: v.name,
        gender: v.labels?.gender || "",
        lang: code,
        free_users_allowed: v.category === "premade" || v.is_owner === true,
      });
      const primaryLang = v.labels?.language || "en";
      addToLang(byLang, primaryLang, voice(primaryLang));
      for (const vl of v.verified_languages || []) {
        if (vl.language && vl.language !== primaryLang)
          addToLang(byLang, vl.language, voice(vl.language));
      }
    }
    return byLang;
  }
  if (provider === "deepgram") {
    const data = await fetchUpstream(
      "https://api.deepgram.com/v1/models",
      {
        Authorization: `Token ${apiKey}`,
      },
      "Deepgram",
    );
    for (const m of data.tts || []) {
      const langs =
        Array.isArray(m.languages) && m.languages.length
          ? m.languages
          : [m.canonical_name?.split("-").pop() || "en"];
      const voiceId = m.canonical_name || m.name;
      for (const code of langs) {
        addToLang(byLang, code, {
          id: voiceId,
          name: m.name || voiceId,
          gender: m.metadata?.tags?.find((t) => t === "masculine" || t === "feminine") || "",
          lang: code,
        });
      }
    }
    return byLang;
  }
  if (provider === "inworld") {
    const data = await fetchUpstream(
      "https://api.inworld.ai/tts/v1/voices",
      {
        Authorization: `Basic ${apiKey}`,
      },
      "Inworld",
    );
    for (const v of data.voices || []) {
      const langs = Array.isArray(v.languages) && v.languages.length ? v.languages : ["en"];
      for (const code of langs) {
        addToLang(byLang, code, {
          id: v.voiceId,
          name: v.displayName || v.voiceId,
          gender: v.gender || "",
          lang: code,
        });
      }
    }
    return byLang;
  }
  // edge-tts / local-device: credential-free device/public catalog fetchers.
  const fetcher = VOICE_FETCHERS[provider];
  const raw = await fetcher();
  const voices = raw.map((v) =>
    provider === "local-device"
      ? { id: v.id, name: v.name, lang: v.lang, gender: v.gender }
      : {
          id: v.ShortName,
          name: (v.FriendlyName || v.ShortName)
            .replace("Microsoft ", "")
            .replace(/ Online \(Natural\) - /g, " ("),
          lang: v.Locale.split("-")[0],
          gender: v.Gender,
        },
  );
  for (const v of voices) addToLang(byLang, v.lang, v);
  return byLang;
}

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}

// GET /v1/audio/voices?provider={p}[&lang=xx]
// Returns OpenAI-style list with each voice's full model id ready for /v1/audio/speech
export async function GET(request) {
  const auth = await resolveGatewayAuth(request);
  if (auth instanceof Response) return auth;
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const lang = searchParams.get("lang");

    if (!provider || !PROVIDER_API[provider]) {
      return Response.json(
        {
          error: {
            message: `provider must be one of: ${PROVIDERS.join(", ")}`,
            type: "invalid_request_error",
          },
        },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    let rawVoices;
    if (auth.legacy) {
      // Legacy storage: exact prior behavior — in-process dashboard delegation.
      const { handler, path } = PROVIDER_API[provider];
      const origin = new URL(request.url).origin;
      const baseUrl = `${origin}/api/media-providers/tts/${path}`;
      const url = lang
        ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}lang=${encodeURIComponent(lang)}`
        : baseUrl;
      const res = await handler(new Request(url));
      const data = await res.json();
      if (!res.ok || data.error) {
        return Response.json(
          { error: { message: data.error || `Upstream ${res.status}`, type: "server_error" } },
          { status: res.status, headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }
      rawVoices = lang
        ? data.voices || []
        : Object.values(data.byLang || {}).flatMap((l) => l.voices || []);
    } else {
      const principal = auth.principal;
      // Allowlist gate before any upstream fetch or catalog disclosure: a key
      // scoped to unrelated providers/models must not fetch (or see) this
      // provider's voice catalog. Empty scope = unrestricted.
      const allowedModels = principal?.scopes?.allowedModels;
      const scoped = Array.isArray(allowedModels) && allowedModels.length > 0;
      const prefix = `${provider}/`;
      if (scoped && !allowedModels.some((m) => typeof m === "string" && m.startsWith(prefix))) {
        return Response.json(
          { error: { message: "Forbidden", type: "invalid_request_error" } },
          { status: 403, headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }
      const connections = await getGatewayConnections(principal, {
        provider,
        isActive: true,
      });
      const apiKey = connections.find((c) => c.apiKey)?.apiKey;
      if (CREDENTIALED_PROVIDERS.has(provider) && !apiKey) {
        return Response.json(
          {
            error: {
              message: `No ${AI_PROVIDERS[provider]?.name || provider} connection found`,
              type: "server_error",
            },
          },
          { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }
      const byLang = await principalVoicesByLang(provider, apiKey);
      rawVoices = lang
        ? byLang[lang]?.voices || []
        : Object.values(byLang).flatMap((l) => l.voices);
      // Where the canonical model identity encodes the voice id, a scoped key
      // only sees the voices it could synthesize under its allowedModels.
      if (scoped && VOICE_ID_IS_MODEL.has(provider)) {
        const allowedSet = new Set(allowedModels);
        rawVoices = rawVoices.filter((v) => allowedSet.has(`${provider}/${v.id}`));
      }
    }

    // Use provider alias for /v1/audio/speech model param (matches skill convention e.g. el/, dg/, edge-tts/)
    const alias = AI_PROVIDERS[provider]?.alias || provider;
    const data_out = rawVoices.map((v) => ({
      id: v.id,
      name: v.name,
      lang: v.lang || "",
      gender: v.gender || "",
      model: `${alias}/${v.id}`,
    }));

    return Response.json(
      { object: "list", data: data_out },
      {
        headers: { "Access-Control-Allow-Origin": "*" },
      },
    );
  } catch (err) {
    return Response.json(
      { error: { message: err.message || "Failed", type: "server_error" } },
      { status: 502, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
}
