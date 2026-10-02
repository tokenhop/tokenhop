// Agent Skills metadata — single source of truth for /dashboard/skills page.
// Skills ship with the gateway, so the hosted URLs always resolve against the
// selected access base (Local/Tunnel/Tailscale) plus SKILL_PATH. Skill ids
// carry the active brand's slug (skills/9router* or skills/tokenhop*).
import { ACTIVE, BRAND, LEGACY } from "@/shared/brand";

const REPO = ACTIVE.repoSlug;
const BRANCH = "master";
const SKILL_PATH = "skills";

export const SKILLS_REPO_URL = `https://github.com/${REPO}`;
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

/** Id of the entry skill: the active brand's slug. */
export const ENTRY_SKILL_ID = ACTIVE.slug;

export const SKILLS = [
  {
    suffix: "",
    name: `${ENTRY_SKILL_ID} entry skill`,
    description:
      "Setup + index of all capabilities. Start here — covers base URL, auth, model discovery, and links to every capability skill.",
    endpoint: null,
    icon: "hub",
    isEntry: true,
  },
  {
    suffix: "-chat",
    name: "Chat",
    description: "Chat / code-gen via OpenAI or Anthropic format with streaming.",
    endpoint: "/v1/chat/completions",
    icon: "chat",
  },
  {
    suffix: "-image",
    name: "Image generation",
    description: "Text-to-image via DALL-E, Imagen, FLUX, MiniMax, SDWebUI…",
    endpoint: "/v1/images/generations",
    icon: "image",
  },
  {
    suffix: "-tts",
    name: "Text to speech",
    description: "OpenAI / ElevenLabs / Edge / Google / Deepgram voices.",
    endpoint: "/v1/audio/speech",
    icon: "record_voice_over",
  },
  {
    suffix: "-stt",
    name: "Speech to text",
    description: "Transcribe audio via OpenAI Whisper, Groq, Gemini, Deepgram, AssemblyAI…",
    endpoint: "/v1/audio/transcriptions",
    icon: "mic",
  },
  {
    suffix: "-embeddings",
    name: "Embeddings",
    description: "Vectors for RAG / semantic search via OpenAI, Gemini, Mistral…",
    endpoint: "/v1/embeddings",
    icon: "scatter_plot",
  },
  {
    suffix: "-video",
    name: "Video generation",
    description: "Text-to-video via xAI Grok Imagine and other video providers.",
    endpoint: "/v1/videos/generations",
    icon: "movie",
  },
  {
    suffix: "-web-search",
    name: "Web search",
    description:
      "Web and X search via Tavily / Exa / Brave / Serper / SearXNG / Google PSE / You.com / Xquik.",
    endpoint: "/v1/search",
    icon: "search",
  },
  {
    suffix: "-web-fetch",
    name: "Web fetch",
    description: "URL → markdown / text / HTML via Firecrawl, Jina, Tavily, Exa.",
    endpoint: "/v1/web/fetch",
    icon: "language",
  },
].map((skill) => {
  const id = ENTRY_SKILL_ID + skill.suffix;
  return { ...skill, id, path: `${id}/SKILL.md` };
});

/**
 * Ids the /skills route serves: the active set plus the legacy-brand ids, so
 * agents holding old links keep working on any build.
 */
export const SERVED_SKILL_IDS = new Set([
  ...SKILLS.map((skill) => skill.id),
  ...SKILLS.map((skill) => LEGACY.slug + skill.suffix), // legacy(9router): remove in v2
]);

/**
 * Legacy-brand skill ids. Their SKILL.md files are pointer stubs since YAN-634,
 * so the route serves the tokenhop content under these ids instead, whichever
 * brand is active.
 * legacy(9router): remove in v2
 */
export const LEGACY_SKILL_IDS = new Set(SKILLS.map((skill) => LEGACY.slug + skill.suffix));

/**
 * File served for a skill id: on every brand, legacy ids serve the tokenhop
 * content (their own files are pointer stubs since YAN-634), other ids serve
 * their own file. Pure for unit tests.
 * @param {string} id
 * @returns {string} Path under skills/, e.g. "tokenhop-chat/SKILL.md"
 */
export function getSkillFilePath(id) {
  if (!SERVED_SKILL_IDS.has(id)) throw new Error(`Unknown skill: ${id}`);
  return LEGACY_SKILL_IDS.has(id)
    ? `${BRAND.slug}${id.slice(LEGACY.slug.length)}/SKILL.md`
    : `${id}/SKILL.md`;
}
