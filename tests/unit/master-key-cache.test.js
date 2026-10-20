// YAN-1106: loadMasterKey reuses a validated root only while fresh lstat
// fingerprints of the keys dir and file are unchanged. Every way the root can
// legitimately or maliciously change must be seen on the very next call, and
// every original fail-closed check must still fire.
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";

const root = process.env.TOKENHOP_TEST_ROOT;
const A = crypto.randomBytes(32);
const B = crypto.randomBytes(32);
let dataDir;
let file;
let mk;

const put = (target, key, mode = 0o600) => {
  fsSync.writeFileSync(target, key, { mode });
  fsSync.chmodSync(target, mode);
};
// Files younger than the racy window are deliberately never cached; move only
// the Date clock forward so the entry becomes cacheable without sleeping.
const settle = () => vi.setSystemTime(Date.now() + 10_000);
const statSpy = () => vi.spyOn(fsSync, "readSync");

beforeEach(async () => {
  assertIsolatedHome();
  dataDir = await fs.mkdtemp(path.join(root, "master-cache-"));
  file = path.join(dataDir, "keys", "master");
  fsSync.mkdirSync(path.dirname(file), { mode: 0o700 });
  fsSync.chmodSync(path.dirname(file), 0o700);
  put(file, A);
  vi.stubEnv("DATA_DIR", dataDir);
  vi.stubEnv("TOKENHOP_MASTER_KEY", undefined);
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  mk = await import("@/lib/security/masterKey.js");
  mk.clearMasterKeyCache();
});

