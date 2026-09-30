// Dependency-free on purpose: the CI translate jobs import this without an
// `npm ci` (scripts/i18n-literals.mjs pulls in Next's Babel for extraction).

const PLACEHOLDER_RE = /({\d+}|%[sd]|\{[^}\s]+\}|\[[a-z]+\])/gi;

/**
 * Placeholder/format tokens inside a literal (e.g. {count}, %s, [code]).
 * @param {string} text
 * @returns {string[]} Lower-cased tokens in order.
 */
export function placeholdersOf(text) {
  return [...String(text).matchAll(PLACEHOLDER_RE)].map((match) => match[0].toLowerCase());
}
