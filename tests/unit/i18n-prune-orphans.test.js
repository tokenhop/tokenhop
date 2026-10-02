import { describe, expect, it } from "vitest";
import { extractAllBrands } from "../../scripts/i18n-prune-orphans.mjs";

// YAN-336: tokenhop keys sit next to the 9router ones until the release, so
// pruning on either brand must keep both sets.
describe("i18n-prune-orphans brand coverage", () => {
  it("treats literals rendered by any brand as live", () => {
    const literals = extractAllBrands(new URL("../..", import.meta.url).pathname);
    expect(literals.has("How 9Router works")).toBe(true);
    expect(literals.has("How tokenhop works")).toBe(true);
  }, 60_000);
});
