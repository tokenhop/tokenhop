const fs = require("fs");
const crypto = require("crypto");
const { exec } = require("child_process");
const { execWithPassword, isSudoAvailable } = require("../dns/dnsConfig.js");
const { runElevatedPowerShell, quotePs } = require("../winElevated.js");
const { log, err } = require("../logger");
const { ACTIVE, BRAND, LEGACY } = require("../../shared/brand/index.cjs");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const LINUX_CERT_PATHS = [
  // Debian / Ubuntu
  { dir: "/usr/local/share/ca-certificates", cmd: "update-ca-certificates" },
  // Arch Linux / CachyOS / Manjaro
  { dir: "/etc/ca-certificates/trust-source/anchors", cmd: "update-ca-trust" },
  // Fedora / RHEL / CentOS
  { dir: "/etc/pki/ca-trust/source/anchors", cmd: "update-ca-trust" },
  // openSUSE
  { dir: "/etc/pki/trust/anchors", cmd: "update-ca-certificates" },
];

function getLinuxCertConfig() {
  for (const config of LINUX_CERT_PATHS) {
    if (fs.existsSync(config.dir)) {
      return config;
    }
  }
  // Fallback to Debian default if none exist
  return LINUX_CERT_PATHS[0];
}
const MAC_KEYCHAIN = "/Library/Keychains/System.keychain";
// Every name a MITM root CA may carry; the index pairs a CN with its Linux anchor file.
// legacy(9router): remove in v2
const CA_NAMES = [BRAND.mitmCaCommonName, LEGACY.mitmCaCommonName];
const ANCHOR_FILES = [BRAND.mitmCertFile, LEGACY.mitmCertFile];

// Get SHA1 fingerprint from cert file using Node.js crypto
function getCertFingerprint(certPath) {
  const pem = fs.readFileSync(certPath, "utf-8");
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), "base64");
  return crypto.createHash("sha1").update(der).digest("hex").toUpperCase().match(/.{2}/g).join(":");
}

/** The CN the CA on disk was issued with; an existing CA keeps its name. */
function getCertCommonName(certPath) {
  const { subject } = new crypto.X509Certificate(fs.readFileSync(certPath));
  const cn = subject.match(/^CN=(.*)$/m)?.[1];
  if (!cn) throw new Error(`Certificate has no common name: ${certPath}`);
  return cn;
}

/** Linux anchor filename for a CA with this CN; an unknown CN gets the active brand's. */
function linuxAnchorFile(commonName) {
  const i = CA_NAMES.indexOf(commonName);
  return i === -1 ? ACTIVE.mitmCertFile : ANCHOR_FILES[i];
}

// ── Command builders (pure, so tests can check them without touching a trust store) ──

function macFindCommand(commonName) {
  return `security find-certificate -a -c "${commonName}" -Z ${MAC_KEYCHAIN} 2>/dev/null`;
}

const macDeleteByNames = () =>
  CA_NAMES.map(
    (cn) => `(security delete-certificate -c "${cn}" ${MAC_KEYCHAIN} 2>/dev/null || true)`,
  );

function macInstallCommand(certPath) {
  // Remove old certs of either name first to avoid duplicate/stale cert conflict
  const install = `security add-trusted-cert -d -r trustRoot -k ${MAC_KEYCHAIN} "${certPath}"`;
  return [...macDeleteByNames(), install].join(" && ");
}

function macUninstallCommand(fingerprint) {
  const byFingerprint = `security delete-certificate -Z "${fingerprint}" ${MAC_KEYCHAIN}`;
  return [byFingerprint, ...macDeleteByNames()].join(" && ");
}

const windowsDeleteByNames = () =>
  CA_NAMES.map((cn) => `certutil -delstore Root ${quotePs(cn)} 2>$null | Out-Null`).join("\n    ");

function windowsInstallScript(certPath) {
  // Delete any stale cert of either name before adding to avoid duplicates.
  return `
    ${windowsDeleteByNames()}
    $exit = & certutil -addstore Root ${quotePs(certPath)} 2>&1
    if ($LASTEXITCODE -ne 0) { throw "certutil exit $LASTEXITCODE" }
  `;
}

function windowsUninstallScript(fingerprint) {
  // A name that isn't in the store fails harmlessly; success is the fingerprint being gone.
  return `
    ${windowsDeleteByNames()}
    certutil -store Root ${quotePs(fingerprint)} 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { throw "certificate still in Root store" }
    exit 0
  `;
}

