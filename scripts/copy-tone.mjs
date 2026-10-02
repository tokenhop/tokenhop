/**
 * Design-system §9 copy-tone detector: sentence case, no exclamation marks
 * outside the one allowed success toast, no emoji in UI copy.
 *
 * Used by tests/unit/copy-tone.test.js (guard) and by the YAN-414 sweep.
 * Pure functions over the literal list produced by scripts/i18n-literals.mjs.
 */
import { createRequire } from "node:module";

const { BRAND_IDS } = createRequire(import.meta.url)("../src/shared/brand/index.cjs");

/** The one success toast allowed an exclamation mark (§9; YAN-408). */
export const SUCCESS_TOAST_RE = new RegExp(
  `^You've saved .+ tokens with (${BRAND_IDS.join("|")})!$`,
);

/**
 * Words that stay capitalized mid-sentence because they are product, provider,
 * model or brand names (single words; multi-word names live in PROPER_PHRASES).
 */
export const PROPER_WORDS = new Set([
  // 9router products and features
  "9Router",
  "9router",
  "9Remote",
  "PxPipe",
  "PXPIPE",
  "RTK",
  "Headroom",
  // Providers and models
  "OpenAI",
  "Anthropic",
  "Claude",
  "Gemini",
  "Codex",
  "Qwen",
  "Kimi",
  "DeepSeek",
  "Grok",
  "Copilot",
  "Ollama",
  "GLM",
  "MiMo",
  "Xiaomi",
  "MiniMax",
  "Kiro",
  "iFlow",
  "OpenRouter",
  "Cohere",
  "Mistral",
  "Voyage",
  "Jina",
  "Firecrawl",
  "Tavily",
  "Exa",
  "Brave",
  "Serper",
  "SearXNG",
  "Google",
  "You.com",
  "Deepgram",
  "ElevenLabs",
  "AssemblyAI",
  "Whisper",
  "Groq",
  "DALL-E",
  "Imagen",
  "FLUX",
  "SDWebUI",
  "ComfyUI",
  "Recraft",
  "Ideogram",
  "Runway",
  "Sora",
  "Veo",
  "Seedance",
  "SambaNova",
  "Cerebras",
  "Hyperbolic",
  "SiliconFlow",
  "Volcengine",
  "Tencent",
  "Baidu",
  "Alibaba",
  "Doubao",
  "NVIDIA",
  "NIM",
  "Featherless",
  "Nomic",
  "Linkup",
  "Pollinations",
  "Chutes",
  "Blackbox",
  "Venice",
  "Perplexity",
  "Sonar",
  "Llama",
  "Nemotron",
  "Ling",
  "Luna",
  "Maverick",
  "AI21",
  "Coqui",
  "Cartesia",
  "Inworld",
  "PlayHT",
  "Kokoro",
  "Parakeet",
  "Fable",
  "Orpheus",
  "Qwen3",
  "GLM-4",
  "Hunyuan",
  "Spark",
  "Ernie",
  "Abab",
  "Step",
  "Moonshot",
  "Zhipu",
  "Yi",
  "Baichuan",
  "SenseNova",
  "MiniCPM",
  "InternLM",
  "Qianfan",
  "Ark",
  "BytePlus",
  "ModelArk",
  "Bedrock",
  "Vertex",
  "Azure",
  "AWS",
  "Cloudflare",
  "Workers",
  "Deno",
  "Deploy",
  "Vercel",
  "Tailscale",
  "Docker",
  "Python",
  "Homebrew",
  "Nix",
  // Auth / IdP products
  "Keycloak",
  "Authentik",
  "Microsoft",
  "Entra",
  "Okta",
  "Auth0",
  "SAML",
  // CLI tools, editors and agent products
  "GitHub",
  "GitLab",
  "Duo",
  "Cline",
  "RooCode",
  "Aider",
  "Cursor",
  "Continue",
  "Amp",
  "Sourcegraph",
  "Devin",
  "Cognition",
  "Windsurf",
  "Zed",
  "Antigravity",
  "OpenCode",
  "OpenDesign",
  "Chrome",
  "DevTools",
  "Firefox",
  "Edge",
  "Safari",
  "CLIProxyAPI",
  "Hermes",
  "Kilo",
  "Claw",
  "Nous",
  "Trae",
  "CodeBuddy",
  "Augment",
  "Jules",
  "Replit",
  "Warp",
  "Zencoder",
  "Void",
  "PearAI",
  // OS / platform names
  "Windows",
  "macOS",
  "Linux",
  "Mac",
  "Unix",
  "Ubuntu",
  "Debian",
  "Fedora",
  "iOS",
  "Android",
  "PowerShell",
  "Bash",
  "Zsh",
  "WSL",
  // Misc brands
  "Twitter",
  "Notion",
  "Slack",
  "Discord",
  "Telegram",
  "Linear",
  "Jira",
  "Figma",
  "Sentry",
  "Datadog",
  "Grafana",
  "Stripe",
  "PayPal",
  "Patreon",
  "Ko-fi",
  "Buy",
  "Coffee", // "Buy Me a Coffee" parts
  "Cowork",
  "Rust",
  "SQLite",
  "BXAuth", // branded feature/tech/identifier names
  // Languages, nationalities and platforms
  "JavaScript",
  "Chinese",
  "British",
  "American",
  "English",
  "Japanese",
  // RTK compression levels and Tailscale product names
  "Ponytail",
  "Caveman",
  "Funnel",
  // Agent harness names used bare
  "Roo",
]);

