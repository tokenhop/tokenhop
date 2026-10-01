import { describe, expect, it } from "vitest";
import {
  diffAgainstLocales,
  extractFromRepo,
  readLocaleFiles,
} from "../../scripts/i18n-literals.mjs";

// Missing keys are not checked: feature PRs add English literals only, and
// .github/workflows/i18n-translate.yml translates them after merge (the
// runtime falls back to English until then).
describe("i18n locale coverage (YAN-409 guard)", () => {
  const repoRoot = new URL("../..", import.meta.url).pathname;
  const { literals } = extractFromRepo(repoRoot);
  const locales = readLocaleFiles(`${repoRoot}/public/i18n/literals`);

  it("extracts literals and finds locale files", () => {
    expect(literals.length).toBeGreaterThan(0);
    expect(locales.size).toBeGreaterThanOrEqual(30);
  });

  it("the stripped provider risk notice has a translation in every locale", () => {
    const rendered =
      "this provider uses a subscription/OAuth session not officially licensed for proxy/router use. The account may be restricted or banned. Use at your own risk.";
    const missing = [...locales.entries()]
      .filter(([, map]) => !(rendered in map))
      .map(([locale]) => locale);
    expect(missing).toEqual([]);
  });

  it("every translation keeps the source placeholders", () => {
    const { mismatches } = diffAgainstLocales(literals, locales);
    expect(mismatches).toEqual([]);
  });
});
