// YAN-378: a rejected startup-readiness chain must terminate the process
// nonzero before any HTTP listener exists. Next 16 logs "Failed to prepare
// server" but keeps serving 500s; the fatal boundary is custom-server's
// entry gate (dev/build/tests never exit).
//
// Coverage, all through real child processes running the real custom-server.js:
// 1. Stub payloads on the production failure codes: wrong root and invalid
//    env root (MASTER_KEY_INVALID), missing root (KEY_MISSING) — exit 1
//    before listening, marker never written.
// 2. Traced-standalone shape: node_modules is a pruned COPY of the next
//    runtime subset with no compiled webpack (webpack-lib/bundle5 absent),
//    proving the gate never needs the config loader — healthy register boots,
//    fatal register exits 1.
// 3. CLI layout: instrumentation only under `.next-cli-build` (no `.next`)
//    — gate resolves it and boots; fatal exits 1 pre-listen.
// 4. NODE_ENV=production with no built instrumentation anywhere — fatal,
//    never a silent readiness bypass.
// 5. Exact review-source reproduction against the worktree's real
//    `.next/standalone` (skips when absent): fresh custom-server.js copy,
//    real server.js + real traced node_modules boots and serves; replacing
//    the built instrumentation with a rejecting stub exits 1 before bind.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const customServerSrc = path.join(root, "custom-server.js");

let tmp;
const mkRoot = (name) => fs.mkdtempSync(path.join(tmp, `${name}-`));