function linuxInstallCommand(config, certPath, commonName) {
  const destFile = `${config.dir}/${linuxAnchorFile(commonName)}`;
  const others = ANCHOR_FILES.map((f) => `${config.dir}/${f}`).filter((f) => f !== destFile);
  const removeOthers = others.map((f) => `rm -f "${f}"`).join(" && ");
  return `${removeOthers} && cp "${certPath}" "${destFile}" && (${config.cmd} 2>/dev/null || true)`;
}

function linuxUninstallCommand(config) {
  const remove = ANCHOR_FILES.map((f) => `rm -f "${config.dir}/${f}"`).join(" && ");
  return `${remove} && (${config.cmd} 2>/dev/null || true)`;
}

/** Both actions remove every known nickname; `add` then trusts certPath under its own CN. */
function nssScript(action, certPath, commonName) {
  const steps = CA_NAMES.map(
    (cn) => `certutil -d sql:"$db" -D -n "${cn}" 2>/dev/null || \\
          certutil -d "$db" -D -n "${cn}" 2>/dev/null || true`,
  );
  if (action === "add") {
    steps.push(`certutil -d sql:"$db" -A -t "C,," -n "${commonName}" -i "${certPath}" 2>/dev/null || \\
          certutil -d "$db" -A -t "C,," -n "${commonName}" -i "${certPath}" 2>/dev/null || true`);
  }
  const perDb = steps.join("\n        ");

  return `
    if ! command -v certutil &> /dev/null; then
      exit 0
    fi
    
    DIRS="$HOME/.pki/nssdb $HOME/snap/chromium/current/.pki/nssdb"
    
    if [ -d "$HOME/.mozilla/firefox" ]; then
      for profile in "$HOME"/.mozilla/firefox/*/; do
        if [ -f "\${profile}cert9.db" ] || [ -f "\${profile}cert8.db" ]; then
          DIRS="$DIRS $profile"
        fi
      done
    fi

    if [ -d "$HOME/snap/firefox/common/.mozilla/firefox" ]; then
      for profile in "$HOME"/snap/firefox/common/.mozilla/firefox/*/; do
        if [ -f "\${profile}cert9.db" ] || [ -f "\${profile}cert8.db" ]; then
          DIRS="$DIRS $profile"
        fi
      done
    fi

    for db in $DIRS; do
      if [ -d "$db" ]; then
        ${perDb}
      fi
    done
  `;
}

/**
 * Check if certificate is already installed in system store
 */
async function checkCertInstalled(certPath) {
  if (IS_WIN) return checkCertInstalledWindows(certPath);
  if (IS_MAC) return checkCertInstalledMac(certPath);
  return checkCertInstalledLinux(certPath);
}

function checkCertInstalledMac(certPath) {
  return new Promise((resolve) => {
    try {
      const fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
      // Verify exact cert bytes match — same CN with different fingerprint = stale cert
      exec(macFindCommand(getCertCommonName(certPath)), { windowsHide: true }, (error, stdout) => {
        if (error || !stdout) return resolve(false);
        const match = new RegExp(`SHA-1 hash:\\s*${fingerprint}`, "i").test(stdout);
        if (!match) return resolve(false);
        // Cert exists with matching fingerprint — confirm trust policy
        exec(
          `security verify-cert -c "${certPath}" -p ssl -k ${MAC_KEYCHAIN} 2>/dev/null`,
          { windowsHide: true },
          (err2) => {
            resolve(!err2);
          },
        );
      });
    } catch {
      resolve(false);
    }
  });
}

function checkCertInstalledWindows(certPath) {
  return new Promise((resolve) => {
    // Check by SHA1 fingerprint — detects stale cert with same CN but different key
    let fingerprint;
    try {
      fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
    } catch {
      return resolve(false);
    }
    exec(`certutil -store Root ${fingerprint}`, { windowsHide: true }, (error) => {
      resolve(!error);
    });
  });
}

/**
 * Installed when an anchor file of either name holds this exact cert. An anchor
 * we can't read counts by name alone.
 */
function checkCertInstalledLinux(certPath) {
  const config = getLinuxCertConfig();
  let fingerprint;
  try {
    fingerprint = getCertFingerprint(certPath);
  } catch {
    return Promise.resolve(false);
  }
  return Promise.resolve(
    ANCHOR_FILES.some((f) => {
      const anchor = `${config.dir}/${f}`;
      if (!fs.existsSync(anchor)) return false;
      try {
        return getCertFingerprint(anchor) === fingerprint;
      } catch {
        return true;
      }
    }),
  );
}

/**
 * Install SSL certificate to system trust store
 */
