import { describe, expect, it } from "vitest";
import { topologyMotion } from "@/app/(dashboard)/dashboard/usage/components/topologyMotion.js";

describe("topologyMotion", () => {
  it("disables route flow and JS fit animation under reduced motion", () => {
    expect(topologyMotion(true)).toEqual({ flow: false, fitDuration: 0 });
  });

  it("keeps slow route flow and fit animation otherwise", () => {
    expect(topologyMotion(false)).toEqual({ flow: true, fitDuration: 200 });
  });
});

describe("topology CSS motion guards", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");

  it("keeps topology flow at or below 3 Hz", () => {
    expect(css).not.toMatch(/topology-edge-(halo|plasma|kame)|steps\(\d\)/);
    expect(css).toMatch(
      /\.topology-edge-flow\s*\{\s*animation:\s*topology-edge-flow 1\.1s linear infinite;/,
    );
  });

  it("stops topology flow under reduced motion", () => {
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{\s*\.topology-edge-flow\s*\{\s*animation:\s*none;/,
    );
  });

  it("stops the request-log spinner under reduced motion", () => {
    const spin = css.indexOf(".animate-spin {\n  animation: spin");
    const guard = css.indexOf("@media (prefers-reduced-motion: reduce)", spin);
    expect(spin).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(spin);
    expect(css.slice(guard)).toMatch(
      /^@media \(prefers-reduced-motion: reduce\) \{\s*\.animate-spin \{\s*animation: none;\s*\}\s*\}/,
    );
  });
});
