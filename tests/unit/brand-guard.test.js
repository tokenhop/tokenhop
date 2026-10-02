import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../../scripts/brand-guard.mjs");

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

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "brand-guard-"));
  git("init", "-q");
  write("a.js", "const ok = 1;\n");
  git("add", "-A");
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("brand-guard (strict)", () => {
  it("passes a clean repo", () => {
    const { code, out } = guard();
    expect(code).toBe(0);
    expect(out).toContain("brand-guard: 0 occurrences. OK");
  });

  it("fails on every spelling and reports file:line", () => {
    write("b.js", "const x = 1;\n// 9Router NINE_ROUTER nine-router\n");
    git("add", "b.js");
    const { code, out } = guard();
    expect(code).toBe(1);
    expect(out).toContain("brand-guard: 3 occurrences in 1 files. FAIL");
    expect(out).toContain("b.js:2:");
  });

  it("ignores allowlisted paths and lines", () => {
    write("LICENSE", "Copyright 9router\n");
    write("CHANGELOG.md", "9router\n");
    write("cli/package-lock.json", '{"name":"9router"}\n');
    write("docs/plans/x/plan.md", "9router\n");
    write("src/shared/brand/index.cjs", "const slug = '9router';\n");
    write("tests/unit/brand.test.js", "expect(slug).toBe('9router');\n");
    write("public/i18n/literals/de.json", '{"Install 9Router": "9Router installieren"}\n');
    write("tests/fixtures/legacy/db.json", "9router\n");
    write("c.js", "const d = '~/.9router'; // legacy(9router): remove in v2\n");
    write("README.md", "> A copy of [9Router](https://github.com/decolua/9router).\n");
    git("add", "-A");
    expect(guard().code).toBe(0);
  });

  it("allows the decolua credit only in README files", () => {
    write("notes.md", "Based on 9Router by decolua\n");
    git("add", "notes.md");
    expect(guard().code).toBe(1);
  });

  it("rejects arguments, including the removed --update", () => {
    expect(guard("--update").code).toBe(2);
    expect(guard("--nope").code).toBe(2);
  });

  it("ignores files ignored by .gitignore", () => {
    write(".gitignore", "ignored.txt\n");
    write("ignored.txt", "9router\n");
    git("add", ".gitignore");
    expect(guard().code).toBe(0);
  });
});
