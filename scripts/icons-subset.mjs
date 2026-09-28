#!/usr/bin/env node
/**
 * Regenerate the self-hosted Material Symbols Outlined subset (YAN-395).
 *
 *   node scripts/icons-subset.mjs
 *
 * Run it after adding a new icon name anywhere in src/ or open-sse/providers/registry/
 * (tests/unit/icon-glyphs.test.js fails until you do). It:
 *   1. scans source literals for icon names (scripts/lib/icon-glyphs.mjs), matched against every
 *      ligature in the font (scripts/lib/material-symbols-names.txt, refreshed on each run; the
 *      package's index.d.ts omits ~370 legacy names such as `expand_more`),
 *   2. writes src/app/fonts/material-symbols-glyphs.json (the committed list the test checks),
 *   3. pins the Signal axes (wght 300, GRAD 0, opsz 20; FILL stays 0..1 for the active state)
 *      and keeps only those ligatures, writing src/app/fonts/material-symbols-subset.woff2.
 *
 * Dev-only prerequisite: `uv` (https://docs.astral.sh/uv/). fonttools runs via `uvx`, so no
 * Python or npm dependency is added. The source font is the installed `material-symbols` package.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectLiteralTokens, collectUsedIconNames } from "./lib/icon-glyphs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_FONT = join(ROOT, "node_modules/material-symbols/material-symbols-outlined.woff2");
const OUT_DIR = join(ROOT, "src/app/fonts");
const GLYPH_LIST = join(OUT_DIR, "material-symbols-glyphs.json");
const ALL_NAMES = join(ROOT, "scripts/lib/material-symbols-names.txt");
const OUT_FONT = join(OUT_DIR, "material-symbols-subset.woff2");

// Resolves each ligature's output glyph (and its `.fill` twin) from the font itself, so icon
// names never have to match glyph names. Tokens that aren't ligatures are ignored.
const SUBSET_PY = `
import json, sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

src, out, names_file, all_names_file = sys.argv[1:5]
names = set(json.load(open(names_file)))
font = TTFont(src, lazy=False)
chars = {v: chr(k) for k, v in font.getBestCmap().items()}
keep, every = set(), set()
for sub in font["GSUB"].table.LookupList.Lookup[0].SubTable:
    table = getattr(sub, "ExtSubTable", sub)
    for first, ligs in table.ligatures.items():
        for lig in ligs:
            name = "".join(chars.get(g, "?") for g in [first, *lig.Component])
            every.add(name)
            if name in names:
                keep.add(lig.LigGlyph)
glyph_order = set(font.getGlyphOrder())
keep |= {g + ".fill" for g in keep if g + ".fill" in glyph_order}
open(all_names_file, "w").write("\\n".join(sorted(every)) + "\\n")
opts = subset.Options()
opts.flavor = "woff2"
opts.layout_closure = False
opts.layout_features = ["rlig", "rclt", "liga"]
opts.notdef_outline = True
opts.name_IDs = ["*"]
sub = subset.Subsetter(opts)
sub.populate(glyphs=sorted(keep), text="abcdefghijklmnopqrstuvwxyz0123456789_ ")
sub.subset(font)
font = instancer.instantiateVariableFont(font, {"wght": 300, "GRAD": 0, "opsz": 20})
font.flavor = "woff2"
font.save(out)
`;

const tmp = mkdtempSync(join(tmpdir(), "icons-subset-"));
try {
  const script = join(tmp, "subset.py");
  const namesFile = join(tmp, "names.json");
  writeFileSync(script, SUBSET_PY);
  // Candidate tokens; the font's own ligature table decides which are icons.
  writeFileSync(namesFile, JSON.stringify([...collectLiteralTokens(ROOT)]));
  execFileSync(
    "uvx",
    ["--from", "fonttools[woff]", "python", script, SOURCE_FONT, OUT_FONT, namesFile, ALL_NAMES],
    { stdio: "inherit" },
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const names = collectUsedIconNames(ROOT);
writeFileSync(GLYPH_LIST, `${JSON.stringify(names, null, 2)}\n`);

const kb = (file) => (statSync(file).size / 1024).toFixed(1);
console.log(`[icons-subset] ${names.length} icons, ${kb(SOURCE_FONT)} KB -> ${kb(OUT_FONT)} KB`);
