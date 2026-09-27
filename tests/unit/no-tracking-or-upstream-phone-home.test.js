import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard: the shipped app must not track users or phone home to services run by
// the original 9router authors. Docs (gitbook/, READMEs) are out of scope here;
// they are rewritten by the rebrand work.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const RUNTIME_DIRS = ["src", "open-sse", "cli/src", "public"];
const RUNTIME_FILES = [
  ".env.example",
  "next.config.mjs",
  "custom-server.js",
  "cli/cli.js",
  "package.json",
  "Dockerfile",
];
const SCANNED_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".json", ".html", ".css", ".svg"]);
const SKIPPED_DIRS = new Set(["node_modules", ".next", "i18n"]);

const FORBIDDEN = [
  { pattern: /google-analytics\.com/i, why: "Google Analytics" },
  { pattern: /googletagmanager\.com/i, why: "Google Tag Manager" },
  { pattern: /@next\/third-parties/, why: "third-party analytics loader" },
  { pattern: /\bG-[A-Z0-9]{8,}\b/, why: "GA measurement ID" },
  { pattern: /abc-tunnel\.us/i, why: "upstream tunnel relay" },
  { pattern: /9router\.com/i, why: "upstream 9router.com service" },
];

function listFiles(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(rel));
    else if (SCANNED_EXT.has(path.extname(entry.name))) out.push(rel);
  }
  return out;
}

describe("no tracking or upstream phone-home in runtime code", () => {
  const files = [
    ...RUNTIME_DIRS.flatMap(listFiles),
    ...RUNTIME_FILES.filter((f) => fs.existsSync(path.join(ROOT, f))),
  ];

  it("scans a meaningful set of files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("contains no analytics, trackers or upstream-owned endpoints", () => {
    const hits = [];
    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(text)) hits.push(`${file}: ${why} (${pattern})`);
      }
    }
    expect(hits).toEqual([]);
  });
});
