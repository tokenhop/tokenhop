// YAN-1993: `npm test` fails (and vitest warns) when the running Node major
// differs from .nvmrc. See tests/setup/nodeVersionGate.js.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkNodeVersion, parseNvmrcMajor } from "../setup/nodeVersionGate.js";

const gatePath = fileURLToPath(new URL("../setup/nodeVersionGate.js", import.meta.url));

describe("parseNvmrcMajor", () => {
  it.each([
    ["22.23.4\n", 22],
    ["v22.23.4", 22],
    ["22", 22],
    [" 24.1 ", 24],
    ["lts/*", null],
    ["node", null],
    ["", null],
  ])("%j → %s", (text, major) => {
    expect(parseNvmrcMajor(text)).toBe(major);
  });
});

describe("checkNodeVersion", () => {
  it("passes on the same major, whatever the minor", () => {
    expect(checkNodeVersion({ nvmrc: "22.23.4\n", nodeVersion: "22.5.0" })).toMatchObject({
      ok: true,
    });
  });

  it("fails on another major and names both versions", () => {
    const r = checkNodeVersion({ nvmrc: "22.23.4\n", nodeVersion: "26.12.0" });
    expect(r).toMatchObject({ ok: false, expected: 22, actual: 26 });
    expect(r.message).toContain("26.12.0");
    expect(r.message).toContain("22.23.4");
  });

  it("does not gate a non-numeric .nvmrc", () => {
    expect(checkNodeVersion({ nvmrc: "lts/*", nodeVersion: "26.12.0" }).ok).toBe(true);
  });
});

describe("gate CLI", () => {
  it("exits 0 on the .nvmrc major and 1 otherwise", () => {
    const r = spawnSync(process.execPath, [gatePath], { encoding: "utf8" });
    const { ok } = checkNodeVersion({
      nvmrc: readFileSync(new URL("../../.nvmrc", import.meta.url), "utf8"),
      nodeVersion: process.versions.node,
    });
    expect(r.status).toBe(ok ? 0 : 1);
    if (!ok) expect(r.stderr).toContain(".nvmrc");
  });
});
