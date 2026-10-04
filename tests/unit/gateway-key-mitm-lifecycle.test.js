import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  installLocalVerifier,
  clearLocalVerifierIfMatch,
  matchesLocalVerifier,
  isLocalRouterBaseUrl,
  resolveRemoteSource,
} from "../../src/lib/auth/mitmCredential.js";
import { assertIsolatedHome, removeUnderHome } from "../helpers/isolatedHome.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MITM_DIR = path.join(REPO_ROOT, "src", "mitm");
const require = createRequire(import.meta.url);
const runtime = require("../../src/mitm/runtimeCredentials.js");
const managerSource = readFileSync(path.join(MITM_DIR, "manager.js"), "utf8");
const initSource = readFileSync(
  path.join(REPO_ROOT, "src/shared/services/initializeApp.js"),
  "utf8",
);

// Evaluate CJS with every OS side effect replaced. No real spawn, DNS, cert or socket.
function harness({
  sudo = false,
  remoteKey = null,
  router = "http://localhost:20128",
  platform = "linux",
} = {}) {
  const settings = { mitmEnabled: true, mitmRouterBaseUrl: router };
  const db = {
    getSettings: async () => ({ ...settings }),
    updateSettings: vi.fn(async (patch) => Object.assign(settings, patch)),
  };
  const children = [];
  const logs = [];
  let healthy = true;
  const spawn = vi.fn(() => {
    const child = new EventEmitter();
    Object.assign(child, {
      pid: 12345 + children.length,
      killed: false,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { write: vi.fn(), end: vi.fn() },
      kill: vi.fn(() => {
        child.killed = true;
        child.emit("exit", 0);
        return true;
      }),
    });
    children.push(child);
    return child;
  });
  const files = new Map();
  const fs = {
    existsSync: (name) => !/\.mitm\.(pid|lock)$/.test(name) || files.has(name),
    readFileSync: (name) => files.get(name) || "",
    writeFileSync: (name, value) => files.set(name, value),
    unlinkSync: (name) => files.delete(name),
    mkdirSync: vi.fn(),
  };
  const mocks = {
    child_process: {
      spawn,
      exec: vi.fn((_cmd, _opts, cb) => cb?.(null, "")),
      execSync: vi.fn(() => ""),
    },
    fs,
    net: {
      createServer: () => {
        const server = new EventEmitter();
        server.listen = () => queueMicrotask(() => server.emit("listening"));
        server.close = (cb) => cb();
        return server;
      },
    },
    https: {
      request: (_options, callback) => {
        const req = new EventEmitter();
        req.end = () => {
          const res = new EventEmitter();
          callback(res);
          res.emit("data", JSON.stringify({ ok: healthy, pid: 12345 }));
          res.emit("end");
        };
        return req;
      },
    },
    "./paths": { DATA_DIR: "/mock", MITM_DIR: "/mock/mitm" },
    "./logger": { log: (s) => logs.push(s), err: (s) => logs.push(s) },
    "./config": { LSOF_BIN: "lsof" },
    "./winElevated.js": { isAdmin: () => false },
    "./dns/dnsConfig": {
      TOOL_HOSTS: {},
      isSudoAvailable: () => sudo,
      isSudoPasswordRequired: () => false,
      execWithPassword: async () => {},
      checkAllDNSStatus: () => ({}),
      removeAllDNSEntries: async () => {},
    },
    "./cert/generate": { generateCert: async () => {} },
    "./cert/rootCA": { isCertExpired: () => false },
    "./cert/install": { checkCertInstalled: async () => true, installCert: async () => {} },
    "./runtimeCredentials": runtime,
    os: { homedir: () => "/mock/home", tmpdir: () => "/mock/tmp" },
    "node-machine-id": { machineIdSync: () => "mock" },
  };
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    require: (id) =>
      mocks[id] || (id.startsWith(".") ? require(path.resolve(MITM_DIR, id)) : require(id)),
    __dirname: MITM_DIR,
    process: {
      platform,
      env: {
        TOKENHOP_MITM_REMOTE_API_KEY: "parent-env-sentinel",
        TOKENHOP_MITM_REMOTE_API_KEY_FILE: "/parent/file-sentinel",
        TOKENHOP_MASTER_KEY: "parent-root-sentinel",
        KEEP_ME: "runtime-env",
      },
      pid: 99999,
      execPath: "/mock/node",
      kill: () => {
        throw new Error("not alive");
      },
      stdout: { write: (s) => logs.push(String(s)) },
    },
    console,
    Buffer,
    URL,
    Date,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(managerSource, context);
  const manager = module.exports;
  manager.initDbHooks(db.getSettings, db.updateSettings);
  const wire = () =>
    manager.initMitmCredentialHooks(
      {
        isLocalRouter: isLocalRouterBaseUrl,
        installLocalVerifier: (hash) => installLocalVerifier(db, hash),
        clearLocalVerifierIfMatch: (hash) => clearLocalVerifierIfMatch(db, hash),
      },
      remoteKey,
    );
  return {
    manager,
    settings,
    db,
    spawn,
    children,
    logs,
    wire,
    failHealth: () => {
      healthy = false;
    },
  };
}

