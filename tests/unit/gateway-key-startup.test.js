// YAN-363: startup ownership + readiness — real isolated child processes
// contending for one DATA_DIR (second writer rejected before any DB
// mutation), independent DATA_DIRs allowed, stale-PID takeover, never
// deleting an unverifiable lock, per-process/HMR reuse, build skip, sticky
// readiness rejection, and legacy-off leaving no key/hash/owner side
// effects. Activation stays unwired: no test invokes the hash migration.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  acquireExclusiveWriterLock,
  holdsExclusiveWriterLock,
  releaseExclusiveWriterLock,
  WRITER_LOCK_NAME,
} from "@/lib/db/processLock.js";
import {
  ensureGatewayKeyStartup,
  isGatewayKeyStartupReady,
  resetGatewayKeyStartupForTests,
  whenGatewayKeyStartupReady,
} from "@/lib/db/startupReadiness.js";
import { DATA_DIR } from "@/lib/dataDir.js";

const src = fileURLToPath(new URL("../../src", import.meta.url));
const DATA_FILE = path.join(DATA_DIR, "db", "data.sqlite");
const lockFileIn = (dir) => path.join(dir, WRITER_LOCK_NAME);
const writeLock = (dir, owner) => fs.writeFileSync(lockFileIn(dir), JSON.stringify(owner), "utf8");
const readLock = (dir) => fs.readFileSync(lockFileIn(dir), "utf8");

let tmp;
const dirs = [];
const dir = (name) => {
  const d = fs.mkdtempSync(path.join(tmp, `${name}-`));
  dirs.push(d);
  return fs.realpathSync(d);
};
const parentHandles = [];
const acquire = (d) => {
  const h = acquireExclusiveWriterLock(d);
  parentHandles.push(h);
  return h;
};

