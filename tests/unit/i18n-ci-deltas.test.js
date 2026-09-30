import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeDelta } from "../../scripts/i18n-apply-deltas.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const roots = [];
const servers = [];
afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), "i18n-ci-"));
  roots.push(root);
  return root;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, data) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);

function runNode(script, args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(repoRoot, script), ...args], {
      env: { ...process.env, ...env },
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => done({ code, out }));
  });
}

/** OpenAI-compatible stub that "translates" by prefixing each string. */
async function stubModel() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const prompt = JSON.parse(body).messages[0].content;
      const items = prompt
        .split("Strings:\n")[1]
        .split("\n")
        .map((line) => line.replace(/^\d+\. /, ""));
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(items.map((s) => `ES:${s}`)) } }],
        }),
      );
    });
  });
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

describe("mergeDelta", () => {
  it("adds only keys the locale file lacks and keeps the result key-sorted", () => {
    const { merged, added } = mergeDelta(
      { Zeta: "Zeta-es", Beta: "hand-edited" },
      { Beta: "machine", Alpha: "Alfa" },
    );
    expect(added).toBe(1);
    expect(merged).toEqual({ Alpha: "Alfa", Beta: "hand-edited", Zeta: "Zeta-es" });
    expect(Object.keys(merged)).toEqual(["Alpha", "Beta", "Zeta"]);
  });

  it("rejects empty or non-string delta values instead of writing them", () => {
    expect(() => mergeDelta({}, { Save: "  " })).toThrow(/non-empty string/);
    expect(() => mergeDelta({}, { Save: 1 })).toThrow(/non-empty string/);
  });
});

describe("translate-literals --delta → i18n-apply-deltas", () => {
  it("writes only the entries a run added, and merges them onto a newer checkout", async () => {
    const root = tempDir();
    const locales = join(root, "locales");
    mkdirSync(locales);
    writeJson(join(locales, "es.json"), { Cancel: "Cancelar" });
    writeJson(join(root, "need.json"), ["Cancel", "Save changes", "Claude Code"]);

    const run = await runNode(
      "scripts/translate-literals.mjs",
      [
        "--need",
        join(root, "need.json"),
        "--locales",
        locales,
        "--locales-list",
        "es",
        "--cache",
        join(root, "cache.json"),
        "--apply",
        "--delta",
        join(root, "es.delta.json"),
      ],
      {
        TRANSLATE_BASE_URL: await stubModel(),
        TRANSLATE_MODEL: "stub",
        TRANSLATE_API_KEY: "test-key",
      },
    );
    expect(run.code, run.out).toBe(0);
    // "Claude Code" is a verbatim glossary term; "Cancel" was already translated.
    expect(readJson(join(root, "es.delta.json"))).toEqual({
      "Claude Code": "Claude Code",
      "Save changes": "ES:Save changes",
    });

    // Newer master: someone hand-translated "Save changes" meanwhile.
    const checkout = join(root, "checkout");
    const deltas = join(root, "deltas");
    mkdirSync(checkout);
    mkdirSync(deltas);
    writeJson(join(checkout, "es.json"), { Cancel: "Cancelar", "Save changes": "Guardar cambios" });
    writeFileSync(join(deltas, "es.json"), readFileSync(join(root, "es.delta.json")));
    writeFileSync(join(deltas, "es.log"), "ignored\n");

    const apply = await runNode("scripts/i18n-apply-deltas.mjs", [
      "--locales",
      checkout,
      "--deltas",
      deltas,
    ]);
    expect(apply.code, apply.out).toBe(0);
    expect(JSON.parse(apply.out.trim())).toEqual({ es: 1 });
    expect(readJson(join(checkout, "es.json"))).toEqual({
      Cancel: "Cancelar",
      "Claude Code": "Claude Code",
      "Save changes": "Guardar cambios",
    });
  });

  it("refuses --delta with more than one locale", async () => {
    const root = tempDir();
    const run = await runNode(
      "scripts/translate-literals.mjs",
      ["--need", "n", "--locales", root, "--locales-list", "es,fr", "--cache", "c", "--delta", "d"],
      { TRANSLATE_BASE_URL: "http://127.0.0.1:1/v1", TRANSLATE_MODEL: "m", TRANSLATE_API_KEY: "k" },
    );
    expect(run.code).toBe(1);
    expect(run.out).toMatch(/exactly one locale/);
  });
});
