# Plan: ~/.tokenhop data dir with legacy fallback and `data migrate` (YAN-325)

## Metadata

- Linear: YAN-325 · GitHub: #195 · Target: v1.0.0 (trunk `master`, no backport)
- Branch: `rebrand/yan-325-data-dir` · Worktree: `.claude/worktrees/tokenhop-data-dir`
- Blocker YAN-324 (shared resolver): merged (#415).
- Trunk landing: **behind the brand switch**. Default brand: resolver, output and
  CLI unchanged; `data migrate` is not offered.

## Design

### Resolver (`src/shared/dataDir/index.cjs`)

`DATA_DIR` set → unchanged. Otherwise, under the tokenhop brand:

| State       | Result | Warning                                         |
| ----------- | ------ | ----------------------------------------------- |
| only legacy | legacy | `warnLegacyOnce` + `tokenhop data migrate` hint |
| only new    | new    | none                                            |
| both        | new    | once: legacy dir ignored                        |
| neither     | new    | none                                            |

Under the default brand both names are the legacy name, so the result is the
old `~/.9router` with no warning. New exports: `legacyDataDir(opts)`,
`isLegacyDataDir(dir, opts)`. `exists` is injectable so the Win32 rows run on
any OS.

Decision: the resolver does not create the default dir. Every consumer already
creates what it writes (`ensureDirs`, `writePidFile`, …), and creating paths
from injected Win32 options on POSIX would leave stray dirs.

### Stored absolute paths (audit)

| Location                                                     | Holds data-dir path?             | Action                                                 |
| ------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------ |
| `settings` row (DB JSON)                                     | no (URLs only)                   | none                                                   |
| `kv`, `_meta`, other DB JSON columns                         | no                               | none                                                   |
| tailscale `--statedir`                                       | recomputed per start             | none                                                   |
| MITM `rootCA.{key,crt}` paths                                | recomputed per start             | none                                                   |
| `NODE_EXTRA_CA_CERTS` (Win `setx`, macOS `launchctl setenv`) | yes: `<dataDir>/mitm/rootCA.crt` | migrate rewrites it when it points into the legacy dir |
| `runtime/` (`package.json`, NODE_PATH)                       | no / in-memory                   | none                                                   |
| headroom, pxpipe                                             | no (pids, logs, name)            | none                                                   |
| tunnel / app / MITM PID files, `state.json`                  | no (pids, URLs)                  | none                                                   |
| autostart plist / `.desktop` / `.vbs`                        | install paths only               | none                                                   |

### `data migrate` (`cli/src/cli/commands/dataMigrate.js`)

Refuses: not tokenhop brand; `DATA_DIR` set; launcher/server/MITM running (PID
files + port listen check); new dir exists and is not empty. Legacy gone →
`already migrated` (exit 0). Same fs → `renameSync`. `EXDEV` → `cpSync`
(recursive, preserveTimestamps), verify file counts + sizes and
`PRAGMA integrity_check` (node:sqlite when available; the copy is opened
read-write and checkpointed, since a killed server leaves `-wal`/`-shm`);
success renames legacy to `<legacy>.migrated-<stamp>`; failure moves the copy
to `<new>.failed-<stamp>` (or removes it if a lock blocks the rename) so the
resolver keeps using legacy. Never deletes user data. `--dry-run` prints the
plan. PID files are checked in both dirs. The running check is best-effort
(a server started after the check is not detected).

### i18n

The callout adds one sentence. `i18n-coverage` fails any PR that adds a
literal, so the PR carries it for all 34 locales (precedent: #386, #396). The
title and copy-field labels reuse existing keys.

### Dashboard

`GET /api/settings/environment` adds `dataDir`, `isLegacyDataDir`.
`EnvironmentSection` shows a `warn` Callout with the legacy path and the
migrate command when `isLegacyDataDir`. It can only render in a tokenhop build.

## Files

| File                                                                    | Change                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------- |
| `src/shared/dataDir/index.cjs`                                          | resolution order, `legacyDataDir`, `isLegacyDataDir` |
| `cli/src/cli/commands/dataMigrate.js` (new)                             | command                                              |
| `cli/cli.js`                                                            | dispatch + help under tokenhop brand                 |
| `src/app/api/settings/environment/route.js`                             | readout fields                                       |
| `src/app/(dashboard)/dashboard/settings/sections/EnvironmentSection.js` | callout                                              |
| `tests/unit/data-dir-resolver.test.js`                                  | brand matrix                                         |
| `tests/unit/cli-data-migrate.test.js` (new)                             | migrate matrix                                       |

## Out of scope

Env var renames, CLI package rename (YAN-329), PID file rename (YAN-327),
Docker (YAN-337), UI copy such as `DataSection` path text (YAN-335).
