// MITM root CA trust-store commands (YAN-328): install and uninstall must cover
// both the tokenhop and the legacy names. Only the pure builders are
// exercised; no trust-store command runs.
import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import path from "path";

const require = createRequire(import.meta.url);
const forge = require("node-forge");
const { ACTIVE, BRAND, LEGACY } = require("../../src/shared/brand/index.cjs");
const install = require("../../src/mitm/cert/install.js");

// Pinned literals, so a swapped brand-module mapping fails here.
const LEGACY_CN = "9Router MITM Root CA"; // legacy(9router): pinned
const LEGACY_ORG = "9Router"; // legacy(9router): pinned
const LEGACY_ANCHOR = "9router-root-ca.crt"; // legacy(9router): pinned
const NAMES = [BRAND.mitmCaCommonName, LEGACY.mitmCaCommonName];
const LINUX = { dir: "/usr/local/share/ca-certificates", cmd: "update-ca-certificates" };

function writeCert(commonName, org) {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  const attrs = [{ name: "commonName", value: commonName }];
  if (org)
    attrs.push({ name: "organizationName", value: org }, { name: "countryName", value: "US" });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey);
  const file = path.join(
    fs.mkdtempSync(path.join(process.env.TOKENHOP_TEST_ROOT, "mitm-cert-")),
    "rootCA.crt",
  );
  fs.writeFileSync(file, forge.pki.certificateToPem(cert));
  return file;
}

describe("MITM cert install commands", () => {
  it("reads the CN of a legacy CA on disk", () => {
    expect(install.getCertCommonName(writeCert(LEGACY_CN, LEGACY_ORG))).toBe(LEGACY_CN);
  });

  it("never passes an unknown CN on to a shell", () => {
    expect(install.getCertCommonName(writeCert('evil"; rm -rf /'))).toBe(ACTIVE.mitmCaCommonName);
  });

  it("names the Linux anchor after the cert's CN", () => {
    expect(install.linuxAnchorFile(LEGACY.mitmCaCommonName)).toBe(LEGACY.mitmCertFile);
    expect(install.linuxAnchorFile(BRAND.mitmCaCommonName)).toBe(BRAND.mitmCertFile);
  });

  it("installs on Linux under the legacy filename and removes the other name first", () => {
    const cmd = install.linuxInstallCommand(LINUX, "/ca.crt", LEGACY.mitmCaCommonName);
    expect(cmd).toContain(`rm -f "${LINUX.dir}/${BRAND.mitmCertFile}"`);
    expect(cmd).toContain(`cp "/ca.crt" "${LINUX.dir}/${LEGACY.mitmCertFile}"`);
    expect(cmd.indexOf("rm -f")).toBeLessThan(cmd.indexOf("cp "));
  });

  it("installs on Linux under the tokenhop filename and removes the legacy name first", () => {
    const cmd = install.linuxInstallCommand(LINUX, "/ca.crt", BRAND.mitmCaCommonName);
    expect(cmd).toContain(`rm -f "${LINUX.dir}/${LEGACY.mitmCertFile}"`);
    expect(cmd).toContain(`cp "/ca.crt" "${LINUX.dir}/${BRAND.mitmCertFile}"`);
  });

  it("uninstalls both Linux anchor filenames from every anchor dir", () => {
    const cmd = install.linuxUninstallCommand(LINUX);
    for (const dir of [LINUX.dir, "/etc/pki/ca-trust/source/anchors"]) {
      for (const f of ["tokenhop-root-ca.crt", LEGACY_ANCHOR]) {
        expect(cmd).toContain(`rm -f "${dir}/${f}"`);
      }
    }
  });

  it("cleans both macOS names even when the fingerprint delete fails", () => {
    const cmd = install.macUninstallCommand("ABCD");
    expect(cmd).toMatch(/^security delete-certificate -Z "ABCD" \S+; rc=\$\?;/);
    expect(cmd).toMatch(/exit \$rc$/);
  });

  it("removes both names from every store on install and uninstall", () => {
    const scripts = [
      install.macInstallCommand("/ca.crt"),
      install.macUninstallCommand("ABCD"),
      install.windowsInstallScript("C:\\ca.crt"),
      install.windowsUninstallScript("ABCD"),
      install.nssScript("delete", null, null),
      install.nssScript("add", "/ca.crt", LEGACY.mitmCaCommonName),
    ];
    for (const script of scripts) {
      for (const name of NAMES) expect(script).toContain(name);
    }
    expect(install.macUninstallCommand("ABCD")).toContain('delete-certificate -Z "ABCD"');
  });

  it("trusts the cert in NSS under its own CN", () => {
    const script = install.nssScript("add", "/ca.crt", LEGACY.mitmCaCommonName);
    expect(script).toContain(`-A -t "C,," -n "${LEGACY.mitmCaCommonName}" -i "/ca.crt"`);
    expect(script).not.toContain(`-A -t "C,," -n "${BRAND.mitmCaCommonName}"`);
  });
});
