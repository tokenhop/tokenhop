import { beforeEach, describe, expect, it, vi } from "vitest";

const SENTINEL = "typed-secret-sentinel";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ body, status: init?.status ?? 200 }),
  },
}));

vi.mock("@/mitm/manager", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    assertMitmStartupSourceCompatible: vi.fn(),
    getMitmStatus: vi.fn(),
    getMitmCredentialStatus: vi.fn(),
    startServer: vi.fn(),
    stopServer: vi.fn(),
    enableToolDNS: vi.fn(),
    disableToolDNS: vi.fn(),
    trustCert: vi.fn(),
    getCachedPassword: () => null,
    setCachedPassword: vi.fn(),
    loadEncryptedPassword: async () => null,
    isSudoPasswordRequired: () => false,
    initDbHooks: vi.fn(),
    isValidManualCredential: actual.isValidManualCredential,
  };
});

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@/lib/auth/mitmCredential", () => ({
  readStorageState: vi.fn(),
  isLocalRouterBaseUrl: (url) => String(url).includes("localhost"),
  resolveRemoteSource: () => ({ type: "env", name: "TOKENHOP_MITM_REMOTE_API_KEY" }),
}));

const { assertMitmStartupSourceCompatible, getMitmStatus, getMitmCredentialStatus, startServer } =
  await import("@/mitm/manager");
const { getSettings, updateSettings } = await import("@/lib/localDb");
const { readStorageState } = await import("@/lib/auth/mitmCredential");
const { GET, POST } = await import("@/app/api/cli-tools/antigravity-mitm/route.js");
const legacyMod = await import("@/mitm/legacyPasswordCrypto.cjs");
const legacy = legacyMod.default ?? legacyMod;

const post = (body) => POST({ json: async () => (typeof body === "function" ? body() : body) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertMitmStartupSourceCompatible).mockResolvedValue(undefined);
  vi.mocked(getMitmStatus).mockResolvedValue({ running: false, pid: null });
  vi.mocked(getMitmCredentialStatus).mockResolvedValue({
    storage: "hashed",
    credentialSource: "internal",
    credentialConfigured: true,
    needsCredential: false,
  });
  vi.mocked(getSettings).mockResolvedValue({ mitmRouterBaseUrl: "http://localhost:20128" });
  vi.mocked(updateSettings).mockResolvedValue({});
  vi.mocked(readStorageState).mockResolvedValue({ storage: "hashed" });
  vi.mocked(startServer).mockResolvedValue({ running: true, pid: 4242 });
});

