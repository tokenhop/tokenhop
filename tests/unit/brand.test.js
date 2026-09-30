import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const CJS_PATH = require.resolve("../../src/shared/brand/index.cjs");

// The active brand and the warn-once memory are per load, so every case loads a fresh copy.
function load(brand) {
  if (brand === undefined) delete process.env.NEXT_PUBLIC_BRAND;
  else process.env.NEXT_PUBLIC_BRAND = brand;
  delete require.cache[CJS_PATH];
  return require(CJS_PATH);
}

// Handbook §2 naming table.
const EXPECTED_BRAND = {
  name: "tokenhop",
  slug: "tokenhop",
  envPrefix: "TOKENHOP_",
  headerPrefix: "x-tokenhop-",
  defaultApiKey: "sk_tokenhop",
  dataDirName: "tokenhop",
  samlIssuerDefault: "urn:tokenhop:sp",
  mitmCaCommonName: "tokenhop MITM Root CA",
  mitmCaOrg: "tokenhop",
  mitmCertFile: "tokenhop-root-ca.crt",
  pidFile: "tokenhop.pid",
  autostartLabel: "dev.tokenhop.autostart",
  autostartDesktopFile: "tokenhop.desktop",
  autostartVbsFile: "tokenhop.vbs",
  clientConfigKey: "tokenhop",
  customModelIdPrefix: "custom:tokenhop-",
  storageKeyPrefix: "tokenhop.",
  eventPrefix: "tokenhop:",
  backupFilePrefix: "tokenhop-backup-",
  npmPackage: "tokenhop",
  appPackage: "tokenhop-app",
  repoSlug: "tokenhop/tokenhop",
  repoUrl: "https://github.com/tokenhop/tokenhop",
  imageName: "ghcr.io/tokenhop/tokenhop",
  websiteUrl: "https://tokenhop.ai",
  docsUrl: "https://tokenhop.dev",
};

const EXPECTED_LEGACY = {
  names: ["9Router", "9router"],
  slug: "9router",
  envPrefixes: ["NINEROUTER_", "NINE_ROUTER_"],
  headerPrefix: "x-9router-",
  defaultApiKey: "sk_9router",
  dataDirName: "9router",
  samlIssuerDefault: "urn:9router:sp",
  mitmCaCommonName: "9Router MITM Root CA",
  mitmCaOrg: "9Router",
  mitmCertFile: "9router-root-ca.crt",
  pidFile: "9router.pid",
  autostartLabel: "com.9router.autostart",
  autostartDesktopFile: "9router.desktop",
  autostartVbsFile: "9router.vbs",
  clientConfigKeys: ["9router", "9Router"],
  customModelIdPrefix: "custom:9Router-",
  storageKeyPrefix: "9router.",
  eventPrefix: "9router:",
  backupFilePrefix: "9router-backup-",
  npmPackage: "9router",
  appPackage: "9router-app",
  repoSlug: "yandy-r/9router",
  repoUrl: "https://github.com/yandy-r/9router",
  imageName: "ghcr.io/yandy-r/9router",
};

const BRAND_INDEPENDENT = ["repoSlug", "repoUrl", "imageName", "websiteUrl", "docsUrl"];

