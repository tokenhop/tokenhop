import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard: the shipped app must not track users or phone home to services run by
// the original 9router authors. Docs (gitbook/, READMEs) are out of scope here;
// they are rewritten by the rebrand work.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const RUNTIME_DIRS = ["src", "open-sse", "cli/src", "cli/hooks", "public"];
const RUNTIME_FILES = [
  ".env.example",
  "next.config.mjs",
  "custom-server.js",
  "cli/cli.js",
  "cli/package.json",
  "package.json",
  "Dockerfile",
  "compose.yml",
  "compose.dev.yml",
];
const SCANNED_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".json", ".html", ".css", ".svg"]);
// Relative paths (not bare names) so e.g. src/i18n runtime code is still scanned.
const SKIPPED_PATHS = new Set(["public/i18n"]);
const SKIPPED_NAMES = new Set(["node_modules", ".next"]);

const FORBIDDEN = [
  { pattern: /google-analytics\.com/i, why: "Google Analytics" },
  { pattern: /googletagmanager\.com/i, why: "Google Tag Manager" },
  { pattern: /@next\/third-parties/, why: "third-party analytics loader" },
  { pattern: /\bG-[A-Z0-9]{8,}\b/, why: "GA measurement ID" },
  { pattern: /doubleclick\.net/i, why: "ad tracking" },
  {
    pattern: /(posthog\.com|plausible\.io|mixpanel\.com|segment\.(io|com)|amplitude\.com)/i,
    why: "analytics SDK",
  },
  {
    pattern: /(hotjar\.com|clarity\.ms|fullstory\.com|logrocket\.(io|com))/i,
    why: "session recording",
  },
  { pattern: /(sentry\.io|bugsnag\.com|datadoghq\.com)/i, why: "error/usage reporting" },
  { pattern: /abc-tunnel\.us/i, why: "upstream tunnel relay" },
  { pattern: /9router\.com/i, why: "upstream 9router.com service" },
  { pattern: /(9remote\.cc|9english\.net)/i, why: "upstream product promo" },
];

function listFiles(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (SKIPPED_NAMES.has(entry.name) || SKIPPED_PATHS.has(rel)) continue;
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

  it("scans a meaningful set of files, including src/i18n runtime code", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.startsWith(path.join("src", "i18n")))).toBe(true);
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

describe("Headroom sidecar never sends telemetry or update checks", () => {
  it("forces telemetry and the PyPI update check off for the proxy 9router launches", async () => {
    const { HEADROOM_PRIVACY_ENV } = await import("../../src/lib/headroom/process.js");
    expect(HEADROOM_PRIVACY_ENV).toEqual({
      HEADROOM_TELEMETRY: "off",
      HEADROOM_UPDATE_CHECK: "off",
      DO_NOT_TRACK: "1",
    });
    const source = fs.readFileSync(path.join(ROOT, "src/lib/headroom/process.js"), "utf8");
    expect(source).toMatch(
      /detached: true,[\s\S]{0,80}env: \{ \.\.\.process\.env, \.\.\.HEADROOM_PRIVACY_ENV \}/,
    );
  });

  it.each(["compose.yml", "compose.dev.yml"])("%s disables Headroom telemetry", (file) => {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    const headroomService = text.slice(text.indexOf("  headroom:"));
    expect(headroomService).toMatch(/HEADROOM_TELEMETRY: "off"/);
    expect(headroomService).toMatch(/HEADROOM_UPDATE_CHECK: "off"/);
    expect(headroomService).toMatch(/DO_NOT_TRACK: "1"/);
  });
});
