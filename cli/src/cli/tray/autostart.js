const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const { requireShared } = require("../utils/requireShared");

const { ACTIVE, ACTIVE_BRAND_ID, BRAND, LEGACY } = requireShared("brand");

// Entries of both names count as ours: the active brand's first, then the other
// one, which enable and disable remove. Only tokenhop builds migrate a legacy
// entry when they find one. legacy(9router): remove in v2
const ENTRY_NAMES = [ACTIVE, ACTIVE_BRAND_ID === "tokenhop" ? LEGACY : BRAND].map((names) => ({
  label: names.autostartLabel,
  desktop: names.autostartDesktopFile,
  vbs: names.autostartVbsFile,
}));
const [CURRENT, ...OTHER_ENTRIES] = ENTRY_NAMES;
const MIGRATE_ENTRIES = ACTIVE_BRAND_ID === "tokenhop" ? OTHER_ENTRIES : [];

function launchArgs({ port, host } = {}) {
  // Launcher pre-validates these; repeat checks so autostart entries stay safe.
  return [
    "--tray",
    ...(Number.isInteger(port) && port >= 1 && port <= 65535 ? ["-p", String(port)] : []),
    ...(typeof host === "string" && /^[A-Za-z0-9.:%_-]+$/.test(host) ? ["-H", host] : []),
  ];
}

// `-p`/`-H` of an existing entry, so a migrated entry keeps the same settings.
// launchArgs() revalidates whatever this returns.
function launchOptionsFromEntry(content) {
  const port = content.match(/(?:^|[\s>])-p(?:<\/string>\s*<string>|\s+)(\d+)/);
  const host = content.match(/(?:^|[\s>])-H(?:<\/string>\s*<string>|\s+)([A-Za-z0-9.:%_-]+)/);
  return {
    ...(port ? { port: Number(port[1]) } : {}),
    // .desktop Exec doubles `%`; undo it so desktopExecArg doesn't double it again.
    ...(host
      ? { host: content.startsWith("[Desktop Entry]") ? host[1].replace(/%%/g, "%") : host[1] }
      : {}),
  };
}

function xmlEscape(value) {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char],
  );
}

// Desktop Entry spec: quote args with reserved chars, backslash-escape `"`, `` ` ``,
// `$`, `\` inside quotes, and double `%` (field-code prefix; IPv6 zone ids use it).
// The string-level `\` escape is applied on top, so a literal `\` becomes `\\\\`.
function desktopExecArg(value) {
  const escaped = value.replace(/%/g, "%%");
  if (!/[\s"'\\><~|&;$*?#()`]/.test(escaped)) return escaped;
  return `"${escaped.replace(/["`$\\]/g, "\\$&")}"`.replace(/\\/g, "\\\\");
}

/**
 * Resolve the absolute path to this package's cli.js.
 *
 * Order of preference:
 *   1. Explicit `cliPath` argument — cleanest, used when called from running
 *      cli.js with `__filename`.
 *   2. `process.argv[1]` if it's our cli.js — true when the launcher is
 *      currently running and the tray menu fires this code path.
 *   3. Compute relative to this file's own location. autostart.js lives at
 *      `<pkg>/src/cli/tray/autostart.js`, so cli.js is three levels up.
 *      This works for any global install layout (nvm, Volta, asdf, Homebrew,
 *      /usr/local, etc.) without depending on `npm bin -g` (removed in npm 9)
 *      or a hardcoded `/usr/local/...` path.
 *
 * Returns null if no candidate exists — callers should not write an autostart
 * entry pointing at a non-existent script.
 */
function getCliJsPath(cliPath) {
  if (cliPath) {
    const resolved = path.resolve(cliPath);
    if (fs.existsSync(resolved)) return resolved;
  }
  if (process.argv[1]) {
    const resolved = path.resolve(process.argv[1]);
    if (path.basename(resolved) === "cli.js" && fs.existsSync(resolved)) {
      return resolved;
    }
  }
  const computed = path.resolve(__dirname, "..", "..", "..", "cli.js");
  if (fs.existsSync(computed)) return computed;
  return null;
}

function removeFile(file) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/**
 * Enable auto startup on OS boot
 * @param {string} cliPath - Optional path to cli.js (defaults to auto-detect)
 * @param {Object} [opts] - Optional launcher options { port, host }
 * @returns {boolean} success
 */
function enableAutoStart(cliPath, { port, host } = {}) {
  const platform = process.platform;

  if (!["darwin", "win32", "linux"].includes(platform)) return false;
  if (platform === "linux" && !process.env.DISPLAY) return false;

  try {
    if (platform === "darwin") return enableMacOS(cliPath, { port, host });
    if (platform === "win32") return enableWindows(cliPath, { port, host });
    if (platform === "linux") return enableLinux(cliPath, { port, host });
  } catch (err) {
    // Silent fail — autostart is optional
  }
  return false;
}