async function start(h, key = null) {
  const result = h.manager.startMitm(key, "password");
  await vi.advanceTimersByTimeAsync(600);
  return result;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await removeUnderHome(["mitm-lifecycle-key"]);
});

describe("MITM credential lifecycle", () => {
  it("cold boots hashed storage with zero client keys and no default fallback", async () => {
    vi.useFakeTimers();
    const h = harness();
    const getApiKeys = vi.fn(() => {
      throw new Error("must not read client keys");
    });
    const body = initSource.slice(
      initSource.indexOf("async function autoStartMitm("),
      initSource.indexOf("// Cooldown only"),
    );
    const context = vm.createContext({
      g: {},
      process: { platform: "linux" },
      console: { log: vi.fn() },
      getMitmStatus: async () => ({ running: false }),
      loadEncryptedPassword: async () => "password",
      readStorageState: async () => ({ storage: "hashed" }),
      configureMitmCredentials: async () => h.wire(),
      getApiKeys,
      ACTIVE: { defaultApiKey: "forbidden-default" },
      startMitm: h.manager.startMitm,
      restoreToolDNS: async () => {},
    });
    vm.runInContext(`${body}; globalThis.run = autoStartMitm`, context);
    const boot = context.run({ mitmEnabled: true });
    await vi.advanceTimersByTimeAsync(600);
    await boot;
    expect(getApiKeys).not.toHaveBeenCalled();
    expect(h.spawn).toHaveBeenCalledOnce();
    const raw = h.spawn.mock.calls[0][2].env.ROUTER_API_KEY;
    expect(matchesLocalVerifier(raw, h.settings.mitmInternalVerifier)).toBe(true);
    expect(JSON.stringify(h.settings)).not.toContain(raw);
  });

  it("crash restart mints once, invalidates old verifier and uses no caller key", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.wire();
    await start(h, "browser-key");
    const old = h.spawn.mock.calls[0][2].env.ROUTER_API_KEY;
    h.children[0].emit("exit", 1);
    await vi.advanceTimersByTimeAsync(5600);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    const next = h.spawn.mock.calls[1][2].env.ROUTER_API_KEY;
    expect(next).not.toBe(old);
    expect(matchesLocalVerifier(old, h.settings.mitmInternalVerifier)).toBe(false);
    expect(matchesLocalVerifier(next, h.settings.mitmInternalVerifier)).toBe(true);
    expect(h.db.updateSettings.mock.calls.filter(([p]) => p.mitmInternalVerifier)).toHaveLength(2);
  });

  it("stops old child before installing replacement verifier", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.wire();
    await start(h);
    const first = h.children[0];
    h.db.updateSettings.mockImplementation(async (patch) => {
      if (patch.mitmInternalVerifier) expect(first.killed).toBe(true);
      Object.assign(h.settings, patch);
    });
    await start(h);
    expect(h.spawn).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "failed spawn compare-clears only its own verifier (replacement=%s)",
    async (replacement) => {
      vi.useFakeTimers();
      const h = harness();
      h.wire();
      const newer = runtime.createLocalCredential().verifierHash;
      h.spawn.mockImplementation(() => {
        if (replacement) h.settings.mitmInternalVerifier = newer;
        throw new Error("spawn failed");
      });
      const promise = h.manager.startMitm(null, "password");
      const assertion = expect(promise).rejects.toThrow("spawn failed");
      await vi.advanceTimersByTimeAsync(600);
      await assertion;
      expect(h.settings.mitmInternalVerifier).toBe(replacement ? newer : null);
    },
  );

  it("redacts child output and keeps sudo argv, status and settings secret-free", async () => {
    vi.useFakeTimers();
    const h = harness({ sudo: true });
    h.wire();
    await start(h);
    const [command, argv, options] = h.spawn.mock.calls[0];
    const raw = options.env.ROUTER_API_KEY;
    expect(command).toBe("sudo");
    expect(argv).toEqual(["-S", "-E", "/mock/node", expect.any(String)]);
    expect(JSON.stringify([command, argv])).not.toContain(raw);
    h.children[0].stdout.emit("data", Buffer.from(raw.slice(0, 10)));
    h.children[0].stdout.emit("data", Buffer.from(`${raw.slice(10)}\n`));
    h.children[0].stderr.emit("data", Buffer.from(`error ${raw}`));
    expect(h.logs.join("")).not.toContain(raw);
    expect(JSON.stringify(await h.manager.getMitmStatus())).not.toContain(raw);
    expect(JSON.stringify(h.settings)).not.toContain(raw);
  });

  it.each(["env", "file"])(
    "reads remote %s at startup and reuses memory across restart",
    async (type) => {
      vi.useFakeTimers();
      const file = path.join(assertIsolatedHome(), "mitm-lifecycle-key");
      vi.stubEnv("TOKENHOP_MITM_REMOTE_API_KEY", type === "env" ? "operator-key" : "");
      vi.stubEnv("TOKENHOP_MITM_REMOTE_API_KEY_FILE", type === "file" ? file : "");
      if (type === "file") await writeFile(file, "operator-key\n");
      const router = "https://remote.example";
      const remote = await runtime.readRemoteCredential({
        routerBaseUrl: router,
        source: resolveRemoteSource(),
      });
      const h = harness({ router, remoteKey: remote.apiKey });
      h.wire();
      await start(h);
      vi.stubEnv("TOKENHOP_MITM_REMOTE_API_KEY", "changed-key");
      if (type === "file") await writeFile(file, "changed-key");
      h.children[0].emit("exit", 1);
      await vi.advanceTimersByTimeAsync(5600);
      expect(h.spawn).toHaveBeenCalledTimes(2);
      for (const [, argv, opts] of h.spawn.mock.calls) {
        expect(opts.env.ROUTER_API_KEY).toBe("operator-key");
        expect(JSON.stringify(argv)).not.toContain("operator-key");
      }
      expect(JSON.stringify(h.settings)).not.toContain("operator-key");
      expect(h.settings.mitmInternalVerifier).toBeUndefined();
    },
  );

  it("remote explicit start binds same-destination restart and refuses endpoint change", async () => {
    vi.useFakeTimers();
    const router = "https://remote.example";
    const h = harness({ router });
    h.wire();
    await start(h, "typed-remote-key");
    expect(h.spawn.mock.calls[0][2].env.ROUTER_API_KEY).toBe("typed-remote-key");
    expect(JSON.stringify(h.settings)).not.toContain("typed-remote-key");
    expect(h.settings.mitmInternalVerifier).toBeUndefined();
    h.children[0].emit("exit", 1);
    await vi.advanceTimersByTimeAsync(5600);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(h.spawn.mock.calls[1][2].env.ROUTER_API_KEY).toBe("typed-remote-key");
    h.settings.mitmRouterBaseUrl = "https://other.example";
    // A start without a fresh value refuses instead of reusing the old binding.
    const refused = h.manager.startMitm(null, "password");
    const refusedAssertion = expect(refused).rejects.toThrow("operator-supplied credential");
    await vi.advanceTimersByTimeAsync(600);
    await refusedAssertion;
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(h.logs.join("")).not.toContain("typed-remote-key");
    expect(h.manager.hasManualRemoteBinding("https://other.example")).toBe(false);
  });

  it("local rotation never reuses internal credential remotely and rejects bad manual values", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.wire();
    await start(h);
    const local = h.spawn.mock.calls[0][2].env.ROUTER_API_KEY;
    h.settings.mitmRouterBaseUrl = "https://remote.example";
    // Valid typed remote key on changed endpoint works; internal key never reused.
    await start(h, "typed-remote-key-2");
    expect(h.spawn.mock.calls[1][2].env.ROUTER_API_KEY).toBe("typed-remote-key-2");
    expect(h.spawn.mock.calls[1][2].env.ROUTER_API_KEY).not.toBe(local);
    // No-key start against yet another endpoint refuses instead of reusing.
    h.settings.mitmRouterBaseUrl = "https://other.example";
    const refused = h.manager.startMitm(null, "password");
    const refusedAssertion = expect(refused).rejects.toThrow("operator-supplied credential");
    await vi.advanceTimersByTimeAsync(600);
    await refusedAssertion;
    const second = harness({ router: "https://remote.example" });
    second.wire();
    const bad = second.manager.startMitm("bad\nkey", "password");
    const badAssertion = expect(bad).rejects.toThrow("Invalid MITM credential");
    await vi.advanceTimersByTimeAsync(600);
    await badAssertion;
    expect(second.spawn).not.toHaveBeenCalled();
    expect(JSON.stringify(second.settings)).not.toContain(local);
  });

  it.each([
    ["linux", false],
    ["linux", true],
    ["win32", false],
  ])(
    "strips parent secrets on %s (sudo=%s) for local and remote children",
    async (platform, sudo) => {
      vi.useFakeTimers();
      const h = harness({ platform, sudo });
      h.wire();
      await start(h);
      h.settings.mitmRouterBaseUrl = "https://other.example";
      await start(h, "selected-remote-sentinel");
      for (const [command, argv, options] of h.spawn.mock.calls) {
        const env = options.env;
        const selected = env.ROUTER_API_KEY;
        expect(selected).toBeTruthy();
        expect(env.KEEP_ME).toBe("runtime-env");
        expect(Object.values(env).filter((v) => v === selected)).toHaveLength(1);
        for (const key of [
          "TOKENHOP_MITM_REMOTE_API_KEY",
          "TOKENHOP_MITM_REMOTE_API_KEY_FILE",
          "TOKENHOP_MASTER_KEY",
        ])
          expect(env).not.toHaveProperty(key);
        const sinks = JSON.stringify([
          command,
          argv,
          options,
          h.settings,
          h.logs,
          await h.manager.getMitmStatus(),
        ]);
        for (const secret of [
          "parent-env-sentinel",
          "/parent/file-sentinel",
          "parent-root-sentinel",
        ])
          expect(sinks).not.toContain(secret);
        expect(JSON.stringify([command, argv, h.settings, h.logs])).not.toContain(selected);
      }
      expect(h.spawn.mock.calls[1][2].env.ROUTER_API_KEY).toBe("selected-remote-sentinel");
    },
  );

  it("explicit typed key against the startup source conflicts instead of shadowing", async () => {
    vi.useFakeTimers();
    const router = "https://remote.example";
    const h = harness({ router, remoteKey: "operator-key" });
    h.wire();
    const conflict = h.manager.startMitm("typed-other-key", "password");
    const assertion = expect(conflict).rejects.toThrowError(
      expect.objectContaining({ code: "MITM_STARTUP_SOURCE_LOCKED" }),
    );
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.manager.hasManualRemoteBinding(router)).toBe(false);
  });

  it("rejects mutually exclusive operator sources and recognizes IPv6 loopback", () => {
    expect(() =>
      resolveRemoteSource({
        TOKENHOP_MITM_REMOTE_API_KEY: "key",
        TOKENHOP_MITM_REMOTE_API_KEY_FILE: "/file",
      }),
    ).toThrow("mutually exclusive");
    expect(isLocalRouterBaseUrl("http://[::1]:20128")).toBe(true);
  });

  it("legacy direct start keeps supplied client credential and no verifier", async () => {
    vi.useFakeTimers();
    const h = harness();
    await start(h, "legacy-client-key");
    expect(h.spawn.mock.calls[0][2].env.ROUTER_API_KEY).toBe("legacy-client-key");
    expect(h.settings.mitmInternalVerifier).toBeUndefined();
    await expect(h.manager.startMitm("legacy-client-key", "password")).rejects.toThrow(
      "already running",
    );
  });
});