// Real separate processes running the real processLock source. The repo has
// no "type": "module", so plain `node` cannot import the src file directly;
// copy it to .mjs and fail the test if it ever gains a non-builtin import.
const CHILD_MAIN = `
import fs from "node:fs";
import { acquireExclusiveWriterLock } from "./processLock.mjs";
const [mode, dir, ms, marker] = process.argv.slice(2);
try {
  acquireExclusiveWriterLock(dir);
  fs.writeFileSync(marker, mode === "hold" ? "held" : "acquired");
  if (mode === "hold") {
    const until = Date.now() + Number(ms);
    while (Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  }
} catch (err) {
  fs.writeFileSync(marker + ".err", (err && err.code) || String(err));
  process.exitCode = 1;
}
`;
function childRoot() {
  const root = fs.mkdtempSync(path.join(tmp, "child-"));
  dirs.push(root);
  const source = fs.readFileSync(path.join(src, "lib/db/processLock.js"), "utf8");
  const badImport = source.match(/from\s+"(?!node:)[^"]+"/);
  if (badImport)
    throw new Error(
      `processLock.js gained a non-builtin import (${badImport[0]}); child harness needs a loader`,
    );
  fs.writeFileSync(path.join(root, "processLock.mjs"), source);
  fs.writeFileSync(path.join(root, "main.mjs"), CHILD_MAIN);
  return root;
}
function runChild(root, mode, dirPath, ms = 0) {
  const marker = path.join(root, `${mode}-${dirs.length}.marker`);
  const child = spawn(process.execPath, [path.join(root, "main.mjs"), mode, dirPath, ms, marker], {
    stdio: "ignore",
  });
  return { child, marker };
}
async function waitFor(fn, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const waitExit = (child, ms = 8000) =>
  new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
    setTimeout(() => reject(new Error("child exit timeout")), ms);
  });

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-key-startup-"));
});
afterEach(() => {
  resetGatewayKeyStartupForTests();
  delete process.env.NEXT_PHASE;
  for (const h of parentHandles.splice(0)) {
    try {
      releaseExclusiveWriterLock(h);
    } catch {}
  }
});
afterAll(() => {
  for (const h of parentHandles.splice(0)) {
    try {
      releaseExclusiveWriterLock(h);
    } catch {}
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("YAN-363 startup ownership (processLock)", () => {
  it("a second writer process on the same DATA_DIR is rejected before any DB mutation", async () => {
    const root = childRoot();
    const { child, marker } = runChild(root, "hold", DATA_DIR, 1200);
    try {
      await waitFor(() => fs.existsSync(marker)); // child owns the DATA_DIR lock
      // Parent (second writer) via the coordinator + the driver path: must
      // reject with DB_WRITER_LOCK_HELD before any adapter open/migration.
      await expect(ensureGatewayKeyStartup()).rejects.toMatchObject({
        code: "DB_WRITER_LOCK_HELD",
      });
      expect(fs.existsSync(DATA_FILE)).toBe(false); // no DB mutation happened
    } finally {
      await waitExit(child);
    }
    // Lock released by the child's own exit hook; with a fresh sticky
    // promise the parent can now start.
    resetGatewayKeyStartupForTests();
    await expect(ensureGatewayKeyStartup()).resolves.toBeUndefined();
  });

  it("independent DATA_DIRs acquire concurrently", async () => {
    const root = childRoot();
    const x = dir("x");
    const { child, marker } = runChild(root, "hold", x, 1000);
    try {
      await waitFor(() => fs.existsSync(marker));
      const y = dir("y");
      const handle = acquire(y); // parent: different dir is allowed
      expect(handle.pid).toBe(process.pid);
      expect(holdsExclusiveWriterLock(y)).toBe(true);
    } finally {
      await waitExit(child);
    }
  });

  it("same process + HMR-style reuse is idempotent; readiness promise is one object", async () => {
    const d = dir("idem");
    const first = acquire(d);
    expect(acquireExclusiveWriterLock(d)).toEqual(first); // per-process reuse
    const p1 = ensureGatewayKeyStartup({
      acquireLock: () => first,
      openDb: async () => ({}),
      activate: async () => {},
    });
    const p2 = ensureGatewayKeyStartup({
      acquireLock: () => first,
      openDb: async () => ({}),
      activate: async () => {},
    });
    expect(p2).toBe(p1); // HMR re-invocation returns the sticky promise
    await p1;
    expect(isGatewayKeyStartupReady()).toBe(true);
  });

  it("stale lock with a verifiably dead PID is taken over safely", () => {
    const d = dir("stale");
    const gone = spawnSync(process.execPath, ["-e", ""]);
    expect(gone.status).toBe(0); // its PID is dead (no PID-reuse adoption here:
    // takeover requires kill(pid,0) === ESRCH, so a reused-live PID is held)
    writeLock(d, { pid: gone.pid, token: "dead-owner-token", path: lockFileIn(d) });
    const handle = acquire(d);
    expect(handle.pid).toBe(process.pid);
    expect(handle.token).not.toBe("dead-owner-token");
    expect(JSON.parse(readLock(d)).token).toBe(handle.token);
  });

  it("never deletes or adopts an unverifiable/forged lock; a live owner is authority", () => {
    const corrupt = dir("corrupt");
    fs.writeFileSync(lockFileIn(corrupt), "{not-json", "utf8");
    expect(() => acquireExclusiveWriterLock(corrupt)).toThrow();
    expect(readLock(corrupt)).toBe("{not-json"); // byte-identical, never deleted

    // Live stranger (parent) with a legacy lock (no start time): fail closed.
    const live = dir("live");
    const forged = { pid: process.ppid, token: "forged-not-ours", path: lockFileIn(live) };
    writeLock(live, forged); // forged content is not authority: PID alive → held
    expect(() => acquireExclusiveWriterLock(live)).toThrow(/DATA_DIR already owned/);
    expect(JSON.parse(readLock(live))).toEqual(forged);

    const foreign = dir("foreign");
    const other = { pid: process.ppid, token: "someone-else", path: lockFileIn(foreign) };
    writeLock(foreign, other);
    expect(() => acquireExclusiveWriterLock(foreign)).toThrow();
    const bogus = { ...other, token: "wrong-token" }; // release needs exact match
    expect(() => releaseExclusiveWriterLock(bogus)).toThrow();
    expect(JSON.parse(readLock(foreign))).toEqual(other);
  });

  it("a legacy lock (no start time) naming this pid is a predecessor's leftover and is reclaimed", () => {
    const d = dir("legacy-self");
    writeLock(d, { pid: process.pid, token: "forged-not-ours", path: lockFileIn(d) });
    const handle = acquire(d);
    expect(handle.token).not.toBe("forged-not-ours");
    expect(JSON.parse(readLock(d))).toMatchObject({ pid: process.pid, token: handle.token });
    expect(JSON.parse(readLock(d)).start).toBe(handle.start); // new claim carries a start time
  });

  it("a legacy self-pid lock is NOT reclaimed from a worker thread (shared pid, separate registry)", async () => {
    const root = childRoot();
    const d = dir("legacy-worker");
    const before = { pid: process.pid, token: "sibling-claim", path: lockFileIn(d) };
    writeLock(d, before);
    const worker = path.join(root, "worker.mjs");
    fs.writeFileSync(
      worker,
      `import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { acquireExclusiveWriterLock } from "./processLock.mjs";
try {
  acquireExclusiveWriterLock(workerData);
  parentPort.postMessage("acquired");
} catch (err) {
  parentPort.postMessage(err.code || String(err));
}
`,
    );
    const { Worker } = await import("node:worker_threads");
    const result = await new Promise((resolve, reject) => {
      const w = new Worker(worker, { workerData: d });
      w.once("message", resolve);
      w.once("error", reject);
    });
    expect(result).toBe("DB_WRITER_LOCK_HELD");
    expect(readLock(d)).toBe(JSON.stringify(before)); // byte-identical
  });

  it("build/prerender phases skip the lock and serve no activation", async () => {
    const d = dir("build");
    let acquireCalled = false;
    process.env.NEXT_PHASE = "phase-production-build";
    await expect(
      ensureGatewayKeyStartup({
        dataDir: d,
        acquireLock: () => {
          acquireCalled = true;
        },
        openDb: async () => {
          throw new Error("must not open the DB during build");
        },
      }),
    ).resolves.toBeUndefined();
    expect(acquireCalled).toBe(false);
    expect(fs.existsSync(lockFileIn(d))).toBe(false);
    await expect(whenGatewayKeyStartupReady()).resolves.toBeUndefined();
  });
});

describe("YAN-363 startup readiness (startupReadiness)", () => {
  it("order is lock → open → activate; nothing is ready until activation settles", async () => {
    const order = [];
    let releaseOpen;
    const opened = new Promise((r) => (releaseOpen = r));
    let activateStarted = false;
    let releaseActivate;
    const activated = new Promise((r) => (releaseActivate = r));
    const starting = ensureGatewayKeyStartup({
      acquireLock: () => {
        order.push("lock");
      },
      openDb: async () => {
        order.push("open");
        await opened;
        return { marker: true };
      },
      activate: async () => {
        activateStarted = true;
        order.push("activate");
        await activated;
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(["lock", "open"]); // no app writes past open yet
    expect(activateStarted).toBe(false); // open not settled → activate not called
    releaseOpen();
    await waitFor(() => activateStarted);
    expect(isGatewayKeyStartupReady()).toBe(false);
    releaseActivate();
    await starting;
    expect(order).toEqual(["lock", "open", "activate"]);
    expect(isGatewayKeyStartupReady()).toBe(true);
    await expect(whenGatewayKeyStartupReady()).resolves.toBeUndefined();
  });

  it("failure is sticky, retains the closed state, and never re-runs callbacks", async () => {
    let attempts = 0;
    const boom = ensureGatewayKeyStartup({
      acquireLock: () => {},
      openDb: async () => ({}),
      activate: async () => {
        attempts++;
        throw new Error("activation refused");
      },
    });
    await expect(boom).rejects.toThrow("activation refused");
    expect(attempts).toBe(1);
    expect(isGatewayKeyStartupReady()).toBe(false); // closed stays closed
    const again = ensureGatewayKeyStartup({
      acquireLock: () => {
        throw new Error("must not reacquire");
      },
    });
    expect(again).toBe(boom); // same sticky rejection, no callbacks re-run
    await expect(again).rejects.toThrow("activation refused");
    await expect(whenGatewayKeyStartupReady()).rejects.toThrow("activation refused");
    expect(attempts).toBe(1);
    resetGatewayKeyStartupForTests();
    await expect(
      ensureGatewayKeyStartup({
        acquireLock: () => {},
        openDb: async () => ({}),
        activate: async () => {},
      }),
    ).resolves.toBeUndefined();
  });

  it("legacy off: real driver startup creates no key root, hash markers or owner rows", async () => {
    const isolatedDir = dir("legacy-off");
    const savedDir = process.env.DATA_DIR;
    const savedSwitch = process.env.TOKENHOP_MULTI_USER;
    let db;
    try {
      process.env.DATA_DIR = isolatedDir;
      process.env.TOKENHOP_MULTI_USER = "off";
      // Both DATA_DIR and featureSwitch's ENV_OVERRIDE are captured on import.
      // Fresh modules + directory avoid the earlier real startup's hashed DB
      // on the CI "on" leg; no driver or activation hooks replace production.
      vi.resetModules();
      const startup = await import("@/lib/db/startupReadiness.js");
      startup.resetGatewayKeyStartupForTests();
      await expect(startup.ensureGatewayKeyStartup()).resolves.toBeUndefined();
      const { getAdapter } = await import("@/lib/db/driver.js");
      db = await getAdapter();
      // Lock already held by this process (same pid+token registry entry):
      // releasing here would let the driver path re-fail as foreign.
      expect(fs.existsSync(path.join(isolatedDir, "keys"))).toBe(false); // no master key root
      const { readApiKeyStorageState } = await import("@/lib/db/apiKeyState.js");
      expect(readApiKeyStorageState(db).storage).toBe("legacy"); // no hash markers
      expect(db.get("SELECT value FROM _meta WHERE key = 'apiKeysHashKid'")).toBeUndefined();
      expect(db.get("SELECT COUNT(*) AS c FROM users").c).toBe(0); // no owner bootstrap side effect
    } finally {
      db?.close();
      // The fresh processLock copy owns the isolatedDir claim (shared
      // pid-keyed registry). Static-import release would see a "foreign"
      // handle from its own copy — release through the same fresh copy.
      const registry = globalThis[Symbol.for(`tokenhop.writerLocks.${process.pid}`)];
      const { releaseExclusiveWriterLock: release } = await import("@/lib/db/processLock.js");
      // Scope to the isolated dir only: the registry is per-pid shared, other
      // tests' handles (DATA_DIR, y, etc.) must survive.
      const prefix = `${fs.realpathSync(isolatedDir)}${path.sep}`;
      for (const handle of registry ? [...registry.owners.values()] : []) {
        if (!handle.path.startsWith(prefix)) continue;
        try {
          release(handle);
        } catch {}
      }
      if (savedDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = savedDir;
      if (savedSwitch === undefined) delete process.env.TOKENHOP_MULTI_USER;
      else process.env.TOKENHOP_MULTI_USER = savedSwitch;
      resetGatewayKeyStartupForTests();
      vi.resetModules();
    }
  });
});