afterEach(() => {
  mk.clearMasterKeyCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("loadMasterKey fingerprint memo", () => {
  it("serves repeats without re-reading the file once the root has settled", async () => {
    const first = await mk.loadMasterKey();
    expect(first.key.equals(A)).toBe(true);
    settle();
    await mk.loadMasterKey(); // populates (file is now old enough)
    const spy = statSpy();
    const again = await mk.loadMasterKey();
    expect(spy).not.toHaveBeenCalled();
    expect(again.key.equals(A)).toBe(true);
    expect(again.kid).toBe(first.kid);
  });

  it("a freshly written root is never cached (racy-clean rule)", async () => {
    await mk.loadMasterKey();
    const spy = statSpy();
    await mk.loadMasterKey();
    expect(spy).toHaveBeenCalled();
  });

  it("hands out private copies: zeroing a result never corrupts the memo", async () => {
    await mk.loadMasterKey();
    settle();
    const one = await mk.loadMasterKey();
    one.key.fill(0);
    const two = await mk.loadMasterKey();
    expect(two.key.equals(A)).toBe(true);
    two.key.fill(0);
    expect((await mk.loadMasterKey()).key.equals(A)).toBe(true);
  });

  it("atomic rename of a new root is seen on the next call", async () => {
    await mk.loadMasterKey();
    settle();
    await mk.loadMasterKey();
    const staged = `${file}.next`;
    put(staged, B);
    fsSync.renameSync(staged, file);
    const after = await mk.loadMasterKey();
    expect(after.key.equals(B)).toBe(true);
    expect(after.kid).toBe(mk.masterKeyId(B));
  });

  it("a rename that preserves size and mtime is still seen (inode/ctime move)", async () => {
    await mk.loadMasterKey();
    settle();
    await mk.loadMasterKey();
    const old = fsSync.statSync(file);
    const staged = `${file}.next`;
    put(staged, B);
    fsSync.utimesSync(staged, old.atime, old.mtime);
    fsSync.renameSync(staged, file);
    expect((await mk.loadMasterKey()).key.equals(B)).toBe(true);
  });

  it("an in-place rewrite with restored mtime is still seen (ctime moves)", async () => {
    await mk.loadMasterKey();
    settle();
    await mk.loadMasterKey();
    const old = fsSync.statSync(file);
    const fd = fsSync.openSync(file, "r+");
    fsSync.writeSync(fd, B, 0, 32, 0);
    fsSync.closeSync(fd);
    fsSync.utimesSync(file, old.atime, old.mtime);
    expect((await mk.loadMasterKey()).key.equals(B)).toBe(true);
  });

  it("expectedKid mismatch fails closed on a cache hit", async () => {
    await mk.loadMasterKey();
    settle();
    await mk.loadMasterKey();
    await expect(mk.loadMasterKey({ expectedKid: "0000000000000000" })).rejects.toMatchObject({
      code: "MASTER_KEY_INVALID",
    });
    expect((await mk.loadMasterKey({ expectedKid: mk.masterKeyId(A) })).key.equals(A)).toBe(true);
  });

  it("loosened file mode fails closed on the next call", async () => {
    await mk.loadMasterKey();
    settle();
    await mk.loadMasterKey();
    fsSync.chmodSync(file, 0o644);
    await expect(mk.loadMasterKey()).rejects.toMatchObject({ code: "MASTER_KEY_INVALID" });
  });

  it("loosened keys directory mode fails closed on the next call", async () => {
    await mk.loadMasterKey();
    settle();
    await mk.loadMasterKey();
    fsSync.chmodSync(path.dirname(file), 0o755);
    await expect(mk.loadMasterKey()).rejects.toMatchObject({ code: "MASTER_KEY_INVALID" });
  });

  it("swapping the file for a symlink fails closed on the next call", async () => {
    await mk.loadMasterKey();
    settle();
    await mk.loadMasterKey();
    const decoy = path.join(dataDir, "decoy");
    put(decoy, A);
    fsSync.rmSync(file);
    fsSync.symlinkSync(decoy, file);
    await expect(mk.loadMasterKey()).rejects.toMatchObject({ code: "MASTER_KEY_INVALID" });
  });

  it("swapping the keys directory for a symlink fails closed on the next call", async () => {
    await mk.loadMasterKey();
    settle();
    await mk.loadMasterKey();
    const real = path.join(dataDir, "keys-real");
    fsSync.renameSync(path.dirname(file), real);
    fsSync.symlinkSync(real, path.dirname(file));
    await expect(mk.loadMasterKey()).rejects.toMatchObject({ code: "MASTER_KEY_INVALID" });
  });

  it("deleting the root fails closed (KEY_MISSING), never serves the memo", async () => {
    await mk.loadMasterKey();
    settle();
    await mk.loadMasterKey();
    fsSync.rmSync(file);
    await expect(mk.loadMasterKey({ expectedKid: mk.masterKeyId(A) })).rejects.toMatchObject({
      code: "KEY_MISSING",
    });
  });

  it("a truncated or grown root fails closed", async () => {
    await mk.loadMasterKey();
    settle();
    await mk.loadMasterKey();
    fsSync.writeFileSync(file, Buffer.alloc(31, 1));
    await expect(mk.loadMasterKey()).rejects.toMatchObject({ code: "MASTER_KEY_INVALID" });
  });

  it("the memo expires and re-validates after its TTL", async () => {
    await mk.loadMasterKey();
    settle();
    await mk.loadMasterKey();
    vi.setSystemTime(Date.now() + 60_000);
    const spy = statSpy();
    await mk.loadMasterKey();
    expect(spy).toHaveBeenCalled();
  });

  it("env-managed roots bypass the file memo entirely", async () => {
    vi.stubEnv("TOKENHOP_MASTER_KEY", B.toString("base64"));
    expect((await mk.loadMasterKey()).key.equals(B)).toBe(true);
    vi.stubEnv("TOKENHOP_MASTER_KEY", A.toString("base64"));
    expect((await mk.loadMasterKey()).key.equals(A)).toBe(true);
  });

  it("promoting a staged root drops the memo in-process", async () => {
    await mk.loadMasterKey();
    settle();
    await mk.loadMasterKey();
    mk.stageMasterKeySync(B);
    mk.promoteStagedMasterSync();
    expect((await mk.loadMasterKey()).key.equals(B)).toBe(true);
  });

  it("zeroes the cached root at TTL with no further calls (timer, not lazy)", async () => {
    await mk.loadMasterKey();
    settle();
    // Capture the retained buffer: the cache stores its own copy, so spy on fill().
    const fills = [];
    const realFill = Buffer.prototype.fill;
    vi.spyOn(Buffer.prototype, "fill").mockImplementation(function (...args) {
      if (this.length === 32 && this.equals(A)) fills.push(this);
      return realFill.apply(this, args);
    });
    await mk.loadMasterKey(); // populates the memo (file is old enough)
    expect(vi.getTimerCount()).toBe(1);
    expect(fills).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fills.length).toBe(1);
    expect(fills[0].equals(Buffer.alloc(32))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the expiry timer is unref'd so it never holds the process open", async () => {
    await mk.loadMasterKey();
    settle();
    const unref = vi.fn();
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((...a) => {
      const t = realSetTimeout(...a);
      const orig = t.unref?.bind(t);
      t.unref = () => {
        unref();
        return orig?.() ?? t;
      };
      return t;
    });
    await mk.loadMasterKey();
    expect(unref).toHaveBeenCalled();
  });

  it("re-populating replaces the timer instead of stacking them", async () => {
    await mk.loadMasterKey();
    settle();
    await mk.loadMasterKey();
    mk.clearMasterKeyCache();
    await mk.loadMasterKey();
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    mk.clearMasterKeyCache();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("taking the env path drops and zeroes any cached file root", async () => {
    await mk.loadMasterKey();
    settle();
    await mk.loadMasterKey();
    expect(vi.getTimerCount()).toBe(1);
    vi.stubEnv("TOKENHOP_MASTER_KEY", B.toString("base64"));
    await mk.loadMasterKey();
    expect(vi.getTimerCount()).toBe(0);
    vi.stubEnv("TOKENHOP_MASTER_KEY", undefined);
    // The file root is re-read from disk, not served from a lingering entry.
    const spy = statSpy();
    expect((await mk.loadMasterKey()).key.equals(A)).toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it("two module copies share one root cache, timer and listener registry", async () => {
    await mk.loadMasterKey();
    settle();
    await mk.loadMasterKey(); // populates through copy 1
    const slot = globalThis[Symbol.for("tokenhop.masterKeyCache")];
    expect(slot.entry).toBeTruthy();
    vi.resetModules();
    const copy = await import("@/lib/security/masterKey.js");
    expect(copy === mk).toBe(false);
    const heard = vi.fn();
    const off = mk.onMasterKeyChange(heard, "probe");
    // copy 2 sees copy 1's entry: the next load is a memo hit (no file read)
    const spy = statSpy();
    expect((await copy.loadMasterKey()).key.equals(A)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    // and copy 2's clear zeroes it and notifies copy 1's listener
    const retained = slot.entry.key;
    copy.clearMasterKeyCache();
    expect(retained.equals(Buffer.alloc(32))).toBe(true);
    expect(slot.entry).toBeNull();
    expect(heard).toHaveBeenCalled();
    off();
  });

  it("re-registering a listener id replaces the previous listener", async () => {
    const a = vi.fn();
    const b = vi.fn();
    mk.onMasterKeyChange(a, "same");
    mk.onMasterKeyChange(b, "same");
    mk.clearMasterKeyCache();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