describe("brand constants", () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    delete require.cache[CJS_PATH];
    vi.restoreAllMocks();
  });

  it("BRAND and LEGACY match the handbook naming table", () => {
    const { BRAND, LEGACY } = load();
    expect(BRAND).toEqual(EXPECTED_BRAND);
    expect(LEGACY).toEqual(EXPECTED_LEGACY);
  });

  it("freezes BRAND, LEGACY, ACTIVE and the legacy arrays", () => {
    const { BRAND, LEGACY, ACTIVE } = load();
    for (const obj of [BRAND, LEGACY, ACTIVE, LEGACY.names, LEGACY.envPrefixes]) {
      expect(Object.isFrozen(obj)).toBe(true);
    }
  });

  it("LEGACY has no values that appear in BRAND", () => {
    const { BRAND, LEGACY } = load();
    const brandValues = new Set(Object.values(BRAND));
    const legacyValues = Object.values(LEGACY).flat();
    expect(legacyValues.filter((v) => brandValues.has(v))).toEqual([]);
  });

  it("ACTIVE is the primary legacy value per key under the default brand", () => {
    const { ACTIVE, BRAND } = load();
    expect(Object.keys(ACTIVE)).toEqual(Object.keys(BRAND));
    expect(ACTIVE.name).toBe("9Router");
    expect(ACTIVE.envPrefix).toBe("NINEROUTER_");
    expect(ACTIVE.clientConfigKey).toBe("9router");
    expect(ACTIVE.defaultApiKey).toBe("sk_9router");
    expect(ACTIVE.headerPrefix).toBe("x-9router-");
    expect(ACTIVE.dataDirName).toBe("9router");
  });

  it("ACTIVE keeps brand-independent keys on the current repo, image and sites", () => {
    const { ACTIVE, BRAND } = load();
    for (const key of BRAND_INDEPENDENT) expect(ACTIVE[key]).toBe(BRAND[key]);
  });

  it("ACTIVE equals BRAND under the tokenhop brand", () => {
    const { ACTIVE, BRAND } = load("tokenhop");
    expect(ACTIVE).toEqual(BRAND);
  });

  it("envName builds TOKENHOP_ names and rejects bad suffixes", () => {
    const { envName } = load();
    expect(envName("PEER_TOKEN")).toBe("TOKENHOP_PEER_TOKEN");
    for (const bad of ["", "peer", "A-B", " X", undefined]) {
      expect(() => envName(bad)).toThrow(/envName/);
    }
  });

  describe("readEnv", () => {
    it("prefers the new name even when it is an empty string", () => {
      process.env.TOKENHOP_T_SUFFIX = "";
      process.env.NINEROUTER_T_SUFFIX = "legacy";
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(load("tokenhop").readEnv("T_SUFFIX")).toBe("");
      expect(warn).not.toHaveBeenCalled();
    });

    it("falls back to the first defined legacy prefix, in order", () => {
      process.env.NINE_ROUTER_T_ORDER = "second";
      const brand = load();
      expect(brand.readEnv("T_ORDER")).toBe("second");
      process.env.NINEROUTER_T_ORDER = "first";
      expect(brand.readEnv("T_ORDER")).toBe("first");
    });

    it("returns undefined when no spelling is defined", () => {
      expect(load().readEnv("T_MISSING")).toBeUndefined();
    });

    it("reads from an injected env object", () => {
      expect(load().readEnv("X", { NINE_ROUTER_X: "1" })).toBe("1");
    });

    it("warns once per legacy variable under the tokenhop brand", () => {
      process.env.NINEROUTER_T_A = "a";
      process.env.NINE_ROUTER_T_B = "b";
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { readEnv } = load("tokenhop");
      readEnv("T_A");
      readEnv("T_A");
      readEnv("T_B");
      expect(warn.mock.calls).toEqual([
        [
          '[tokenhop] deprecated env var "NINEROUTER_T_A" → use "TOKENHOP_T_A" (legacy support ends in v2.0.0)',
        ],
        [
          '[tokenhop] deprecated env var "NINE_ROUTER_T_B" → use "TOKENHOP_T_B" (legacy support ends in v2.0.0)',
        ],
      ]);
    });

    it("stays silent under the default brand", () => {
      process.env.NINEROUTER_T_A = "a";
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(load().readEnv("T_A")).toBe("a");
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("warnLegacyOnce dedupes per (kind, oldName)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { warnLegacyOnce } = load("tokenhop");
    expect(warnLegacyOnce("header", "x-9router-a", "x-tokenhop-a")).toBe(true);
    expect(warnLegacyOnce("header", "x-9router-a", "x-tokenhop-a")).toBe(false);
    expect(warnLegacyOnce("path", "x-9router-a", "x-tokenhop-a")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("header and legacyHeaderNames follow the active brand", () => {
    const def = load();
    expect(def.header("connection-id")).toBe("x-9router-connection-id");
    expect(def.legacyHeaderNames("connection-id")).toEqual([]);

    const th = load("tokenhop");
    expect(th.header("connection-id")).toBe("x-tokenhop-connection-id");
    expect(th.legacyHeaderNames("connection-id")).toEqual(["x-9router-connection-id"]);
  });

  it("header rejects names that are not lowercase dash-separated", () => {
    const { header, legacyHeaderNames } = load();
    for (const bad of ["", "Connection-Id", "x-token-saver", "a_b", "-a", "a-", undefined]) {
      expect(() => header(bad)).toThrow(/header/);
      expect(() => legacyHeaderNames(bad)).toThrow(/header/);
    }
  });

  it("loads through import with the same values as require", async () => {
    const cjs = load("tokenhop");
    vi.resetModules();
    const esm = await import("../../src/shared/brand/index.js");
    expect(esm.BRAND).toEqual(cjs.BRAND);
    expect(esm.LEGACY).toEqual(cjs.LEGACY);
    expect(esm.ACTIVE).toEqual(cjs.BRAND);
    expect(esm.header("a")).toBe("x-tokenhop-a");
    for (const fn of ["envName", "readEnv", "warnLegacyOnce", "legacyHeaderNames"]) {
      expect(typeof esm[fn]).toBe("function");
    }
  });
});