/**
 * Disable auto startup. Removes the entries of both names.
 * @returns {boolean} success
 */
function disableAutoStart() {
  const platform = process.platform;
  try {
    if (platform === "darwin") return ENTRY_NAMES.every(({ label }) => disableMacOS(label));
    if (platform === "win32") return ENTRY_NAMES.every(({ vbs }) => disableWindows(vbs));
    if (platform === "linux") return ENTRY_NAMES.every(({ desktop }) => disableLinux(desktop));
  } catch (err) {}
  return false;
}

/**
 * Check if autostart is enabled: an entry of either name exists. A legacy entry
 * is migrated to the current name on the way (tokenhop builds only).
 *
 * On macOS, both the plist file and the launchd registration must be present —
 * otherwise the tray menu would lie about the state (showing "✓ Enabled" even
 * when launchd has the agent in a failed state or hasn't loaded it).
 */
function isAutoStartEnabled() {
  const platform = process.platform;

  try {
    if (platform === "darwin") {
      // A migrated agent keeps running under its old label until logout.
      for (const { label } of MIGRATE_ENTRIES) {
        migrateEntry(plistPathFor(label), plistPathFor(CURRENT.label), writePlist);
      }
      return (
        ENTRY_NAMES.some(({ label }) => fs.existsSync(plistPathFor(label))) &&
        ENTRY_NAMES.some(({ label }) => isLoadedMacOS(label))
      );
    }
    if (platform === "win32") {
      for (const { vbs } of MIGRATE_ENTRIES) {
        migrateEntry(vbsPathFor(vbs), vbsPathFor(CURRENT.vbs), enableWindows);
      }
      return ENTRY_NAMES.some(({ vbs }) => fs.existsSync(vbsPathFor(vbs)));
    }
    if (platform === "linux") {
      for (const { desktop } of MIGRATE_ENTRIES) {
        migrateEntry(desktopPathFor(desktop), desktopPathFor(CURRENT.desktop), enableLinux);
      }
      return ENTRY_NAMES.some(({ desktop }) => fs.existsSync(desktopPathFor(desktop)));
    }
  } catch (e) {}
  return false;
}

// legacy(9router): remove in v2
// Write the current entry with the legacy entry's port/host (unless one already
// exists), pointing at this install's cli.js, then drop the legacy file. A
// failed write keeps the legacy entry.
function migrateEntry(legacyPath, currentPath, write) {
  if (!fs.existsSync(legacyPath)) return;
  if (!fs.existsSync(currentPath)) {
    const options = launchOptionsFromEntry(fs.readFileSync(legacyPath, "utf8"));
    if (!write(undefined, options)) return;
  }
  removeFile(legacyPath);
}

// ============ macOS ============