/**
 * Multi-word product/feature names whose later words stay capitalized when
 * the phrase appears verbatim in the literal (matched case-sensitively).
 */
export const PROPER_PHRASES = new Set([
  "Claude Code",
  "Claude Desktop",
  "Claude Cowork",
  "Codex CLI",
  "OpenAI Codex",
  "Gemini CLI",
  "Qwen Code",
  "Kilo Code",
  "Roo Code",
  "Open Claw",
  "Factory Droid",
  "Hermes Agent",
  "Grok Build",
  "Grok CLI",
  "VS Code",
  "Cursor IDE",
  "Kiro IDE",
  "MiMo Desktop",
  "Xiaomi MiMo",
  "Copilot Chat",
  "GitHub Copilot",
  "GitLab Duo",
  "Devin CLI",
  "Chat Completions",
  "Responses API",
  "Messages API",
  "AWS Builder ID",
  "AWS IAM Identity Center",
  "Microsoft Entra",
  "Azure AD",
  "Voyage AI",
  "Kiro AI",
  "iFlow AI",
  "Nous Research",
  "Cloudflare Worker",
  "Cloudflare Workers",
  "Cloudflare Relay",
  "Deno Deploy",
  "Vercel Relay",
  "Cloudflare Tunnel",
  "Tailscale Funnel",
  "Browser MCP",
  "MCP Marketplace",
  "Google PSE",
  "Buy Me a Coffee",
  "Black Forest Labs",
  "Hugging Face",
  "Grok Imagine",
  "Cursor Pro",
  "Identity Center",
  "Claude Desktop Cowork",
  "Token saver",
  "Proxy pools",
]);

/**
 * Canonical navigation and settings-section labels (from
 * src/shared/constants/navigation.js and the settings registry). References to
 * these surfaces cite the label verbatim, so the words stay capitalized.
 */
export const CANONICAL_LABELS = new Set([
  "Home",
  "Providers",
  "Combos",
  "Usage",
  "Quota",
  "Settings",
  "Network",
  "Observability",
  "Routing",
  "Reliability",
  "Pricing",
  "General",
  "Security",
  "System",
  "Account",
  "Traffic",
  "Translator",
  "Skills",
  "Watch",
  "Tune",
  "Debug",
  "Route",
  "Embedding",
  "Video",
  "Music",
]);

/** Words allowed capitalized anywhere (pronouns, affirmations, units). */
const ALWAYS_OK = new Set(["I", "OK"]);

/** All-caps acronyms (API, URL, JSON, ID, DNS, TTL, SSO, JWT, HTTPS, …). */
const ACRONYM_RE = /^[A-Z0-9][A-Z0-9.]{1,7}s?$/;
/** Mixed-case acronyms and identifier-ish words that keep their casing. */
const MIXED_ACRONYMS = new Set([
  "OAuth",
  "OAuth2",
  "IdP",
  "iDP",
  "OpenID",
  "X.509",
  "PKCE",
  "TTFT",
  "macOS",
  "iOS",
  "tvOS",
  "watchOS",
  "GitOps",
  "DevOps",
  "MCPs",
  "APIs",
  "URLs",
  "IDs",
  "LLMs",
  "CLIs",
  "TUIs",
  "IDEs",
  "SDKs",
  "CDNs",
  "ACLs",
  "VMs",
  "env",
]);

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]|\u{FE0F}/u;

