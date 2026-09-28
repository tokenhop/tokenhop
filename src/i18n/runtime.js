"use client";

import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from "./config";

let translationMap = {};
let currentLocale = DEFAULT_LOCALE;
let reloadCallbacks = [];
const localeMaps = new Map();
let observer = null;
// Bumped per init/reload so a slower, superseded locale load never applies.
let loadEpoch = 0;

// Read locale from cookie
function getLocaleFromCookie() {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const cookie = document.cookie.split(";").find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : DEFAULT_LOCALE;
  return normalizeLocale(value);
}

// Load translation map; successful loads are cached for the page lifetime.
async function loadTranslations(locale) {
  if (locale === "en") {
    translationMap = {};
    return;
  }
  const cached = localeMaps.get(locale);
  if (cached) {
    translationMap = cached;
    return;
  }

  try {
    const response = await fetch(`/i18n/literals/${locale}.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${locale}.json`);
    translationMap = await response.json();
    localeMaps.set(locale, translationMap);
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

  // A value we didn't write is new source copy (first visit or a React update).
  if (node._originalText === undefined || node.nodeValue !== node._translatedText) {
    node._originalText = node.nodeValue;
  }
  const translated = translate(node._originalText);
  node._translatedText = translated;

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
  if (!element._i18nTranslatedAttrs) element._i18nTranslatedAttrs = {};
  for (const attr of TRANSLATABLE_ATTRS) {
    if (!element.hasAttribute?.(attr)) continue;
    const current = element.getAttribute(attr);
    if (!(attr in element._i18nOriginalAttrs) || current !== element._i18nTranslatedAttrs[attr]) {
      element._i18nOriginalAttrs[attr] = current;
    }
    const translated = translate(element._i18nOriginalAttrs[attr] ?? "");
    element._i18nTranslatedAttrs[attr] = translated || current;
    if (translated && translated !== current) {
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

/** Translate only what changed: added subtrees, edited text and edited copy attributes. */
function handleMutations(mutations) {
  for (const mutation of mutations) {
    if (mutation.type === "characterData") {
      processTextNode(mutation.target);
    } else if (mutation.type === "attributes") {
      processElementAttributes(mutation.target);
    } else {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) processElement(node);
        else if (node.nodeType === Node.TEXT_NODE) processTextNode(node);
      });
    }
  }
}

function startObserver() {
  if (observer) return;
  observer = new MutationObserver(handleMutations);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSLATABLE_ATTRS,
  });
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
}

// Initialize runtime i18n. English does no fetch, walk or observation.
export async function initRuntimeI18n() {
  if (typeof window === "undefined") return;

  currentLocale = getLocaleFromCookie();
  if (currentLocale === "en") return;
  const epoch = ++loadEpoch;
  await loadTranslations(currentLocale);
  if (epoch !== loadEpoch) return;
  processElement(document.body);
  startObserver();
}

// Reload translations when locale changes
export async function reloadTranslations() {
  const epoch = ++loadEpoch;
  const previousLocale = currentLocale;
  currentLocale = getLocaleFromCookie();
  await loadTranslations(currentLocale);
  if (epoch !== loadEpoch) return;

  reloadCallbacks.forEach((callback) => {
    callback();
  });

  if (currentLocale === "en") {
    stopObserver();
    // One walk restores stored originals; staying in English does nothing.
    if (previousLocale !== "en") processElement(document.body);
    return;
  }
  processElement(document.body);
  startObserver();
}