function plistPathFor(label) {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function isLoadedMacOS(label) {
  try {
    execSync(`launchctl list ${label}`, { stdio: ["ignore", "ignore", "ignore"], timeout: 3000 });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Returns true when the current Node process IS the running instance that
 * launchd is managing under the given agent label.
 *
 * `launchctl unload <plist>` (and `load`) for an Aqua user-domain agent sends
 * SIGTERM to the running process. When the running cli.js was itself
 * spawned by the autostart launchd agent (i.e. user enabled autostart at
 * some point, then rebooted, then clicked the tray icon's "Disable
 * Auto-start" menu item), an unload would kill the very process executing
 * the click handler — and the tray icon would disappear instead of the menu
 * label flipping back to "Enable Auto-start". This helper lets the enable
 * and disable paths sidestep that by skipping launchctl when we'd otherwise
 * be killing ourselves.
 */
function isAgentSelfMacOS(label) {
  try {
    const output = execSync(`launchctl list ${label}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const match = output.match(/"PID"\s*=\s*(\d+)/);
    return !!(match && parseInt(match[1], 10) === process.pid);
  } catch (e) {
    return false;
  }
}

// Returns the plist path, or null when cli.js can't be found. No launchctl, so a
// migration doesn't start a second launcher (RunAtLoad) or unload this one.
function writePlist(cliPath, { port, host } = {}) {
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = plistPathFor(CURRENT.label);

  const nodePath = process.execPath;
  const routerScript = getCliJsPath(cliPath);
  // Don't write a broken plist that references a non-existent script.
  if (!routerScript) return null;

  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }

  // Invoke node + cli.js directly with absolute paths — no shell wrapper.
  // The previous design ran `zsh -l -c "..."` so a login shell would source
  // nvm/.zshrc and set PATH; that's fragile (nvm.sh sourcing varies by user,
  // some setups don't put node on PATH from a non-interactive login shell).
  // EnvironmentVariables.PATH explicitly includes node's bin dir so child
  // processes spawned by cli.js (npm install at runtime, etc.) resolve.
  const launchPath = `${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`;

  const args = [nodePath, routerScript, ...launchArgs({ port, host })];
  const plistArgs = args.map((arg) => `        <string>${xmlEscape(arg)}</string>`).join("\n");

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${CURRENT.label}</string>
    <key>ProgramArguments</key>
    <array>
${plistArgs}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${launchPath}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/${ACTIVE.slug}.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/${ACTIVE.slug}.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plistContent);
  return plistPath;
}

function enableMacOS(cliPath, { port, host } = {}) {
  const plistPath = writePlist(cliPath, { port, host });
  if (!plistPath) return false;

  // The current plist replaces an agent of the other name. legacy(9router): remove in v2
  for (const { label } of OTHER_ENTRIES) disableMacOS(label);

  // If we're the running agent already (under either label), launchctl
  // unload/load would send ourselves SIGTERM. Skip it — the plist file is
  // updated on disk and launchd will pick it up at next login.
  // isAutoStartEnabled() will still return true because launchctl already has
  // the agent loaded.
  if (ENTRY_NAMES.some(({ label }) => isAgentSelfMacOS(label))) {
    return true;
  }

  // Register with launchd in the current session. Without this, the agent
  // only takes effect on the next user login and the user has no signal that
  // anything actually happened. `unload` first defends against re-enable
  // replacing an existing plist.
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
  } catch (e) {}
  try {
    execSync(`launchctl load -w "${plistPath}"`, { stdio: "ignore" });
  } catch (e) {
    // Even if load fails, the plist is on disk and will be picked up at next
    // login; report success based on the file write.
  }
  return true;
}

function disableMacOS(label) {
  const plistPath = plistPathFor(label);

  // Don't kill ourselves: when the current process is the running agent,
  // `launchctl unload` would send SIGTERM and the user clicking
  // "Disable Auto-start" from the tray menu would lose their tray icon
  // instead of just flipping the menu label. Skip the unload — removing the
  // plist file is enough to prevent the agent from starting on next login.
  // A migrated legacy agent is still loaded but its plist is gone, so unload by label.
  if (!isAgentSelfMacOS(label)) {
    try {
      if (fs.existsSync(plistPath))
        execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
      else if (isLoadedMacOS(label)) execSync(`launchctl remove ${label}`, { stdio: "ignore" });
    } catch (e) {}
  }

  removeFile(plistPath);
  return true;
}

// ============ Windows ============

function startupDirWindows() {
  return path.join(
    process.env.APPDATA || "",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
}

function vbsPathFor(file) {
  return path.join(startupDirWindows(), file);
}

function enableWindows(cliPath, { port, host } = {}) {
  if (!fs.existsSync(startupDirWindows())) return false;

  const nodePath = process.execPath;
  const routerScript = getCliJsPath(cliPath);
  if (!routerScript) return false;

  // Run node + cli.js directly, hidden window. Avoids the fragile
  // `<package>.cmd` lookup that depended on the npm prefix path.
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${nodePath}"" ""${routerScript}"" ${launchArgs({ port, host }).join(" ")}", 0, False
`;
  fs.writeFileSync(vbsPathFor(CURRENT.vbs), vbsContent);
  // legacy(9router): remove in v2
  for (const { vbs } of OTHER_ENTRIES) disableWindows(vbs);
  return true;
}

function disableWindows(file) {
  removeFile(vbsPathFor(file));
  return true;
}

// ============ Linux ============

function desktopPathFor(file) {
  return path.join(os.homedir(), ".config", "autostart", file);
}

function enableLinux(cliPath, { port, host } = {}) {
  const autostartDir = path.dirname(desktopPathFor(CURRENT.desktop));

  const nodePath = process.execPath;
  const routerScript = getCliJsPath(cliPath);
  if (!routerScript) return false;

  if (!fs.existsSync(autostartDir)) {
    try {
      fs.mkdirSync(autostartDir, { recursive: true });
    } catch (e) {
      return false;
    }
  }

  const desktopContent = `[Desktop Entry]
Type=Application
Name=${ACTIVE.name}
Comment=${ACTIVE.name} API Proxy
Exec=${[nodePath, routerScript, ...launchArgs({ port, host })].map(desktopExecArg).join(" ")}
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`;
  fs.writeFileSync(desktopPathFor(CURRENT.desktop), desktopContent);
  // legacy(9router): remove in v2
  for (const { desktop } of OTHER_ENTRIES) disableLinux(desktop);
  return true;
}

function disableLinux(file) {
  removeFile(desktopPathFor(file));
  return true;
}

module.exports = {
  enableAutoStart,
  disableAutoStart,
  isAutoStartEnabled,
};
