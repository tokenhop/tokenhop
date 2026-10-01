# YAN-329: rename the CLI package and binary to tokenhop

GitHub: tokenhop/tokenhop#199 · Linear: YAN-329 · Target: v1.0.0 (trunk `master`, no backport). Trunk landing: behind
the brand switch, plus a release-day PR for static package names.

## Already on master

`processControl.js` detects launchers of both names (`[\\/](tokenhop|9router)(?:[\\/]cli\.js)?`, no bare substring)
and reads both PID files (YAN-327). Tests in `cli-process-control.test.js`. No change.

## Design

- `cli/src/cli/utils/requireShared.js`: the packed-or-source loader that `dataMigrate.js`, `processControl.js`,
  `xaiVideo.js` and `hooks/sqliteRuntime.js` each copied. They import it; new call sites too.
- **Autostart** (`cli/src/cli/tray/autostart.js`). Entries: active brand first, then the other brand (deduped).
  - `isAutoStartEnabled`: true when any entry file exists (macOS: and any of our labels is registered with launchd).
    Under tokenhop, a found legacy entry is migrated: write the tokenhop entry with the legacy entry's `-p`/`-H`
    (parsed from the file; `launchArgs` revalidates), pointing at the current `cli.js`, then delete the legacy file.
    macOS migration does not run `launchctl`: `load` would start a second launcher now (RunAtLoad). The legacy job
    stays loaded for this session, so the check stays true; the new plist loads at next login.
  - `enableAutoStart`: writes the active entry as before (macOS: unload/load). Under tokenhop, then removes legacy
    entries (macOS: unload unless self, delete).
  - `disableAutoStart`: removes both names.
  - Names from the brand module: label, `.desktop`, `.vbs`, `/tmp/<slug>.log`, desktop Name/Comment.
- **Strings** read `ACTIVE`: tray menu/tooltips/stderr prefixes, `terminalUI` title and breadcrumb, `cli.js` tray logs,
  `xaiVideo` help, `build-cli.js` log, postinstall/runtime hook logs and runtime `package.json` name. `tray.ps1` header
  and code comments become brand-neutral. `cli.js` usage keeps `pkg.name` (the real bin name until the static rename).
- **Release-day PR** (separate, not merged until the release window): `cli/package.json` name/bin/description/
  keywords/homepage/repository/bugs, root `package.json` name/description. Pack-and-install verification runs there.

Out of scope: `has9Router` API field and tool-config keys (YAN-331/332), tray icons (YAN-334), `cli/README.md`
(YAN-338), publishing (YAN-341).

## Tests

- New `tests/unit/cli-autostart.test.js`, temp HOME/APPDATA, `process.platform` override, `execSync` spy (launchd
  registry fake), all 3 OSes: tokenhop check migrates a legacy fixture keeping port/host; tokenhop enable removes
  legacy; disable removes both; default brand writes and keeps the 9router entry.

## Validation

`npm run lint`, `npm run lint:brand -- --update`, `npm test` and `npm run build` on both brands, `npm run cli:pack`.