/** Strip one layer of surrounding punctuation/quotes from a token. */
function core(token) {
  return token.replace(/^[\s"'“”‘’`([{<¡¿—–-]+|[\s"'“”‘’`)\]}>!?,;:—–-]+$/g, "");
}

/**
 * Split a literal into segments at sentence/phrase boundaries. The first word
 * of each segment may be capitalized (sentence case); later words may not,
 * unless they are allowed.
 */
function segmentsOf(literal) {
  // Split on . ! ? … : ; — → / ( ) [ ] " ' when followed by whitespace or end,
  // and on " vs. " style spaced separators. Periods inside words (console.x.ai)
  // do not split because they are not followed by whitespace.
  return literal.split(/[.!?…:;—/()[\]"“”‘’]\s+|[.!?…:;—/()[\]"“”‘’]$|\s+→\s+/);
}

function isAllowedWord(word, literal) {
  if (!word) return true;
  if (ALWAYS_OK.has(word)) return true;
  if (ACRONYM_RE.test(word)) return true;
  if (MIXED_ACRONYMS.has(word)) return true;
  const bare = word.replace(/['’]s$/, "");
  if (PROPER_WORDS.has(word) || PROPER_WORDS.has(bare)) return true;
  if (CANONICAL_LABELS.has(word) || CANONICAL_LABELS.has(bare)) return true;
  // Identifiers: words containing digits, dots or slashes (gpt-4o, console.x.ai)
  if (/[\d./]/.test(word)) return true;
  // Env-var / key style: camelCase or snake_case handled by extractor already.
  // Part of a proper phrase present in the literal?
  for (const phrase of PROPER_PHRASES) {
    if (phrase.includes(word) && literal.includes(phrase)) return true;
  }
  return false;
}

/**
 * Title Case violations: mid-segment words capitalized without cause.
 * @param {string[]} literals
 * @returns {Array<{literal: string, word: string}>}
 */
export function titleCaseViolations(literals) {
  const out = [];
  for (const literal of literals) {
    for (const segment of segmentsOf(literal)) {
      const tokens = segment.split(/\s+/).map(core).filter(Boolean);
      let seenWord = false;
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!/\p{L}/u.test(token)) continue; // "+", "·", "1" — not words
        if (!seenWord) {
          seenWord = true;
          continue; // first word of a segment may be capitalized
        }
        // Keyboard shortcuts and symbol-heavy tokens are not prose.
        if (/[^-\p{L}\p{N}'’]/u.test(token)) continue;
        // Hyphenated tokens: each part after the first must be lowercase.
        const parts = token.split("-");
        if (parts.every((part) => /^[A-Z0-9.]+$/.test(part))) continue; // DALL-E
        for (const part of parts.slice(1)) {
          if (!/^[A-Z]/.test(part)) continue;
          if (isAllowedWord(part, literal)) continue;
          out.push({ literal, word: token });
        }
        if (!/^[A-Z]/.test(token)) continue;
        if (isAllowedWord(token, literal)) continue;
        // Skip hyphen tokens already reported above to avoid duplicates.
        if (parts.length > 1) continue;
        out.push({ literal, word: token });
      }
    }
  }
  return out;
}

/**
 * Exclamation violations: "!" outside the one allowed success toast.
 * @param {string[]} literals
 * @returns {string[]}
 */
export function exclamationViolations(literals) {
  return literals.filter((l) => l.includes("!") && !SUCCESS_TOAST_RE.test(l));
}

/**
 * Emoji violations: emoji characters in UI copy (icons must be Material
 * Symbols, never emoji).
 * @param {string[]} literals
 * @returns {string[]}
 */
export function emojiViolations(literals) {
  return literals.filter((l) => EMOJI_RE.test(l));
}

/**
 * All §9 violations in one pass.
 * @param {string[]} literals
 * @returns {{titleCase: Array<{literal: string, word: string}>, exclamation: string[], emoji: string[]}}
 */
export function findCopyToneViolations(literals) {
  return {
    titleCase: titleCaseViolations(literals),
    exclamation: exclamationViolations(literals),
    emoji: emojiViolations(literals),
  };
}
