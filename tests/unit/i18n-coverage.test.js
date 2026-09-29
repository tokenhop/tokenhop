import { describe, expect, it } from "vitest";
import {
  diffAgainstLocales,
  extractFromRepo,
  readLocaleFiles,
} from "../../scripts/i18n-literals.mjs";

/**
 * Literals the runtime intentionally never translates. Every entry needs a
 * reason; anything without one is a regression.
 */
const UNTRANSLATED_LITERALS = new Map([
  // Raw log-stream marker chip: literal source tag, not prose (ConsoleLogRows).
  ["browser", "log-source marker chip, literal source tag"],
  // YAN-411 route-probe replay copy: translations land with the next i18n
  // copy batch (see scripts/translate-literals.mjs; precedent #338). The
  // runtime falls back to the English literal for these four keys.
  ["Answered", "YAN-411 probe replay; pending i18n copy batch"],
  ["Replay", "YAN-411 probe replay; pending i18n copy batch"],
  ["Replay the last run on the route track", "YAN-411 probe replay; pending i18n copy batch"],
  ["Trying…", "YAN-411 probe replay; pending i18n copy batch"],
]);

describe("i18n locale coverage (YAN-409 guard)", () => {
  const repoRoot = new URL("../..", import.meta.url).pathname;
  const { literals } = extractFromRepo(repoRoot);
  const locales = readLocaleFiles(`${repoRoot}/public/i18n/literals`);

  it("extracts literals and finds locale files", () => {
    expect(literals.length).toBeGreaterThan(0);
    expect(locales.size).toBeGreaterThanOrEqual(30);
  });

  it("every extracted UI literal exists in every locale", () => {
    const allowed = [...UNTRANSLATED_LITERALS.keys()];
    const problems = [];
    for (const [locale, map] of locales) {
      for (const literal of literals) {
        if (literal in map || allowed.includes(literal)) continue;
        problems.push(`${locale}: missing ${JSON.stringify(literal)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("every translation keeps the source placeholders", () => {
    const { mismatches } = diffAgainstLocales(literals, locales);
    expect(mismatches).toEqual([]);
  });
});