beforeAll(() => {
  // os.tmpdir(), never a dev-box-only path: CI runners have no /tmp/opencode
  // and a mkdtemp ENOENT here fails the whole file (PR906 b391bc7).
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "custom-server-fatal-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const LISTEN_MARKER_SERVER = `const fs = require("node:fs");
const http = require("node:http");
http
  .createServer((req, res) => res.end("ok"))
  .listen(0, "127.0.0.1", () =>
    fs.writeFileSync(process.env.YAN378_MARKER, "listening"),
  );
`;

const stubInstrumentation = (registerBody) =>
  `module.exports.register = async function register() { ${registerBody} };\n`;

// Traced runtime closure used by the gate. Built once per run so tests can
// symlink a copy instead of the full checkout node_modules. The list is
// complete for the current Next startup chain; keeping it explicit makes the
// copied runtime intentionally pruned.
const TRACED_NEXT_FILES = [
  ["server/lib/router-utils/instrumentation-globals.external.js"],
  ["server/lib/router-utils/instrumentation-node-extensions.js"],
  ["server/app-render/work-unit-async-storage.external.js"],
  ["server/app-render/work-unit-async-storage-instance.js"],
  ["server/app-render/async-local-storage.js"],
  ["shared/lib/constants.js"],
  ["shared/lib/invariant-error.js"],
  ["shared/lib/is-plain-object.js"],
  ["shared/lib/server-reference-info.js"],
  ["lib/constants.js"],
  ["lib/is-error.js"],
  ["lib/interop-default.js"],
  ["lib/client-and-server-references.js"],
  ["trace/shared.js"],
];

function copyTracedNextSubset(destNodeModules) {
  for (const segments of TRACED_NEXT_FILES) {
    const src = path.join(root, "node_modules", "next", "dist", ...segments);
    if (!fs.existsSync(src)) throw new Error(`traced subset missing ${segments.join("/")}`);
    const dest = path.join(destNodeModules, "next", "dist", ...segments);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  fs.cpSync(
    path.join(root, "node_modules", "next", "dist", "compiled", "@opentelemetry", "api"),
    path.join(destNodeModules, "next", "dist", "compiled", "@opentelemetry", "api"),
    { recursive: true },
  );
  fs.copyFileSync(
    path.join(root, "node_modules", "next", "package.json"),
    path.join(destNodeModules, "next", "package.json"),
  );
}

function writeBaseLayout(dir, { dist = ".next", registerBody, tracedNext = false } = {}) {
  fs.copyFileSync(customServerSrc, path.join(dir, "custom-server.js"));
  fs.mkdirSync(path.join(dir, "src", "shared", "brand"), { recursive: true });
  fs.copyFileSync(
    path.join(root, "src", "shared", "brand", "index.cjs"),
    path.join(dir, "src", "shared", "brand", "index.cjs"),
  );
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
  fs.mkdirSync(path.join(dir, dist, "server"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, dist, "server", "instrumentation.js"),
    stubInstrumentation(registerBody ?? "/* healthy startup */"),
  );
  if (tracedNext) {
    copyTracedNextSubset(path.join(dir, "node_modules"));
  } else {
    fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  }
  fs.writeFileSync(path.join(dir, "server.js"), LISTEN_MARKER_SERVER);
  return dir;
}

function run(dir, { extraEnv = {}, argv = ["custom-server.js"] } = {}) {
  const marker = path.join(dir, "listening.marker");
  const child = spawn(process.execPath, argv, {
    cwd: dir,
    env: {
      ...process.env,
      HOME: path.join(dir, "home"),
      DATA_DIR: path.join(dir, "data"),
      YAN378_MARKER: marker,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return { child, marker, readStderr: () => stderr };
}

const waitExit = (child, ms = 20000) =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => reject(new Error("child exit timeout")), ms);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", reject);
  });

async function waitFor(fn, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });

const canConnect = (port, host = "127.0.0.1", timeout = 1000) =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(timeout);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const no = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", no);
    socket.once("timeout", no);
  });

const FATAL_CASES = [
  {
    name: "wrong master root (kid mismatch)",
    registerBody: `const err = new Error("[master-key] master key id mismatch");
      err.code = "MASTER_KEY_INVALID";
      throw err;`,
    expectCode: "MASTER_KEY_INVALID",
    stderrMatch: /master key id mismatch/,
  },
  {
    name: "invalid env master root (non-canonical base64)",
    registerBody: `const err = new Error(
        "[master-key] env master key must be canonical base64 of 32 bytes",
      );
      err.code = "MASTER_KEY_INVALID";
      throw err;`,
    expectCode: "MASTER_KEY_INVALID",
    stderrMatch: /canonical base64/,
  },
  {
    name: "missing master root for expected id",
    registerBody: `const err = new Error("[master-key] master key missing for expected id");
      err.code = "KEY_MISSING";
      throw err;`,
    expectCode: "KEY_MISSING",
    stderrMatch: /master key missing/,
  },
];

async function expectFatalExit({ child, marker, readStderr }, checks) {
  let exit;
  try {
    exit = await waitExit(child);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  expect(exit.code).toBe(1);
  expect(exit.signal).toBeNull();
  expect(fs.existsSync(marker)).toBe(false); // listen callback never ran
  const stderr = readStderr();
  expect(stderr).toContain("[custom-server] Fatal startup failure");
  for (const check of checks) expect(stderr).toMatch(check);
}

describe("custom-server fatal startup gate (YAN-378)", () => {
  for (const { name, registerBody, expectCode, stderrMatch } of FATAL_CASES) {
    it(`${name}: exits 1 before listening, no HTTP listener`, async () => {
      const dir = writeBaseLayout(mkRoot("case"), { registerBody });
      await expectFatalExit(run(dir), [stderrMatch, new RegExp(expectCode)]);
    });
  }

  it("control: resolving register() boots and listens", async () => {
    const dir = writeBaseLayout(mkRoot("control"));
    const { child, marker } = run(dir);
    try {
      await waitFor(() => fs.existsSync(marker));
      expect(fs.readFileSync(marker, "utf8")).toBe("listening");
    } finally {
      child.kill("SIGKILL");
      await waitExit(child);
    }
  });

  it("traced node_modules copy without compiled webpack: healthy boot, fatal exit", async () => {
    // Exact failure mode from review: loadConfig inside the gate dies on a
    // traced standalone tree. The gate must require only the runtime subset.
    const healthyDir = writeBaseLayout(mkRoot("traced-ok"), { tracedNext: true });
    expect(fs.existsSync(path.join(healthyDir, "node_modules/next/dist/compiled/webpack"))).toBe(
      false,
    );
    const boot = run(healthyDir);
    try {
      await waitFor(() => fs.existsSync(boot.marker));
      expect(fs.readFileSync(boot.marker, "utf8")).toBe("listening");
    } finally {
      boot.child.kill("SIGKILL");
      await waitExit(boot.child);
    }

    const fatalDir = writeBaseLayout(mkRoot("traced-fail"), {
      tracedNext: true,
      registerBody: FATAL_CASES[0].registerBody,
    });
    await expectFatalExit(run(fatalDir), [/master key id mismatch/]);
  });

  it("CLI layout (.next-cli-build only): gate resolves the CLI dist dir", async () => {
    const bootDir = writeBaseLayout(mkRoot("cli-ok"), { dist: ".next-cli-build" });
    expect(fs.existsSync(path.join(bootDir, ".next"))).toBe(false);
    const boot = run(bootDir);
    try {
      await waitFor(() => fs.existsSync(boot.marker));
      expect(fs.readFileSync(boot.marker, "utf8")).toBe("listening");
    } finally {
      boot.child.kill("SIGKILL");
      await waitExit(boot.child);
    }

    const fatalDir = writeBaseLayout(mkRoot("cli-fail"), {
      dist: ".next-cli-build",
      registerBody: FATAL_CASES[2].registerBody,
    });
    await expectFatalExit(run(fatalDir), [/master key missing/]);
  });

  it("production with no built instrumentation anywhere is fatal, not a silent bypass", async () => {
    const dir = writeBaseLayout(mkRoot("no-instr"));
    fs.rmSync(path.join(dir, ".next"), { recursive: true, force: true });
    await expectFatalExit(run(dir, { extraEnv: { NODE_ENV: "production" } }), [
      /No built instrumentation found/,
    ]);
  });

  describe("real .next/standalone reproduction", () => {
    const standaloneSrc = path.join(root, ".next", "standalone");
    const hasStandalone = () =>
      fs.existsSync(path.join(standaloneSrc, "server.js")) &&
      fs.existsSync(path.join(standaloneSrc, ".next", "server", "instrumentation.js"));

    const standaloneCopy = (name) => {
      const dir = mkRoot(name);
      fs.cpSync(standaloneSrc, dir, { recursive: true, verbatimSymlinks: true });
      // Traced standalone node_modules are symlinked into the checkout; in the
      // copy they must resolve to the real runtime modules.
      fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
      fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
      fs.copyFileSync(customServerSrc, path.join(dir, "custom-server.js")); // refresh the gate
      return dir;
    };

    it.skipIf(!hasStandalone())(
      "fresh wrapper over the real standalone tree boots and serves",
      async () => {
        const dir = standaloneCopy("standalone-real");
        const port = await freePort();
        const { child, readStderr } = run(dir, {
          extraEnv: { PORT: String(port), HOSTNAME: "127.0.0.1" },
        });
        try {
          await waitFor(async () => {
            if (child.exitCode !== null) throw new Error(readStderr());
            return await canConnect(port);
          }, 30000);
          // The gate passed and the real standalone server bound the port.
          // Any HTTP answer is post-auth territory; the fatal-gate claim only
          // needs a live listener with no startup failure logged.
          expect(readStderr()).not.toContain("[custom-server] Fatal startup failure");
        } finally {
          child.kill("SIGKILL");
          await waitExit(child);
          void readStderr;
        }
      },
    );

    it.skipIf(!hasStandalone())(
      "real standalone with rejecting instrumentation exits 1 before the port binds",
      async () => {
        const dir = standaloneCopy("standalone-fatal");
        fs.writeFileSync(
          path.join(dir, ".next", "server", "instrumentation.js"),
          stubInstrumentation(FATAL_CASES[0].registerBody),
        );
        const port = await freePort();
        const { child, readStderr } = run(dir, {
          extraEnv: { PORT: String(port), HOSTNAME: "127.0.0.1" },
        });
        try {
          await expectFatalExit({ child, marker: path.join(dir, "listening.marker"), readStderr }, [
            /master key id mismatch/,
          ]);
          expect(await canConnect(port)).toBe(false);
        } catch (error) {
          child.kill("SIGKILL");
          throw error;
        }
      },
    );
  });
});
