import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../../scripts/brand-guard.mjs");
const BASELINE = "scripts/brand-guard.baseline.json";

let repo;

function write(file, content) {
  const full = path.join(repo, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function git(...args) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function guard(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

function baseline() {
  return JSON.parse(fs.readFileSync(path.join(repo, BASELINE), "utf8"));
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "brand-guard-"));
  git("init", "-q");
  write("a.js", "// 9Router NINE_ROUTER nine-router\nconst ok = 1;\n");
  git("add", "-A");
  expect(guard("--update").code).toBe(0);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("brand-guard", () => {
  it("counts every spelling and passes on the baseline", () => {
    expect(baseline()).toEqual({ "a.js": 3 });
    const { code, out } = guard();
    expect(code).toBe(0);
    expect(out).toContain("brand-guard: 3 occurrences in 1 files remaining (baseline 3). OK");
  });

  it("fails when a new file appears", () => {
    write("b.js", "const x = '9router';\n");
    git("add", "b.js");
    const { code, out } = guard();
    expect(code).toBe(1);
    expect(out).toContain("b.js");
    expect(out).toContain("FAIL");
  });

  it("fails when a file's count goes up", () => {
    write("a.js", "// 9Router NINE_ROUTER nine-router\nconst ok = '9router';\n");
    const { code, out } = guard();
    expect(code).toBe(1);
    expect(out).toMatch(/a\.js: 3 → 4/);
  });

  it("passes a decrease, and --update lowers the baseline", () => {
    write("a.js", "// 9Router\n");
    expect(guard().code).toBe(0);
    expect(guard("--update").code).toBe(0);
    expect(baseline()).toEqual({ "a.js": 1 });
  });

  it("ignores allowlisted paths and lines", () => {
    write("LICENSE", "Copyright 9router\n");
    write("CHANGELOG.md", "9router\n");
    write("cli/package-lock.json", '{"name":"9router"}\n');
    write("docs/plans/x/plan.md", "9router\n");
    write("src/shared/brand/index.cjs", "const slug = '9router';\n");
    write("tests/fixtures/legacy/db.json", "9router\n");
    write("c.js", "const d = '~/.9router'; // legacy(9router): remove in v2\n");
    write("README.md", "> A copy of [9Router](https://github.com/decolua/9router).\n");
    git("add", "-A");
    const { code, out } = guard();
    expect(code).toBe(0);
    expect(out).toContain("3 occurrences in 1 files");
  });

  it("--update refuses increases and leaves the baseline alone", () => {
    write("b.js", "9router\n");
    git("add", "b.js");
    const { code, out } = guard("--update");
    expect(code).toBe(1);
    expect(out).toMatch(/refus/i);
    expect(baseline()).toEqual({ "a.js": 3 });
  });

  it("ignores files ignored by .gitignore", () => {
    write(".gitignore", "ignored.txt\n");
    write("ignored.txt", "9router\n");
    git("add", ".gitignore");
    expect(guard().code).toBe(0);
  });
});