describe("antigravity-mitm remote credential boundary", () => {
  it("rejects malformed bodies, control characters, and over-limit credentials", async () => {
    for (const bad of [null, 42, "x", [], () => Promise.reject(new Error("boom"))]) {
      const res = await post(bad);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
    }
    expect(startServer).not.toHaveBeenCalled();
    for (const key of ["bad\nkey", "bad\rkey", "bad\u2028key", "x".repeat(4097)]) {
      const res = await post({ apiKey: key, mitmRouterBaseUrl: "https://remote.example" });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain(key.slice(0, 6));
      expect(startServer).not.toHaveBeenCalled();
    }
  });

  it("accepts exactly 4096 UTF-8 bytes and rejects oversized multibyte input", async () => {
    const key = "x".repeat(4096);
    expect((await post({ apiKey: key, mitmRouterBaseUrl: "https://remote.example" })).status).toBe(
      200,
    );
    expect(startServer).toHaveBeenCalledWith(key, "", false);
    vi.mocked(startServer).mockClear();
    expect(
      (await post({ apiKey: "é".repeat(2049), mitmRouterBaseUrl: "https://remote.example" }))
        .status,
    ).toBe(400);
    expect(startServer).not.toHaveBeenCalled();
  });

  it("rejects malformed destinations with generic errors", async () => {
    for (const url of [
      "https://user:secret@remote.example",
      "https://remote.example?secret=sentinel",
      "bad\nurl",
      42,
    ]) {
      const res = await post({ apiKey: SENTINEL, mitmRouterBaseUrl: url });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid MITM router URL");
      expect(startServer).not.toHaveBeenCalled();
    }
  });

  it("returns explicit 409 when a typed credential conflicts with the startup source", async () => {
    vi.mocked(assertMitmStartupSourceCompatible).mockImplementation(() => {
      const conflict = new Error("shadowed");
      conflict.code = "MITM_STARTUP_SOURCE_LOCKED";
      throw conflict;
    });
    const res = await post({ apiKey: SENTINEL, mitmRouterBaseUrl: "https://remote.example" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MITM_STARTUP_SOURCE_LOCKED");
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
    expect(res.body.success).toBeUndefined();
    expect(startServer).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("status exposes non-secret metadata only, never values or file paths", async () => {
    vi.mocked(getSettings).mockResolvedValue({ mitmRouterBaseUrl: "https://remote.example" });
    vi.mocked(getMitmCredentialStatus).mockResolvedValue({
      storage: "hashed",
      credentialSource: "file",
      credentialConfigured: true,
      needsCredential: false,
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.credentialSource).toBe("file");
    expect(res.body.storage).toBe("hashed");
    expect(res.body.needsCredential).toBe(false);
    expect("apiKey" in res.body).toBe(false);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(SENTINEL);
    for (const banned of [
      "TOKENHOP_MITM_REMOTE_API_KEY",
      "TOKENHOP_MASTER_KEY",
      "verifierHash",
      ".env",
      ".txt",
      "mitmInternalVerifier",
    ]) {
      expect(text).not.toContain(banned);
    }
  });
});

// YAN-365: MITM sudo password storage. Real manager + legacy helper; DB hooks
// are in-memory fakes so only the established/legacy mode switch is under test.
describe("MITM sudo password storage (YAN-365)", () => {
  const actualPromise = vi.importActual("@/mitm/manager");

  const hooks = (established, store = {}) => ({
    store,
    get: vi.fn(async () => ({ ...store })),
    update: vi.fn(async (u) => {
      Object.assign(store, u);
      return { ...store };
    }),
    established: vi.fn(async () => established),
  });

  it("established load returns the repo's runtime plaintext as-is (no second decrypt)", async () => {
    const m = await actualPromise;
    const h = hooks(true);
    m.initDbHooks(h.get, h.update, h.established);
    h.store.mitmSudoEncrypted = "plain-from-runtime-repo";
    expect(await m.loadEncryptedPassword()).toBe("plain-from-runtime-repo");
    expect(h.established).toHaveBeenCalled();
  });

  it("established load propagates repo integrity failures; absent stays null, never empty", async () => {
    const m = await actualPromise;
    const failing = hooks(true);
    failing.get.mockRejectedValueOnce(
      Object.assign(new Error("integrity"), { code: "DECRYPT_FAILED" }),
    );
    m.initDbHooks(failing.get, failing.update, failing.established);
    await expect(m.loadEncryptedPassword()).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
    const empty = hooks(true, {});
    m.initDbHooks(empty.get, empty.update, empty.established);
    expect(await m.loadEncryptedPassword()).toBeNull();
  });

  it("legacy (no hook) round-trips, and corrupt/non-string never becomes an empty password", async () => {
    const m = await actualPromise;
    const h = hooks(false);
    m.initDbHooks(h.get, h.update); // optional third hook omitted
    h.store.mitmSudoEncrypted = legacy.encryptPassword("legacy-pw");
    expect(await m.loadEncryptedPassword()).toBe("legacy-pw");
    for (const bad of ["", "a:b", "zz:zz:zz", `${"0".repeat(24)}:${"0".repeat(32)}:00`, 42, {}]) {
      h.store.mitmSudoEncrypted = bad;
      expect(await m.loadEncryptedPassword()).toBeNull();
    }
  });

  it("strict legacy helper: typed pure decrypt returns null on tamper and wrong machine id", () => {
    const stored = legacy.encryptLegacySudoPassword("sudo-pw", "machine-a");
    expect(legacy.decryptLegacySudoPassword(stored, "machine-a")).toBe("sudo-pw");
    expect(legacy.decryptLegacySudoPassword(stored, "machine-b")).toBeNull();
    const [iv, tag, ct] = stored.split(":");
    const flipped = `${iv}:${tag}:${(ct[0] === "0" ? "1" : "0") + ct.slice(1)}`;
    expect(legacy.decryptLegacySudoPassword(flipped, "machine-a")).toBeNull();
    expect(legacy.decryptLegacySudoPassword(null, "machine-a")).toBeNull();
  });

  it("explicit established hook is the only mode signal (a colon-shaped value stays legacy)", async () => {
    const m = await actualPromise;
    const h = hooks(false);
    m.initDbHooks(h.get, h.update, h.established);
    h.store.mitmSudoEncrypted = "a:b:c";
    expect(await m.loadEncryptedPassword()).toBeNull(); // legacy decrypt of junk, not plaintext
  });
});
