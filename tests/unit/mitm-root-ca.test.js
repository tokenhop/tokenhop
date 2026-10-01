import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "module";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const require = createRequire(import.meta.url);
const { BRAND, LEGACY } = require("../../src/shared/brand/index.cjs");
const MODULES = [
  "../../src/mitm/cert/rootCA.js",
  "../../src/mitm/paths.js",
  "../../src/shared/brand/index.cjs",
].map((m) => require.resolve(m));

const savedBrand = process.env.NEXT_PUBLIC_BRAND;
afterEach(() => {
  if (savedBrand === undefined) delete process.env.NEXT_PUBLIC_BRAND;
  else process.env.NEXT_PUBLIC_BRAND = savedBrand;
});

function loadRootCAWithDataDir(dataDir, brand = "") {
  for (const m of MODULES) delete require.cache[m];
  process.env.NEXT_PUBLIC_BRAND = brand;
  const oldDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  try {
    return require("../../src/mitm/cert/rootCA.js");
  } finally {
    if (oldDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldDataDir;
  }
}

const tempDataDir = () => fs.mkdtempSync(path.join(process.env.TOKENHOP_TEST_ROOT, "mitm-ca-"));
const readCert = (dataDir) =>
  new crypto.X509Certificate(fs.readFileSync(path.join(dataDir, "mitm", "rootCA.crt")));

describe("MITM Root CA generation", () => {
  it("creates Root CA files synchronously for direct server startup", () => {
    const dataDir = tempDataDir();
    const { generateRootCA } = loadRootCAWithDataDir(dataDir);

    generateRootCA();

    expect(fs.existsSync(path.join(dataDir, "mitm", "rootCA.key"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "mitm", "rootCA.crt"))).toBe(true);
  });

  it("names a fresh CA after the default brand", () => {
    const dataDir = tempDataDir();
    loadRootCAWithDataDir(dataDir).generateRootCA();

    const { subject } = readCert(dataDir);
    expect(subject).toContain(`CN=${LEGACY.mitmCaCommonName}`);
    expect(subject).toContain(`O=${LEGACY.mitmCaOrg}`);
  });

  it("names a fresh CA tokenhop under the tokenhop brand", () => {
    const dataDir = tempDataDir();
    loadRootCAWithDataDir(dataDir, "tokenhop").generateRootCA();

    const { subject } = readCert(dataDir);
    expect(subject).toContain(`CN=${BRAND.mitmCaCommonName}`);
    expect(subject).toContain(`O=${BRAND.mitmCaOrg}`);
  });

  it("keeps a legacy CA on disk unchanged under the tokenhop brand", () => {
    const dataDir = tempDataDir();
    loadRootCAWithDataDir(dataDir).generateRootCA();
    const before = readCert(dataDir);

    const tokenhop = loadRootCAWithDataDir(dataDir, "tokenhop");
    tokenhop.generateRootCA();
    const after = readCert(dataDir);
    const loaded = tokenhop.loadRootCA();

    expect(after.fingerprint256).toBe(before.fingerprint256);
    expect(after.subject).toContain(`CN=${LEGACY.mitmCaCommonName}`);
    expect(loaded.cert.subject.getField("CN").value).toBe(LEGACY.mitmCaCommonName);
  });
});
