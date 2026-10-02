import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let testApi;
try {
  testApi = await import("vitest");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  testApi = await import("node:test");
}
const { afterEach, describe, it } = testApi;

const require = createRequire(import.meta.url);
const {
  assertRequiredApiArtifacts,
  copySharedModules,
  copyStandaloneBuild,
  mergeServerArtifacts,
  SHARED_MODULE_PATHS,
} = require("../../cli/scripts/build-cli.js");
const repoRoot = path.resolve(import.meta.dirname, "../..");

const tempDirs = [];

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-cli-build-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeFixture(root, relativePath, contents = relativePath) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function createCompleteServer(buildDistDir) {
  const serverDir = path.join(buildDistDir, "server");
  writeFixture(serverDir, "app/api/v1/chat/completions/route.js", "chat route");
  writeFixture(serverDir, "app/api/v1/messages/route.js", "messages route");
  writeFixture(serverDir, "chunks/openai-provider.js", "openai chunk");
  writeFixture(serverDir, "chunks/anthropic-provider.js", "anthropic chunk");
  return serverDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("CLI build server artifacts", () => {
  for (const { name, standalonePath } of [
    {
      name: "legacy nested app",
      standalonePath: (appDir, buildDistDir) => path.join(appDir, ".next", "standalone", "app"),
    },
    {
      name: "Next 16 workspace",
      standalonePath: (appDir, buildDistDir) =>
        path.join(buildDistDir, "standalone", path.basename(appDir)),
    },
  ]) {
    it(`merges complete API routes and provider chunks for the ${name} layout`, () => {
      const root = createTempDir();
      const appDir = path.join(root, "tokenhop");
      const buildDistDir = path.join(appDir, ".next-cli-build");
      const cliAppDir = path.join(root, "cli-app");
      const standaloneDir = standalonePath(appDir, buildDistDir);

      writeFixture(standaloneDir, "server.js", "standalone server");
      writeFixture(
        standaloneDir,
        ".next-cli-build/server/app/api/v1/chat/completions/route.js",
        "standalone chat route",
      );
      createCompleteServer(buildDistDir);

      copyStandaloneBuild(appDir, buildDistDir, cliAppDir);
      mergeServerArtifacts(buildDistDir, cliAppDir);
      assertRequiredApiArtifacts(cliAppDir);

      const packagedServer = path.join(cliAppDir, ".next-cli-build", "server");
      assert.equal(
        fs.readFileSync(path.join(packagedServer, "app/api/v1/messages/route.js"), "utf8"),
        "messages route",
      );
      assert.equal(
        fs.readFileSync(path.join(packagedServer, "chunks/openai-provider.js"), "utf8"),
        "openai chunk",
      );
      assert.equal(
        fs.readFileSync(path.join(packagedServer, "chunks/anthropic-provider.js"), "utf8"),
        "anthropic chunk",
      );
    });
  }

  it("merges idempotently without removing standalone-generated files", () => {
    const root = createTempDir();
    const buildDistDir = path.join(root, ".next-cli-build");
    const cliAppDir = path.join(root, "cli-app");
    const packagedServer = path.join(cliAppDir, ".next-cli-build", "server");

    createCompleteServer(buildDistDir);
    writeFixture(packagedServer, "standalone-only.js", "keep me");

    mergeServerArtifacts(buildDistDir, cliAppDir);
    mergeServerArtifacts(buildDistDir, cliAppDir);

    assert.equal(
      fs.readFileSync(path.join(packagedServer, "standalone-only.js"), "utf8"),
      "keep me",
    );
    assert.equal(
      fs.readFileSync(path.join(packagedServer, "app/api/v1/messages/route.js"), "utf8"),
      "messages route",
    );
  });

  it("ships the shared modules inside the packed CLI", () => {
    const cliDir = createTempDir();
    for (const file of ["package.json", ".npmignore", ".gitignore"]) {
      fs.copyFileSync(path.join(repoRoot, "cli", file), path.join(cliDir, file));
    }

    const dests = copySharedModules(repoRoot, cliDir);
    assert.deepEqual(
      dests,
      SHARED_MODULE_PATHS.map((rel) => path.join(cliDir, rel)),
    );
    for (const rel of SHARED_MODULE_PATHS) {
      assert.equal(
        fs.readFileSync(path.join(cliDir, rel), "utf8"),
        fs.readFileSync(path.join(repoRoot, rel), "utf8"),
      );
    }

    const out = execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      {
        cwd: cliDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        shell: process.platform === "win32",
      },
    );
    // npm ≤10 prints an array, npm 11 an object keyed by package name.
    const [pack] = Object.values(JSON.parse(out));
    for (const rel of SHARED_MODULE_PATHS) {
      assert.ok(
        pack.files.some((f) => f.path === rel.split(path.sep).join("/")),
        rel,
      );
    }
  });

  it("reports the missing required API route artifact path", () => {
    const root = createTempDir();
    const buildDistDir = path.join(root, ".next-cli-build");
    const cliAppDir = path.join(root, "cli-app");

    writeFixture(
      path.join(buildDistDir, "server"),
      "app/api/v1/chat/completions/route.js",
      "chat route",
    );
    mergeServerArtifacts(buildDistDir, cliAppDir);

    assert.throws(
      () => assertRequiredApiArtifacts(cliAppDir),
      (error) =>
        error.message.includes(
          path.join(cliAppDir, ".next-cli-build/server/app/api/v1/messages/route.js"),
        ),
    );
  });
});
