import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectUsedIconNames } from "../../scripts/lib/icon-glyphs.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("Material Symbols subset", () => {
  it("contains every icon used in source (run `node scripts/icons-subset.mjs` if this fails)", () => {
    const shipped = JSON.parse(
      readFileSync(new URL("../../src/app/fonts/material-symbols-glyphs.json", import.meta.url)),
    );
    const missing = collectUsedIconNames(ROOT).filter((name) => !shipped.includes(name));
    expect(missing).toEqual([]);
  });
});