async function installCert(sudoPassword, certPath) {
  if (!fs.existsSync(certPath)) {
    throw new Error(`Certificate file not found: ${certPath}`);
  }

  const isInstalled = await checkCertInstalled(certPath);
  if (isInstalled) {
    log("🔐 Cert: already trusted ✅");
    return;
  }

  if (IS_WIN) {
    await installCertWindows(certPath);
  } else if (IS_MAC) {
    await installCertMac(sudoPassword, certPath);
  } else {
    await installCertLinux(sudoPassword, certPath);
  }
}

async function installCertMac(sudoPassword, certPath) {
  try {
    await execWithPassword(macInstallCommand(certPath), sudoPassword);
    log("🔐 Cert: ✅ installed to system keychain");
  } catch (error) {
    const msg = error.message?.includes("canceled")
      ? "User canceled authorization"
      : "Certificate install failed";
    throw new Error(msg);
  }
}

async function installCertWindows(certPath) {
  // Auto-elevate via UAC popup if not admin (zero popup if already admin).
  try {
    await runElevatedPowerShell(windowsInstallScript(certPath));
    log("🔐 Cert: ✅ installed to Windows Root store");
  } catch (e) {
    throw new Error(`Failed to install certificate: ${e.message}`);
  }
}

/**
 * Uninstall SSL certificate from system store
 */
async function uninstallCert(sudoPassword, certPath) {
  // Linux removes any anchor of either name, even one holding a stale cert.
  const isInstalled =
    IS_WIN || IS_MAC
      ? await checkCertInstalled(certPath)
      : ANCHOR_FILES.some((f) => fs.existsSync(`${getLinuxCertConfig().dir}/${f}`));
  if (!isInstalled) {
    log("🔐 Cert: not found in system store");
    return;
  }

  if (IS_WIN) {
    await uninstallCertWindows(certPath);
  } else if (IS_MAC) {
    await uninstallCertMac(sudoPassword, certPath);
  } else {
    await uninstallCertLinux(sudoPassword);
  }
}

async function uninstallCertMac(sudoPassword, certPath) {
  const fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
  try {
    await execWithPassword(macUninstallCommand(fingerprint), sudoPassword);
    log("🔐 Cert: ✅ uninstalled from system keychain");
  } catch (err) {
    throw new Error("Failed to uninstall certificate");
  }
}

async function uninstallCertWindows(certPath) {
  // Auto-elevate via UAC popup if not admin
  const fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
  try {
    await runElevatedPowerShell(windowsUninstallScript(fingerprint));
    log("🔐 Cert: ✅ uninstalled from Windows Root store");
  } catch (e) {
    throw new Error(`Failed to uninstall certificate: ${e.message}`);
  }
}

function updateNssDatabases(certPath, action = "add") {
  const commonName = action === "add" ? getCertCommonName(certPath) : null;
  const script = nssScript(action, certPath, commonName);
  return new Promise((resolve) => {
    exec(script, { shell: "/bin/bash" }, () => resolve());
  });
}

async function installCertLinux(sudoPassword, certPath) {
  if (!isSudoAvailable()) {
    log(
      `🔐 Cert: cannot install to system store without sudo — trust this file on clients: ${certPath}`,
    );
    // Still try to update user NSS DBs even if no sudo!
    await updateNssDatabases(certPath, "add");
    return;
  }

  const config = getLinuxCertConfig();
  const cmd = linuxInstallCommand(config, certPath, getCertCommonName(certPath));

  try {
    await execWithPassword(cmd, sudoPassword);
    await updateNssDatabases(certPath, "add");
    log(`🔐 Cert: ✅ installed to Linux trust store (${config.dir}) and user browser databases`);
  } catch (error) {
    throw new Error(`Certificate install failed: ${error.message}`);
  }
}

async function uninstallCertLinux(sudoPassword) {
  // Always try to uninstall from user DBs even without sudo
  await updateNssDatabases(null, "delete");

  if (!isSudoAvailable()) {
    return;
  }

  const config = getLinuxCertConfig();
  try {
    await execWithPassword(linuxUninstallCommand(config), sudoPassword);
    log("🔐 Cert: ✅ uninstalled from Linux trust store and user browser databases");
  } catch (error) {
    throw new Error("Failed to uninstall certificate");
  }
}

module.exports = {
  installCert,
  uninstallCert,
  checkCertInstalled,
  getCertCommonName,
  linuxAnchorFile,
  macInstallCommand,
  macUninstallCommand,
  windowsInstallScript,
  windowsUninstallScript,
  linuxInstallCommand,
  linuxUninstallCommand,
  nssScript,
};
