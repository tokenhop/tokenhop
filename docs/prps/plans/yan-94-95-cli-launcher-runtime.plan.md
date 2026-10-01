# YAN-95 + YAN-94: launcher crash watch in tray/headless mode, runtime npm installs pruning each other

GitHub: tokenhop/tokenhop#483, #484 · Linear: YAN-95, YAN-94 · Target: v0.6.x patch (PR into `master`, then
`backport:0.6` to `release/0.6`; `release/0.5` is frozen)

Both bugs reproduce on `origin/master` (0c24a220) and `origin/release/0.6`. `cli/cli.js` and `cli/hooks/*` are
byte-identical on both branches, so the squash commit cherry-picks cleanly. Both are CLI launcher fixes, so one PR.

## YAN-95: tray and headless modes never watch the server

### Research

- `cli/cli.js` `startServer()` spawns the server child, then branches: `--tray` (autostart, Hide-to-Tray on
  Linux/Windows) and headless (no TTY: pm2, systemd, docker without `-t`) both `return` early. The TUI path falls
  through to the final `attachServerEvents()` call at the bottom of the function; the other two never reach it.
- Without the `error`/`close` handlers, a crashed server is never restarted (`tryRestart` / `MAX_RESTARTS` / MITM
  disable fallback), the PID file is never cleaned up on a clean exit, and the tray keeps showing "running".
- Intentional stops still work with the handlers attached: SIGINT/SIGTERM/SIGHUP and the tray Quit set
  `isShuttingDown` first, the dashboard shutdown route exits the server with code 0, and `stopLauncher()` sends the
  launcher SIGTERM. All of these take the `isShuttingDown || code === 0` exit branch, not a restart.

### Design

- Call `attachServerEvents()` once, right after the signal handlers and before the mode branches, and drop the call
  at the end of the function. The helpers are function declarations (hoisted), and every variable they read is
  initialised by that point.

## YAN-94: runtime self-heal npm installs prune each other

### Research

- `cli/hooks/sqliteRuntime.js` installs `better-sqlite3` and `cli/hooks/trayRuntime.js` installs `systray2` into the
  same `<data dir>/runtime` project, both with `npm install --no-save`. `sql.js` (when needed) is a saved install.
- npm treats an unsaved package as extraneous and prunes it on the next install. Reproduced with npm 12.0.2:
  `npm i a --no-save` then `npm i b --no-save` leaves only `b`. So each launch reinstalls `better-sqlite3`, and the
  following `systray2` install removes it; the server always runs on the slower fallback driver.

### Design

- Install both as saved optional dependencies (`--save-optional --save-exact`) instead of `--no-save`.
  Verified with npm 12.0.2:
  - both packages stay installed across later installs;
  - a later install doesn't re-run an earlier package's install scripts, so `better-sqlite3`'s `--ignore-scripts`
    install (N-API prebuild) stays intact;
  - optional means a later install doesn't fail if one of them can't be built on this machine.
- Existing installs heal in one launch: the saved `better-sqlite3` install prunes the old unsaved `systray2`, which
  `ensureTrayRuntime` then reinstalls as saved. From the next launch on, both are present and no npm runs.
- Regression test `tests/unit/cli-runtime-install-args.test.js`: stub `child_process.spawnSync`, run both
  `ensure*Runtime` helpers against a temp `DATA_DIR`, and assert neither npm call passes `--no-save` and both save as
  optional.

## Validation

- `npm run lint`
- `cd tests && npx vitest run unit/cli-runtime-install-args.test.js unit/cli-process-control.test.js unit/cliLauncherArgs.test.js`
- `npm test` (known-fails gate), `npm run build`
- Manual: `node cli/cli.js --tray` style check is covered by reading; the restart path is unchanged code.
