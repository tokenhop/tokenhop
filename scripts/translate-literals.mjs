#!/usr/bin/env node
/**
 * Translate missing UI literals through an OpenAI-compatible /chat/completions
 * endpoint. Config comes from env only — no defaults point at any private host:
 *
 *   TRANSLATE_BASE_URL  e.g. http://localhost:20163/v1 (own local gateway)
 *   TRANSLATE_MODEL     e.g. oc/nemotron-3-ultra-free
 *   TRANSLATE_API_KEY   bearer key for the endpoint
 *
 * Usage:
 *   node scripts/translate-literals.mjs --need /tmp/need.json \
 *     --locales public/i18n/literals --locales-list de,fr \
 *     --cache /tmp/llm-cache.json [--limit N] [--apply] [--delta <file>]
 *
 * Without --apply this is a dry run that only reports counts. --apply writes
 * sorted locale JSON atomically (tmp + rename). --delta writes just the
 * entries this run added ({key: value}, one locale per run) so CI can merge
 * them onto a newer checkout (scripts/i18n-apply-deltas.mjs).
 *
 * Validation per key (a failing key is retried, then reported as failed):
 * - identifiers matching KEEP stay verbatim (key == value)
 * - placeholders ({x}, %s, [x]) must match source and translation
 * - brand/product/provider/model names (BRAND_RE) must appear in the output
 *   when present in the source
 * - responses that are Python-dict reprs ({"text": ...}), empty strings, or
 *   verbatim English echoes for translatable prose are rejected
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { placeholdersOf } from "./lib/i18n-placeholders.mjs";
import { sortByKey, writeJsonAtomic } from "./lib/i18n-json.mjs";

const BATCH_SIZE = 20;
const REQUEST_PAUSE_MS = 1000;
const MAX_RETRIES = 5;

const TARGET_NAMES = {
  ar: "Arabic",
  bn: "Bengali",
  cs: "Czech",
  da: "Danish",
  de: "German",
  el: "Greek",
  es: "Spanish",
  fa: "Persian (Farsi)",
  fi: "Finnish",
  fr: "French",
  he: "Hebrew",
  hi: "Hindi",
  hu: "Hungarian",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  km: "Khmer",
  ko: "Korean",
  nl: "Dutch",
  no: "Norwegian",
  pl: "Polish",
  "pt-BR": "Brazilian Portuguese",
  "pt-PT": "European Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sv: "Swedish",
  th: "Thai",
  tl: "Tagalog",
  tr: "Turkish",
  uk: "Ukrainian",
  ur: "Urdu",
  vi: "Vietnamese",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
};

// Values that must never be translated (kept verbatim as key == value).
// Hyphenated prose like "Auto-detect" stays translatable: the hyphen rule only
// matches model-id shapes (slash, colon, or version digits, e.g. gpt-4, cc/…).
const KEEP =
  /^(9router|tokenhop|9remote|rtk|pxpipe|mcp|api|url|json|cli|sdk|ok|[\w-]+(\/[\w.-]+)+|[\w-]+:[\w-]+|[a-z]+-[a-z]*\d[a-z0-9-]*|\.?env(\s+.*|\s*·.*)?|\/[\w/#.-]+|%( (cached|left|share)|lighter than raw requests)|\d[\d\s\-_:.,/%]*|[^\w\s]{1,3})$/i; // legacy(9router)

// Brand/provider/model names that must survive translation verbatim
// (case-insensitive: translations may fix casing, e.g. "9remote" → "9Remote").
const BRAND_RE =
  /(9[Rr]outer|tokenhop|9[Rr]emote|PxPipe|RTK|OpenAI|Anthropic|Claude|Gemini|Codex|Qwen|Kimi|DeepSeek|Grok|Copilot|Ollama|GLM|MiMo|Keycloak|Authentik|Microsoft Entra|Azure|Cline|RooCode|Aider|Cursor)/gi;

// Glossary: proper nouns / product names / protocol terms that stay English in
// every locale. Only these may be stored with value == key. Kept small and
// explicit: every entry names an industry-standard term, never plain UI prose.
export const VERBATIM_KEYS = new Set([
  "9English",
  "AWS Builder ID",
  "AWS IAM Identity Center",
  "BXAuth=xxx; ...",
  "Browser MCP",
  "CLIProxyAPI Auth JSON",
  "Cloudflare Tunnel",
  "Cloudflare Workers AI",
  "Exa",
  "GitHub",
  "ID",
  "JSON (Base64)",
  "Keycloak / Authentik",
  "MP3 (Binary)",
  "Microsoft Entra ID (Azure AD)",
  "NPM",
  "OAuth",
  "Okta / Auth0",
  "OpenAI Codex CLI",
  "Tailscale",
  "Tailscale Funnel",
  "Tavily",
  "Twitter",
  "UID:",
  "Voyage AI",
  "no_proxy:",
  "voyage",
  "In / cached / cache-write / out",
  "Headroom URL",
  "IDC Start URL",
  "claude",
  "router",
  "email",
  "total",
  "combo",
  "quota",
  "tokens",
  "servers",
  "Claude CLI",
  "Claude Code",
  "Codex CLI",
  "Grok CLI",
  "OpenAI Codex",
  "DNS",
  "Python",
  "SAML 2.0",
  "cURL",
  "OIDC",
  // Provider/product names and protocol/API identifiers.
  "MITM",
  "Docker",
  "Claude",
  "Kimi",
  "MiniMax",
  "OpenRouter",
  "Qwen",
  "Kiro AI",
  "iFlow AI",
  "Cloudflare Relay",
  "Deno Relay",
  "Vercel Relay",
  "cloudflare relay",
  "vercel relay",
  "Anthropic Claude Code CLI",
  "Responses API",
  "Chat Completions",
  "Messages API",
  "MIT License",
  "SSE URL",
  "TTFT:",
  "apiKey",
  "name|apiKey",
  "openid profile email",
  "(Caveman)",
  "(Headroom)",
  "(Ponytail)",
  "(RTK)",
  "PXPIPE",
  // Commands, OS labels and provider lists shown as-is.
  "open http://localhost:9099",
  "→ OpenAI",
  "→ localhost",
  "Windows:",
  "macOS / Linux / Windows:",
  "macOS / Linux:",
  "macOS/Linux:",
  "Tavily / Exa / Brave / Serper / SearXNG / Google PSE / You.com.",
  // Caveman/Ponytail level names and third-party service names.
  "Lite",
  "Full",
  "Ultra",
  "文 Lite",
  "文 Full",
  "文 Ultra",
  "Buy Me a Coffee",
  // Translator debug pipeline notation (format identifiers, not prose).
  "source → openai",
  "target → openai (response)",
  "openai → target + URL + headers",
]);

// All-lowercase slugs (sample ids/placeholders: my-combo, us-east-1). Case-
// sensitive on purpose so "Auto-scroll" stays translatable.
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)+$/;

// A translation that starts like Python repr of a dict/list is never valid UI
// copy — it leaked through when an earlier pipeline accepted malformed output.
// A trimmed translation value must never be serialized data (Python/JSON
// dicts and JSON arrays). Curly-brace plural/placeholder syntax such as
// "{count}" must still pass.
export const REPR_RE = /^\s*(\{\s*["'][\w-]+["']\s*:\s*|\[\s*["'])/;

export function isVerbatim(key) {
  return VERBATIM_KEYS.has(key) || KEEP.test(key) || SLUG_RE.test(key);
}

function brands(text) {
  return [...String(text).matchAll(BRAND_RE)].map((m) => m[0].toLowerCase());
}

function clean(text) {
  const t = String(text ?? "").trim();
  // html.unescape equivalent for the entities LLM responses actually contain.
  return t
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function validateTranslation(key, out) {
  if (!out || !out.trim()) return "empty";
  if (REPR_RE.test(out.trim())) return "repr-garbage";
  if (placeholdersOf(key).join("|") !== placeholdersOf(out).join("|")) return "placeholder-drift";
  const missing = brands(key).filter((b) => !brands(out).includes(b));
  if (missing.length > 0) return `brand-loss: ${missing.join(",")}`;
  if (out === key && /[a-zA-Z]{3,}/.test(key) && !isVerbatim(key)) return "echo";
  return null;
}

async function callLlm(cfg, langName, items) {
  const numbered = items.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const prompt =
    `Translate the following ${items.length} UI strings from English to ${langName}. ` +
    "Return ONLY a JSON array of translated strings in the same order, no other text.\n" +
    "Rules:\n" +
    "- Preserve placeholders like {count}, %s, [code] EXACTLY as-is.\n" +
    "- Do NOT translate product/brand/provider/model names: 9Router, tokenhop (always lowercase), 9Remote, RTK, " + // legacy(9router)
    "PxPipe, OpenAI, Anthropic, Claude, Gemini, Codex, Qwen, Kimi, GLM, DeepSeek, " +
    "Grok, Copilot, Ollama, MiMo, MCP.\n" +
    "- Do NOT translate URLs, file paths, env vars, model ids or code tokens.\n" +
    "- Keep the tone: short dashboard UI labels, sentence case.\n" +
    "- Translate every ordinary label, including short nouns and adjectives. Only pure identifiers, URLs, paths, model ids and the listed product/brand names may stay unchanged.\n" +
    "- Never echo an ordinary English label unchanged.\n" +
    `Strings:\n${numbered}`;

  const body = JSON.stringify({
    model: cfg.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 6000,
    stream: false,
  });

  let last = "no-attempt";
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const resp = await fetch(cfg.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.key}`,
        },
        body,
        signal: AbortSignal.timeout(300_000),
      });
      if (!resp.ok) {
        last = `http ${resp.status}`;
        if (resp.status === 429) {
          await new Promise((r) => setTimeout(r, 20_000 * (attempt + 1)));
          continue;
        }
        await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
        continue;
      }
      const data = await resp.json();
      if (!Array.isArray(data?.choices)) {
        last = "api-error: no choices";
        await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
        continue;
      }
      let content = String(data.choices[0]?.message?.content ?? "").trim();
      if (content.startsWith("```")) {
        content = content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
      }
      let out;
      try {
        out = JSON.parse(content);
      } catch {
        last = "invalid-json";
        await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
        continue;
      }
      if (
        !Array.isArray(out) ||
        out.length !== items.length ||
        out.some((v) => typeof v !== "string")
      ) {
        last = `shape: expected ${items.length} strings`;
        await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
        continue;
      }
      return out.map(clean);
    } catch (exc) {
      last = String(exc).slice(0, 150);
      await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
    }
  }
  console.log(`  batch failed: ${last}`);
  return null;
}

function parseCliArgs(args) {
  const { values } = parseArgs({
    args,
    options: {
      need: { type: "string" },
      locales: { type: "string" },
      "locales-list": { type: "string" },
      cache: { type: "string" },
      limit: { type: "string" },
      apply: { type: "boolean", default: false },
      delta: { type: "string" },
    },
  });
  return {
    need: values.need ?? null,
    locales: values.locales ?? null,
    localesList: values["locales-list"] ?? null,
    cache: values.cache ?? null,
    limit: Number.parseInt(values.limit ?? "", 10) || 0,
    apply: values.apply,
    delta: values.delta ?? null,
  };
}

function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (!options.need || !options.locales || !options.localesList || !options.cache) {
    console.error(
      "Usage: node scripts/translate-literals.mjs --need <file> --locales <dir> --locales-list <csv> --cache <file> [--limit N] [--apply] [--delta <file>]",
    );
    process.exit(1);
  }
  if (options.delta && options.localesList.includes(",")) {
    console.error("--delta takes exactly one locale in --locales-list");
    process.exit(1);
  }

  const baseUrl = (process.env.TRANSLATE_BASE_URL ?? "").replace(/\/$/, "");
  const cfg = {
    url: `${baseUrl}/chat/completions`,
    model: process.env.TRANSLATE_MODEL ?? "",
    key: process.env.TRANSLATE_API_KEY ?? "",
  };
  if (!baseUrl || !cfg.model || !cfg.key) {
    console.error("Set TRANSLATE_BASE_URL, TRANSLATE_MODEL, TRANSLATE_API_KEY");
    process.exit(1);
  }

  const need = readJsonFile(options.need, []);
  const todo = options.limit ? need.slice(0, options.limit) : need;
  const locales = options.localesList.split(",");
  const cache = readJsonFile(options.cache, {});
  const allFailures = [];
  const added = {};

  for (const locale of locales) {
    if (!TARGET_NAMES[locale]) {
      console.log(`[${locale}] unknown target, skipping`);
      continue;
    }
    const path = join(options.locales, `${locale}.json`);
    // Locale files are source-of-truth data: fail fast rather than overwrite
    // malformed JSON with an empty map.
    const data = JSON.parse(readFileSync(path, "utf8"));
    const pending = todo.filter((k) => !(k in data));
    console.log(`[${locale}] pending=${pending.length}`);

    let ok = 0;
    let keep = 0;
    let fail = 0;
    const failures = [];
    const langName = TARGET_NAMES[locale];

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      const translatable = batch.filter((k) => !isVerbatim(k));
      const kept = batch.filter((k) => isVerbatim(k));
      for (const k of kept) {
        data[k] = k;
        added[k] = k;
        keep += 1;
      }
      if (!translatable.length) continue;
      // Cached values that fail validation (e.g. repr garbage from an older
      // pipeline) are re-requested instead of trusted.
      const todoKeys = translatable.filter((k) => {
        const cached = cache[`${locale}||${k}`];
        return !cached || validateTranslation(k, cached) !== null;
      });
      if (todoKeys.length) {
        const result = await callLlm(cfg, langName, todoKeys);
        if (result === null) {
          // Keep going: already-cached valid keys in this batch still apply.
          for (const k of todoKeys) {
            fail += 1;
            failures.push([locale, k, "llm-batch-failed"]);
          }
        } else {
          todoKeys.forEach((k, j) => {
            cache[`${locale}||${k}`] = result[j];
          });
          writeJsonAtomic(options.cache, cache);
          await new Promise((r) => setTimeout(r, REQUEST_PAUSE_MS));
        }
      }
      const failedKeys = new Set(failures.map(([, key]) => key));
      for (const k of translatable) {
        if (failedKeys.has(k)) continue;
        const out = cache[`${locale}||${k}`] ?? "";
        const why = validateTranslation(k, out);
        if (why) {
          fail += 1;
          failures.push([locale, k, why]);
          continue;
        }
        data[k] = out;
        added[k] = out;
        ok += 1;
      }
      if (options.apply) writeJsonAtomic(path, sortByKey(data));
      // Rewritten per batch so a cancelled/timed-out CI job still keeps progress.
      if (options.delta) writeJsonAtomic(options.delta, sortByKey(added));
    }
    if (options.apply) writeJsonAtomic(path, sortByKey(data));
    if (options.delta) writeJsonAtomic(options.delta, sortByKey(added));
    console.log(`[${locale}] done ok=${ok} keep=${keep} fail=${fail}`);
    for (const [loc, key, why] of failures.slice(0, 10)) {
      console.log(`  FAIL ${loc} ${JSON.stringify(key)} (${why})`);
    }
    allFailures.push(...failures);
  }

  writeJsonAtomic(options.cache, cache);
  console.log(JSON.stringify({ failureCount: allFailures.length }));
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) main();
