"use client";

import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from "./config";

let translationMap = {};
let currentLocale = DEFAULT_LOCALE;
let reloadCallbacks = [];

// Read locale from cookie
function getLocaleFromCookie() {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const cookie = document.cookie.split(";").find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : DEFAULT_LOCALE;
  return normalizeLocale(value);
}

// Load translation map
async function loadTranslations(locale) {
  if (locale === "en") {
    translationMap = {};
    return;
  }

  try {
    const response = await fetch(`/i18n/literals/${locale}.json`);
    translationMap = await response.json();
  } catch (err) {
    console.error("Failed to load translations:", err);
    translationMap = {};
  }
}

// Translate text - exported for use in components
export function translate(text) {
  if (!text || typeof text !== "string") return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (currentLocale === "en") return text;
  return translationMap[trimmed] || text;
}

// Get current locale - exported for use in components
export function getCurrentLocale() {
  return currentLocale;
}

// Register callback for locale changes
export function onLocaleChange(callback) {
  reloadCallbacks.push(callback);
  return () => {
    reloadCallbacks = reloadCallbacks.filter((cb) => cb !== callback);
  };
}

// Elements whose text is code/structure, never UI copy. CODE_TAGS skip the
// whole subtree; plain structural tags only skip their own text nodes (a
// <td> below <table> is still UI copy).
const SKIP_TAGS = new Set([
  "script",
  "style",
  "code",
  "pre",
  "colgroup",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "select",
  "datalist",
  "optgroup",
]);
const CODE_TAGS = new Set(["script", "style", "code", "pre"]);

/**
 * Whether text under `parent` must stay untranslated: icon ligatures, explicit
 * data-i18n-skip subtrees and code/structural tags. Mono styling alone is not
 * semantic (loading labels and status prose use font-mono too).
 * @param {Element} parent Direct parent element of the text node.
 * @returns {boolean}
 */
export function shouldSkipTextParent(parent) {
  let element = parent;
  while (element) {
    if (
      element.hasAttribute?.("data-i18n-skip") ||
      element.className?.toString?.().includes("material-symbols") ||
      CODE_TAGS.has(element.tagName?.toLowerCase())
    ) {
      return true;
    }
    element = element.parentElement;
  }
  // Structural tags only matter as the direct parent (they never hold copy);
  // text in <td>/<th> below them is real UI copy and must translate.
  return SKIP_TAGS.has(parent.tagName?.toLowerCase());
}

// Process text node
function processTextNode(node) {
  if (!node.nodeValue || !node.nodeValue.trim()) return;

  const parent = node.parentElement;
  if (!parent || shouldSkipTextParent(parent)) return;

  // Store original text if not already stored
  if (!node._originalText) {
    node._originalText = node.nodeValue;
  }

  // Use original text for translation
  const original = node._originalText;
  const translated = translate(original);

  // Only update if different to avoid unnecessary DOM mutations
  if (translated !== node.nodeValue) {
    node.nodeValue = translated;
  }
}

// Attributes carrying user-facing copy the extractor also catalogs.
const TRANSLATABLE_ATTRS = ["aria-label", "placeholder", "title", "alt"];

/**
 * Translate the four user-facing attributes on one element, in place.
 * Stores the original value on the element so re-runs stay stable.
 * @param {Element} element
 */
export function processElementAttributes(element) {
  if (shouldSkipTextParent(element)) return;
  if (!element._i18nOriginalAttrs) element._i18nOriginalAttrs = {};
  for (const attr of TRANSLATABLE_ATTRS) {
    if (!element.hasAttribute?.(attr)) continue;
    if (!(attr in element._i18nOriginalAttrs)) {
      element._i18nOriginalAttrs[attr] = element.getAttribute(attr);
    }
    const translated = translate(element._i18nOriginalAttrs[attr] ?? "");
    if (translated && translated !== element.getAttribute(attr)) {
      element.setAttribute(attr, translated);
    }
  }
}

// Process all text nodes and user-facing attributes in element
function processElement(element) {
  if (!element) return;

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);

  let node;
  const nodesToProcess = [];

  // Collect all nodes first to avoid live collection issues
  while ((node = walker.nextNode())) {
    nodesToProcess.push(node);
  }

  // Process collected nodes
  nodesToProcess.forEach(processTextNode);

  // Attributes are extracted into locale files; translate them too.
  const attrTargets = [
    element,
    ...element.querySelectorAll("[aria-label],[placeholder],[title],[alt]"),
  ];
  attrTargets.forEach(processElementAttributes);
}

// Initialize runtime i18n
export async function initRuntimeI18n() {
  if (typeof window === "undefined") return;

  currentLocale = getLocaleFromCookie();
  await loadTranslations(currentLocale);

  // Process existing DOM
  processElement(document.body);

  // Watch for new nodes
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          processElement(node);
        } else if (node.nodeType === Node.TEXT_NODE) {
          processTextNode(node);
        }
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// Reload translations when locale changes
export async function reloadTranslations() {
  currentLocale = getLocaleFromCookie();
  await loadTranslations(currentLocale);

  // Notify all registered callbacks
  reloadCallbacks.forEach((callback) => {
    callback();
  });

  // Re-process entire DOM (will use stored original text)
  processElement(document.body);
}
