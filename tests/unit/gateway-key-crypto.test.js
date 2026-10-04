// YAN-363 P0: unused crypto contracts; run only with tests/vitest.config.js.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";

const root = process.env.TOKENHOP_TEST_ROOT;
const savedDataDir = process.env.DATA_DIR;
const master = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const raw = "th_0123456789ABCDEFGHIJKLMNOPQRSTUV";
const hashKeyHex = "427a475d41adbbd70df800750185bb720ec34a0a62c5fcb0a7e7062e27acc407";
const digest = "f2d48467c679c855ceecbfbd25ee3e027f783183ccb769e7b94f756e95c9d905";
const kid = "630dcd2966c43366";
let dataDir;
let file;

const apiKeys = () => import("@/shared/utils/apiKey.js");
const security = () => import("@/lib/security/masterKey.js");
const exists = async (target) => {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
};

beforeEach(async () => {
  assertIsolatedHome();
  // Fail closed before any writes, even if test setup/config changes.
  const rel = path.relative(root, savedDataDir);
  expect(rel).not.toBe("");
  expect(rel.startsWith("..")).toBe(false);
  expect(path.isAbsolute(rel)).toBe(false);
  dataDir = await fs.mkdtemp(path.join(root, "gateway-crypto-"));
  file = path.join(dataDir, "keys", "master");
  vi.stubEnv("DATA_DIR", dataDir);
  vi.stubEnv("TOKENHOP_MASTER_KEY", undefined);
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("gateway key generation", () => {
  it("generates distinct th_ +32 base62 tokens", async () => {
    const { generateGatewayApiKey } = await apiKeys();
    const keys = Array.from({ length: 64 }, () => generateGatewayApiKey());
    for (const key of keys) expect(key).toMatch(/^th_[0-9A-Za-z]{32}$/);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("rejects bytes 248..255, accepts 247, maps accepted bytes modulo62", async () => {
    // Native default crypto object is also used by existing legacy utility.
    // Compare two equal accepted streams; alphabet order is deliberately not fixed.
    const random = vi.spyOn(crypto, "randomBytes");
    let reads = 0;
    random.mockImplementation((size) => {
      reads++;
      return Buffer.alloc(size, reads === 1 ? 247 : 0);
    });
    const { generateGatewayApiKey } = await apiKeys();
    const accepted = generateGatewayApiKey();
    expect(accepted).toMatch(/^th_[0-9A-Za-z]{32}$/);
    expect(reads).toBeGreaterThan(0);
    reads = 0;
    random.mockImplementation((size) => {
      reads++;
      // One full rejected batch, then identical accepted stream.
      return Buffer.alloc(size, reads === 1 ? 248 : reads === 2 ? 247 : 0);
    });
    expect(generateGatewayApiKey()).toBe(accepted);
    expect(reads).toBeGreaterThan(1);
    random.mockImplementation((size) => Buffer.alloc(size, 61));
    const mod61 = generateGatewayApiKey();
    random.mockImplementation((size) => Buffer.alloc(size, 247));
    expect(generateGatewayApiKey()).toBe(mod61); // 247 %62 ===61
    for (let byte = 249; byte <= 255; byte++) {
      reads = 0;
      random.mockImplementation((size) => Buffer.alloc(size, ++reads === 1 ? byte : 61));
      expect(generateGatewayApiKey()).toBe(mod61);
      expect(reads).toBeGreaterThan(1);
    }
  });

  it("displays first7 + Unicode ellipsis + last4 for new and legacy tokens", async () => {
    const { apiKeyPrefix } = await apiKeys();
    expect(apiKeyPrefix(raw)).toBe("th_0123…STUV");
    expect(apiKeyPrefix("sk-0123456789abcdef-abcdef-12345678")).toBe("sk-0123…5678");
  });

  it("preserves existing machine-key and old sk-* behavior", async () => {
    const m = await apiKeys();
    const { key, keyId } = m.generateApiKeyWithMachine("0123456789abcdef");
    expect(key).toMatch(/^sk-0123456789abcdef-[a-z0-9]{6}-[0-9a-f]{8}$/);
    expect(m.parseApiKey(key)).toEqual({ machineId: "0123456789abcdef", keyId, isNewFormat: true });
    expect(m.verifyApiKeyCrc(key)).toBe(true);
    expect(m.verifyApiKeyCrc(`${key.slice(0, -1)}${key.endsWith("0") ? "1" : "0"}`)).toBe(false);
    expect(m.parseApiKey("sk-abcdef12")).toEqual({
      machineId: null,
      keyId: "abcdef12",
      isNewFormat: false,
    });
    expect(m.verifyApiKeyCrc("sk-abcdef12")).toBe(true);
  });
});

describe("Node HKDF/HMAC/root fingerprint vectors", () => {
  it("matches fixed vectors and independent Node primitives", async () => {
    const { deriveApiKeyHashKey, hashApiKey, masterKeyId } = await security();
    // `master` means raw Buffer32, not loadMasterKey's { kid, key } wrapper.
    const derived = deriveApiKeyHashKey(master);
    expect(Buffer.from(derived).toString("hex")).toBe(hashKeyHex);
    expect(
      Buffer.from(
        crypto.hkdfSync("sha256", master, Buffer.alloc(0), "tokenhop/api-key-hash", 32),
      ).toString("hex"),
    ).toBe(hashKeyHex);
    expect(hashApiKey(raw, derived)).toBe(digest);
    expect(crypto.createHmac("sha256", derived).update(raw).digest("hex")).toBe(digest);
    expect(hashApiKey(raw, derived)).toBe(hashApiKey(raw, derived));
    expect(hashApiKey(`${raw}x`, derived)).not.toBe(digest);
    expect(hashApiKey(raw, deriveApiKeyHashKey(Buffer.alloc(32, 1)))).not.toBe(digest);
    expect(masterKeyId(master)).toBe(kid);
    expect(crypto.createHash("sha256").update(master).digest("hex").slice(0, 16)).toBe(kid);
  });
});

describe("lazy private master root", () => {
  it("import creates no keys; env is read lazily at load time", async () => {
    const m = await security();
    await apiKeys();
    expect(await exists(path.dirname(file))).toBe(false);
    vi.stubEnv("TOKENHOP_MASTER_KEY", master.toString("base64"));
    const result = await m.loadMasterKey();
    expect(Buffer.isBuffer(result.key)).toBe(true);
    expect(result.key.equals(master)).toBe(true);
    expect(result.kid).toBe(kid);
    expect(await exists(file)).toBe(false);
  });

  it.each([
    ["31 bytes", Buffer.alloc(31).toString("base64")],
    ["33 bytes", Buffer.alloc(33).toString("base64")],
    ["junk", "!!!not-base64!!!"],
    ["whitespace", ` ${master.toString("base64")}\n`],
    ["missing padding", master.toString("base64").replace(/=+$/, "")],
    ["noncanonical pad bits", `${master.toString("base64").slice(0, -2)}9=`],
  ])("rejects strict-base64 env violation: %s, even with create:true", async (_name, value) => {
    vi.stubEnv("TOKENHOP_MASTER_KEY", value);
    const { loadMasterKey } = await security();
    await expect(loadMasterKey({ create: true })).rejects.toThrow();
    expect(await exists(file)).toBe(false);
  });

  it("missing create:false root fails without creating keys", async () => {
    const { loadMasterKey } = await security();
    await expect(loadMasterKey()).rejects.toThrow();
    expect(await exists(file)).toBe(false);
  });

  it("creates through a missing DATA_DIR parent chain and unset DATA_DIR", async () => {
    const originalUmask = process.umask(0o077);
    try {
      // DATA_DIR unset resolves under the isolated HOME via getDataDir().
      const missing = path.join(dataDir, "no-such-parent", "nested");
      vi.stubEnv("DATA_DIR", missing);
      const { loadMasterKey } = await security();
      const created = await loadMasterKey({ create: true });
      expect(created.key).toHaveLength(32);
      expect((await fs.stat(path.join(missing, "keys", "master"))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.join(missing, "keys"))).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(originalUmask);
    }
    vi.stubEnv("DATA_DIR", undefined);
    vi.resetModules();
    const { getDataDir } = await import("@/lib/dataDir.js");
    const defaultDir = getDataDir();
    expect(path.relative(assertIsolatedHome(), defaultDir).startsWith("..")).toBe(false);
    expect(await exists(defaultDir)).toBe(false);
    const { loadMasterKey } = await security();
    const created = await loadMasterKey({ create: true });
    expect((await fs.readFile(path.join(defaultDir, "keys", "master"))).equals(created.key)).toBe(
      true,
    );
  });

  it.skipIf(process.platform === "win32")(
    "restrictive umask still creates usable private root",
    async () => {
      const originalUmask = process.umask(0o777);
      try {
        const { loadMasterKey } = await security();
        const first = await loadMasterKey({ create: true });
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
        expect((await loadMasterKey()).key.equals(first.key)).toBe(true);
      } finally {
        process.umask(originalUmask);
      }
    },
  );

  it("creates raw32 file0600 inside dir0700; fresh module reload preserves root", async () => {
    const { loadMasterKey } = await security();
    const first = await loadMasterKey({ create: true });
    expect(Buffer.isBuffer(first.key)).toBe(true);
    expect(first.key).toHaveLength(32);
    expect((await fs.readFile(file)).equals(first.key)).toBe(true);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    vi.resetModules();
    const restarted = await security();
    const second = await restarted.loadMasterKey({ expectedKid: first.kid });
    expect(second.key.equals(first.key)).toBe(true);
    expect(second.kid).toBe(restarted.masterKeyId(first.key));
  });

  it("concurrent exclusive creation converges, never returns partial roots", async () => {
    const { loadMasterKey } = await security();
    const results = await Promise.all(
      Array.from({ length: 16 }, () => loadMasterKey({ create: true })),
    );
    const persisted = await fs.readFile(file);
    expect(persisted).toHaveLength(32);
    for (const result of results) {
      expect(result.key).toHaveLength(32);
      expect(result.key.equals(persisted)).toBe(true);
      expect(result.kid).toBe(results[0].kid);
    }
    expect(await fs.readdir(path.dirname(file))).toEqual(["master"]);
  });

  it("reader at atomic publication sees complete synced bytes", async () => {
    const link = fs.link.bind(fs);
    let published;
    let release;
    const ready = new Promise((resolve) => {
      published = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      expect((await fs.stat(source)).size).toBe(32);
      await link(source, target);
      published();
      await gate;
    });
    const { loadMasterKey } = await security();
    const creating = loadMasterKey({ create: true });
    await ready;
    try {
      const reading = await loadMasterKey();
      expect(reading.key).toHaveLength(32);
      expect(reading.key.equals(await fs.readFile(file))).toBe(true);
    } finally {
      release();
      await creating;
    }
  });

  it("racing readers never observe an empty or partial root", async () => {
    // link(2) publishes only the complete file, so a create:false reader racing
    // initial creation sees either missing or the full converged root, never corrupt.
    const { loadMasterKey } = await security();
    const reader = () =>
      loadMasterKey().then(
        (r) => ({ key: r.key }),
        (e) => ({ error: e.message }),
      );
    const readers = Array.from({ length: 8 }, reader);
    const creators = Array.from({ length: 8 }, () => loadMasterKey({ create: true }));
    const [readResults, createResults] = await Promise.all([
      Promise.all(readers),
      Promise.all(creators),
    ]);
    const persisted = await fs.readFile(file);
    expect(persisted).toHaveLength(32);
    for (const result of createResults) expect(result.key.equals(persisted)).toBe(true);
    for (const result of readResults) {
      if (result.key) expect(result.key.equals(persisted)).toBe(true);
      else expect(result.error).toMatch(/missing/);
    }
    expect(await fs.readdir(path.dirname(file))).toEqual(["master"]);
  });

  it.skipIf(process.platform === "win32")(
    "symlinked master file is rejected without following it",
    async () => {
      const outside = path.join(dataDir, "outside");
      await fs.writeFile(outside, master);
      await fs.mkdir(path.dirname(file), { mode: 0o700 });
      await fs.symlink(outside, file);
      const { loadMasterKey } = await security();
      await expect(loadMasterKey({ create: true })).rejects.toThrow(/symlink/);
      expect((await fs.readFile(outside)).equals(master)).toBe(true);
      expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")("symlinked keys directory is rejected", async () => {
    const real = path.join(dataDir, "realkeys");
    await fs.mkdir(real, { mode: 0o700 });
    await fs.writeFile(path.join(real, "master"), master, { mode: 0o600 });
    await fs.symlink(real, path.dirname(file));
    const { loadMasterKey } = await security();
    await expect(loadMasterKey({ create: true })).rejects.toThrow(/symlink/);
    expect((await fs.readFile(path.join(real, "master"))).equals(master)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "loose file or dir permissions fail closed without silent chmod",
    async () => {
      const { loadMasterKey } = await security();
      await fs.mkdir(path.dirname(file), { mode: 0o700 });
      await fs.writeFile(file, master, { mode: 0o600 });
      await fs.chmod(file, 0o644);
      await expect(loadMasterKey({ create: true })).rejects.toThrow(/group\/other/);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o644);
      await fs.chmod(file, 0o600);
      await fs.chmod(path.dirname(file), 0o755);
      await expect(loadMasterKey({ create: true })).rejects.toThrow(/group\/other/);
      expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o755);
      expect((await fs.readFile(file)).equals(master)).toBe(true);
    },
  );

  it("oversized root is rejected from stat without loading it", async () => {
    await fs.mkdir(path.dirname(file), { mode: 0o700 });
    const big = Buffer.alloc(1024 * 1024, 3);
    await fs.writeFile(file, big, { mode: 0o600 });
    const { loadMasterKey } = await security();
    await expect(loadMasterKey({ create: true })).rejects.toThrow(/expected 32 bytes/);
    expect((await fs.stat(file)).size).toBe(big.length);
  });

  it.each([0, 31, 33])("existing corrupt %i-byte root is not replaced", async (length) => {
    await fs.mkdir(path.dirname(file), { mode: 0o700 });
    const corrupt = Buffer.alloc(length, 9);
    await fs.writeFile(file, corrupt, { mode: 0o600 });
    const { loadMasterKey } = await security();
    await expect(loadMasterKey({ create: true })).rejects.toThrow();
    expect((await fs.readFile(file)).equals(corrupt)).toBe(true);
    expect(await fs.readdir(path.dirname(file))).toEqual(["master"]);
  });

  it("mismatched expectedKid leaves existing root untouched", async () => {
    const { loadMasterKey } = await security();
    const first = await loadMasterKey({ create: true });
    const wrongKid = first.kid === kid ? "0000000000000000" : kid;
    for (const create of [false, true]) {
      await expect(loadMasterKey({ create, expectedKid: wrongKid })).rejects.toThrow();
      expect((await fs.readFile(file)).equals(first.key)).toBe(true);
    }
    expect((await loadMasterKey({ expectedKid: first.kid })).key.equals(first.key)).toBe(true);
  });

  it("lost root with expectedKid cannot regenerate, including fresh loader", async () => {
    const { loadMasterKey } = await security();
    const first = await loadMasterKey({ create: true });
    await fs.rm(file);
    vi.resetModules();
    const restarted = await security();
    for (const create of [false, true]) {
      await expect(restarted.loadMasterKey({ create, expectedKid: first.kid })).rejects.toThrow();
      expect(await exists(file)).toBe(false);
    }
  });

  it("env expectedKid mismatch fails without a fallback file", async () => {
    vi.stubEnv("TOKENHOP_MASTER_KEY", master.toString("base64"));
    const { loadMasterKey } = await security();
    await expect(
      loadMasterKey({ create: true, expectedKid: "0000000000000000" }),
    ).rejects.toThrow();
    expect(await exists(file)).toBe(false);
    expect((await loadMasterKey({ expectedKid: kid })).key.equals(master)).toBe(true);
  });
});
