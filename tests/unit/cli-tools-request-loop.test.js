import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Regression guard for YAN-388: status fetch effects that depended on the
// onStatusUpdate identity re-ran after every parent re-render, looping
// /api/cli-tools/*-settings requests. The harness has no DOM renderer, so this
// pins the dependency lists of the exact hooks that looped.
// ponytail: source-level check; swap for a component test if a DOM env lands.

const root = resolve(import.meta.dirname, "../../src/app/(dashboard)/dashboard/cli-tools");
const read = (file) => readFileSync(resolve(root, file), "utf8");

/** Dependency list of the first hook closing (`}, [deps]);`) after `marker`. */
function depsAfter(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const match = /\n {2}\}, \[([^\]]*)\]\);/.exec(source.slice(start));
  if (!match) throw new Error(`no hook deps after: ${marker}`);
  return match[1]
    .split(",")
    .map((dep) => dep.trim())
    .filter(Boolean);
}

describe("CLI tool status fetch stability", () => {
  it("page passes a stable status callback", () => {
    const page = read("CLIToolsPageClient.js");
    expect(page).toMatch(/const handleStatusUpdate = useCallback\([\s\S]*?\n {4}\[\],\n {2}\);/);
    expect(page).toMatch(/onStatusUpdate=\{handleStatusUpdate\}/);
    expect(page).not.toMatch(/onStatusUpdate=\{\(/);
  });

  it("useSetupCard status effect depends only on real inputs", () => {
    const shared = read("components/setupCard.js");
    expect(depsAfter(shared, "fetch(statusUrl)\n      .then")).toEqual([
      "statusUrl",
      "aliasesUrl",
      "toolId",
    ]);
  });

  it("ClaudeToolCard fetchStatus ignores callback identity", () => {
    const claude = read("components/ClaudeToolCard.js");
    expect(depsAfter(claude, "const fetchStatus = useCallback(")).toEqual([]);
  });

  it("AntigravityToolCard mount fetch ignores callback identity", () => {
    const antigravity = read("components/AntigravityToolCard.js");
    expect(depsAfter(antigravity, 'await fetch("/api/cli-tools/antigravity-mitm");')).toEqual([]);
  });

  it("every status fetcher reads the latest callback from a ref", () => {
    for (const file of [
      "components/setupCard.js",
      "components/ClaudeToolCard.js",
      "components/AntigravityToolCard.js",
    ]) {
      const source = read(file);
      expect(source).toMatch(/const onStatusUpdateRef = useRef\(onStatusUpdate\)/);
      expect(source).not.toMatch(/[^.]onStatusUpdate\?\.\(/);
    }
  });
});
