// Agent Skills metadata — single source of truth for /dashboard/skills page.
// Skills ship with the gateway, so the hosted URLs always resolve against the
// selected access base (Local/Tunnel/Tailscale) plus SKILL_PATH.

const REPO = "yandy-r/9router";
const BRANCH = "master";
const SKILL_PATH = "skills";

export const SKILLS_REPO_URL = `https://github.com/${REPO}`;
export const SKILLS_RAW_BASE = `https://raw.githubusercontent.com/${REPO}/refs/heads/${BRANCH}/${SKILL_PATH}`;
export const SKILLS_BLOB_BASE = `https://github.com/${REPO}/blob/${BRANCH}/${SKILL_PATH}`;

/**
 * Validate/normalize a gateway base (origin only: scheme + host + optional
 * port). Rejects non-http(s) schemes, embedded credentials/paths/queries and
 * unknown skill ids so copied links can never point at javascript: or
 * traversal targets.
 * @param {string} base
 * @param {string} id
 * @returns {string} Skill URL hosted on the gateway: <base>/skills/<id>/SKILL.md
 */
export function getHostedSkillUrl(base, id) {
  const skill = SKILLS.find((entry) => entry.id === id);
  if (!skill) throw new Error(`Unknown skill: ${id}`);
  const text = typeof base === "string" ? base.trim() : "";
  if (!text || text.length > 256) throw new Error("Invalid skill base URL");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("Invalid skill base URL");
  }
  const proto = parsed.protocol.toLowerCase();
  if (proto !== "http:" && proto !== "https:") throw new Error("Invalid skill base URL");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Invalid skill base URL");
  }
  if (!/^\/+$/u.test(parsed.pathname)) throw new Error("Invalid skill base URL");
  return `${parsed.origin}/skills/${id}/SKILL.md`;
}

/**
 * Skill bases shown in the hero segmented control. Local always; tunnel and
 * tailscale only when enabled with a real URL (mirrors the endpoint page,
 * which prefers the tunnel public URL). Pure for unit tests.
 * @param {string} localOrigin e.g. window.location.origin
 * @param {{ tunnel?: object, tailscale?: object }} status GET /api/tunnel/status payload
 * @returns {Array<{ value: string, label: string, url: string }>}
 */
export function getAvailableSkillBases(localOrigin, status = {}) {
  const bases = [{ value: "local", label: "Local", url: normalizeOrigin(localOrigin) }];
  const tunnelUrl = status?.tunnel?.publicUrl || status?.tunnel?.tunnelUrl || "";
  if (isBaseEnabled(status?.tunnel) && isHttpUrl(tunnelUrl)) {
    bases.push({ value: "tunnel", label: "Tunnel", url: normalizeOrigin(tunnelUrl) });
  }
  const tailscaleUrl = status?.tailscale?.tunnelUrl || "";
  if (isBaseEnabled(status?.tailscale) && isHttpUrl(tailscaleUrl)) {
    bases.push({ value: "tailscale", label: "Tailscale", url: normalizeOrigin(tailscaleUrl) });
  }
  return bases;
}

function isBaseEnabled(entry) {
  return entry?.settingsEnabled === true || entry?.enabled === true;
}

function isHttpUrl(text) {
  if (typeof text !== "string") return false;
  try {
    const parsed = new URL(text.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeOrigin(text) {
  try {
    return new URL(String(text).trim()).origin;
  } catch {
    return "";
  }
}

export const SKILLS = [
  {
    id: "9router",
    name: "9Router (Entry)",
    description:
      "Setup + index of all capabilities. Start here — covers base URL, auth, model discovery, and links to every capability skill.",
    endpoint: null,
    icon: "hub",
    isEntry: true,
    path: "9router/SKILL.md",
  },
  {
    id: "9router-chat",
    name: "Chat",
    description: "Chat / code-gen via OpenAI or Anthropic format with streaming.",
    endpoint: "/v1/chat/completions",
    icon: "chat",
    path: "9router-chat/SKILL.md",
  },
  {
    id: "9router-image",
    name: "Image Generation",
    description: "Text-to-image via DALL-E, Imagen, FLUX, MiniMax, SDWebUI…",
    endpoint: "/v1/images/generations",
    icon: "image",
    path: "9router-image/SKILL.md",
  },
  {
    id: "9router-tts",
    name: "Text-to-Speech",
    description: "OpenAI / ElevenLabs / Edge / Google / Deepgram voices.",
    endpoint: "/v1/audio/speech",
    icon: "record_voice_over",
    path: "9router-tts/SKILL.md",
  },
  {
    id: "9router-stt",
    name: "Speech-to-Text",
    description: "Transcribe audio via OpenAI Whisper, Groq, Gemini, Deepgram, AssemblyAI…",
    endpoint: "/v1/audio/transcriptions",
    icon: "mic",
    path: "9router-stt/SKILL.md",
  },
  {
    id: "9router-embeddings",
    name: "Embeddings",
    description: "Vectors for RAG / semantic search via OpenAI, Gemini, Mistral…",
    endpoint: "/v1/embeddings",
    icon: "scatter_plot",
    path: "9router-embeddings/SKILL.md",
  },
  {
    id: "9router-video",
    name: "Video Generation",
    description: "Text-to-video via xAI Grok Imagine and other video providers.",
    endpoint: "/v1/videos/generations",
    icon: "movie",
    path: "9router-video/SKILL.md",
  },
  {
    id: "9router-web-search",
    name: "Web Search",
    description:
      "Web and X search via Tavily / Exa / Brave / Serper / SearXNG / Google PSE / You.com / Xquik.",
    endpoint: "/v1/search",
    icon: "search",
    path: "9router-web-search/SKILL.md",
  },
  {
    id: "9router-web-fetch",
    name: "Web Fetch",
    description: "URL → markdown / text / HTML via Firecrawl, Jina, Tavily, Exa.",
    endpoint: "/v1/web/fetch",
    icon: "language",
    path: "9router-web-fetch/SKILL.md",
  },
];

/**
 * Legacy helpers kept for compatibility: raw/blob GitHub URLs used by the
 * open-in-new-tab links and docs. Prefer getHostedSkillUrl for copyable links.
 * @param {string} id Skill id, e.g. "9router-chat".
 * @returns {string} Raw GitHub URL for the skill's SKILL.md.
 */
export function getSkillRawUrl(id) {
  return `${SKILLS_RAW_BASE}/${id}/SKILL.md`;
}

/**
 * Blob (human-readable GitHub page) URL for a skill.
 * @param {string} id Skill id, e.g. "9router-chat".
 * @returns {string} GitHub blob URL for the skill's SKILL.md.
 */
export function getSkillBlobUrl(id) {
  return `${SKILLS_BLOB_BASE}/${id}/SKILL.md`;
}
