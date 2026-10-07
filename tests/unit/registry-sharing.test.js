// YAN-369 / ADR-0006: every registry entry declares `sharing` in the enum.
// Reads the registry directory directly with fs (not registry/index.js, whose
// import list may lag or skip entries such as devin-cli/windsurf).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REGISTRY_DIR = path.resolve(import.meta.dirname, "../../open-sse/providers/registry");
const TEMPLATE = path.resolve(import.meta.dirname, "../../open-sse/providers/REGISTRY_TEMPLATE.js");

// ADR-0006 §Registry field assignment table (36 personal / 87 shareable).
const PERSONAL = [
  "alicode",
  "alicode-intl",
  "alitp-intl",
  "glm",
  "minimax",
  "commandcode",
  "opencode-go",
  "xiaomi-tokenplan",
  "claude",
  "codex",
  "github",
  "cursor",
  "antigravity",
  "iflow",
  "qoder",
  "kimi",
  "xai",
  "xiaomi-mimo",
  "cline",
  "clinepass",
  "kilocode",
  "gitlab",
  "zed",
  "grok-cli",
  "meta-code",
  "codebuddy-cn",
  "codebuddy-intl",
  "trae",
  "windsurf",
  "gemini-cli",
  "kiro",
  "opencode",
  "mimo-free",
  "devin-cli",
  "grok-web",
  "perplexity-web",
];

const SHARING_RE = /^\s*sharing:\s*"(personal|shareable)",/m;

function readSharing(filePath) {
  return fs.readFileSync(filePath, "utf8").match(SHARING_RE)?.[1];
}

describe("registry sharing field (ADR-0006)", () => {
  const entries = fs
    .readdirSync(REGISTRY_DIR)
    .filter((f) => f.endsWith(".js") && f !== "index.js")
    .map((f) => ({ id: f.replace(/\.js$/, ""), sharing: readSharing(path.join(REGISTRY_DIR, f)) }));

  it("declares a valid sharing value on every registry entry", () => {
    for (const { id, sharing } of entries) {
      expect(sharing, `${id}.js`).toMatch(/^(personal|shareable)$/);
    }
    expect(entries).toHaveLength(123);
  });

  it("declares a valid sharing value on REGISTRY_TEMPLATE.js", () => {
    expect(readSharing(TEMPLATE)).toMatch(/^(personal|shareable)$/);
  });

  it("matches the ADR-0006 counts (36 personal / 87 shareable)", () => {
    expect(entries.filter((e) => e.sharing === "personal")).toHaveLength(36);
    expect(entries.filter((e) => e.sharing === "shareable")).toHaveLength(87);
  });

  it("personal set matches the ADR-0006 table exactly", () => {
    expect(
      entries
        .filter((e) => e.sharing === "personal")
        .map((e) => e.id)
        .sort(),
    ).toEqual([...PERSONAL].sort());
  });
});
