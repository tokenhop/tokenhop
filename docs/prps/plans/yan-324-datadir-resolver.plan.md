# Plan: one shared data-dir resolver (YAN-324)

## Summary

Five copies of the data-dir logic (app, MITM, CLI runtime, CLI API client, MITM alias
cache) collapse into one CommonJS module, `src/shared/dataDir/index.cjs`, that takes
its directory name from `LEGACY.dataDirName`. Every copy keeps its exported names and
delegates. The CLI pack and the Docker image ship the module next to the brand module.

## User Story

As the maintainer of the tokenhop rebrand, I want the data directory resolved in one
place, so that the `~/.tokenhop` rename (YAN-325) is a one-file change.

## Problem → Solution

Five resolvers that disagree in edge cases (win32 guard, unwritable `DATA_DIR`,
win32 without `APPDATA`) → one resolver with injectable `{ platform, env, homedir }`,
used by the app, MITM and CLI.

## Metadata

- **Complexity**: Medium
- **Source PRD**: N/A (Linear YAN-324, GitHub #194)
- **PRD Phase**: N/A
- **Estimated Files**: 12

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/tokenhop/tokenhop/.claude/worktrees/tokenhop-datadir-resolver/ (branch: rebrand/yan-324-datadir-resolver)

---

## UX Design

Internal change — no user-facing UX transformation. Paths stay `~/.9router` /
`%APPDATA%\9router`.

---

## Mandatory Reading

| Priority | File                                                   | Lines   | Why                                          |
| -------- | ------------------------------------------------------ | ------- | -------------------------------------------- |
| P0       | `src/lib/dataDir.js`                                   | all     | Canonical behaviour to preserve              |
| P0       | `src/shared/brand/index.cjs`                           | all     | `LEGACY.dataDirName`; CJS module style       |
| P0       | `cli/hooks/sqliteRuntime.js`                           | 1-30    | CLI per-call resolver, exported `getDataDir` |
| P0       | `cli/scripts/build-cli.js`                             | 150-175 | `copyBrandModule`, the CLI copy rule         |
| P1       | `src/mitm/paths.js`                                    | all     | Fifth copy                                   |
| P1       | `src/lib/mitmAliasCache.js`                            | 1-15    | Inline copy                                  |
| P1       | `cli/src/cli/api/client.js`                            | 1-35    | Inline copy                                  |
| P1       | `Dockerfile`                                           | 50-60   | Image copies raw `src/mitm` only             |
| P2       | `tests/unit/cli-build-artifacts.test.js`               | 120-155 | Pack test for shared modules                 |
| P2       | `tests/unit/test-data-isolation.test.js`               | all     | Must stay green                              |
| P2       | `tests/translator/real/antigravity-cache.real.test.js` | 110-125 | Sixth (test-only) copy                       |

## External Documentation

No external research needed.

---

## Patterns to Mirror

### NAMING_CONVENTION

```js
// SOURCE: src/shared/brand/index.js:1-3
// ESM entry for the brand module; the values live in index.cjs.
import brand from "./index.cjs";
export const { BRAND_IDS, ... } = brand;
```

### ERROR_HANDLING

```js
// SOURCE: src/lib/dataDir.js:29-37
} catch (e) {
  if (e?.code === "EACCES" || e?.code === "EPERM") {
    console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
    return defaultDir();
  }
  throw e;
```

### LOGGING_PATTERN

`console.warn` with a `[DATA_DIR]` prefix; messages kept verbatim.

### SERVICE_PATTERN

```js
// SOURCE: cli/scripts/build-cli.js:157-166
const BRAND_MODULE_PATH = path.join("src", "shared", "brand", "index.cjs");
function copyBrandModule(appDir, cliDir) { ... fs.copyFileSync(...) }
```

### TEST_STRUCTURE

```js
// SOURCE: tests/unit/cli-process-control.test.js:1-7
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pc = require("../../cli/src/cli/utils/processControl.js");
```

---

## Files to Change

| File                                                   | Action | Justification                                        |
| ------------------------------------------------------ | ------ | ---------------------------------------------------- |
| `src/shared/dataDir/index.cjs`                         | CREATE | The one resolver                                     |
| `tests/unit/data-dir-resolver.test.js`                 | CREATE | Every branch, simulated win32                        |
| `src/lib/dataDir.js`                                   | UPDATE | ESM façade, keeps `DATA_DIR`/`getDataDir`            |
| `src/mitm/paths.js`                                    | UPDATE | Delegate, keeps `DATA_DIR`/`MITM_DIR`                |
| `src/lib/mitmAliasCache.js`                            | UPDATE | Delegate                                             |
| `cli/hooks/sqliteRuntime.js`                           | UPDATE | Delegate (packed copy or repo source), per call      |
| `cli/src/cli/api/client.js`                            | UPDATE | Reuse `sqliteRuntime.getDataDir`                     |
| `cli/scripts/build-cli.js`                             | UPDATE | Copy brand + dataDir modules                         |
| `tests/unit/cli-build-artifacts.test.js`               | UPDATE | Assert both modules packed                           |
| `Dockerfile`                                           | UPDATE | Ship `src/shared/{brand,dataDir}` for the MITM child |
| `tests/translator/real/antigravity-cache.real.test.js` | UPDATE | Use `defaultDataDir` instead of an inline copy       |
| `scripts/brand-guard.baseline.json`                    | UPDATE | Lower counts (`--update`)                            |

## NOT Building

- Renaming the directory to `tokenhop` (YAN-325), env renames (YAN-326).
- Renaming `9router-runtime`, `9router.pid` and other literals in touched files.
- UI copy that shows `~/.9router` paths.

---

## Step-by-Step Tasks

### Task 1: Resolver unit tests (first, failing)

- **ACTION**: Create `tests/unit/data-dir-resolver.test.js`.
- **IMPLEMENT**: Cases: unset/empty `DATA_DIR` on linux → `<home>/.<LEGACY.dataDirName>`; win32 with
  `APPDATA`; win32 without `APPDATA` → `<home>\AppData\Roaming\<name>`; win32 + Unix-style `DATA_DIR`
  → default, one warning across two calls; writable `DATA_DIR` created and returned; unwritable
  (read-only parent, skipped on win32/root) → default + warning; ENOTDIR rethrown;
  `sqliteRuntime.getDataDir` is the shared function. No `9router` literal in the file.
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: `createRequire`, `node:fs`, `node:os`, `node:path`
- **GOTCHA**: Pass `env`/`platform`/`homedir` explicitly; don't mutate `process.env`.
- **VALIDATE**: `cd tests && npx vitest run unit/data-dir-resolver.test.js` fails before Task 2.

### Task 2: Shared resolver

- **ACTION**: Create `src/shared/dataDir/index.cjs` exporting `getDataDir(opts)` and `defaultDataDir(opts)`.
- **IMPLEMENT**: Logic of `src/lib/dataDir.js`; `path.win32`/`path.posix` by `platform`; name from
  `LEGACY.dataDirName`; warnings deduplicated per message (the CLI resolves per call).
- **MIRROR**: ERROR_HANDLING, LOGGING_PATTERN
- **GOTCHA**: Dependency-free CJS (`require("../brand/index.cjs")`) so the CLI copy works.
- **VALIDATE**: Task 1 tests pass.

### Task 3: Delegate the app, MITM and alias cache

- **ACTION**: `src/lib/dataDir.js` → `import dataDir from "../shared/dataDir/index.cjs"`; re-export
  `getDataDir`, keep `DATA_DIR = getDataDir()`. `src/mitm/paths.js` and `src/lib/mitmAliasCache.js`
  require/import it.
- **GOTCHA**: MITM uses relative requires only (esbuild bundles them for the CLI).
- **VALIDATE**: `test-data-isolation`, `mitm-root-ca` tests pass.

### Task 4: Delegate the CLI and pack the module

- **ACTION**: `sqliteRuntime.js` loads the packed copy (`../src/shared/dataDir/index.cjs`) when present,
  else the repo source (`../../src/shared/...`), and throws when neither exists. `client.js` requires
  `getDataDir` from `../../../hooks/sqliteRuntime`. `build-cli.js` copies both shared modules
  (`SHARED_MODULE_PATHS`, `copySharedModules`); update the artifacts test.
- **GOTCHA**: `cli/src/shared/` is gitignored and exists only after a build.
- **VALIDATE**: `cli-process-control`, `cli-build-artifacts` pass; `npm --prefix cli run pack:cli` tarball lists `src/shared/dataDir/index.cjs`.

### Task 5: Docker image and the test-only copy

- **ACTION**: Dockerfile copies `src/shared/brand` and `src/shared/dataDir` next to `src/mitm`.
  `antigravity-cache.real.test.js` uses `defaultDataDir()`.
- **VALIDATE**: `docker build` then `node -e "require('/app/src/mitm/paths.js')"` inside the image.

### Task 6: Brand baseline

- **ACTION**: `npm run lint:brand -- --update`.
- **VALIDATE**: `npm run lint:brand` green with lower counts.

---

## Testing Strategy

### Unit Tests

| Test                  | Input                    | Expected Output                 | Edge Case? |
| --------------------- | ------------------------ | ------------------------------- | ---------- |
| default posix         | linux, no `DATA_DIR`     | `<home>/.<name>`                | no         |
| empty `DATA_DIR`      | `DATA_DIR=""`            | default                         | yes        |
| win32 + APPDATA       | win32, `APPDATA=C:\A`    | `C:\A\<name>`                   | no         |
| win32 no APPDATA      | win32                    | `<home>\AppData\Roaming\<name>` | yes        |
| win32 Unix path       | win32, `DATA_DIR=/var/x` | default, warn once              | yes        |
| writable `DATA_DIR`   | temp dir child           | created, returned               | no         |
| unwritable `DATA_DIR` | child of 0o555 dir       | default, warn                   | yes        |
| other mkdir error     | path under a file        | throws ENOTDIR                  | yes        |

### Edge Cases Checklist

- [x] Empty input
- [x] Permission denied
- [x] Simulated win32 with and without `APPDATA`

---

## Validation Commands

### Static Analysis

```bash
npm run lint && npm run lint:brand
```

EXPECT: green

### Unit Tests

```bash
cd tests && npx vitest run unit/data-dir-resolver.test.js unit/test-data-isolation.test.js unit/cli-process-control.test.js unit/cli-build-artifacts.test.js unit/mitm-root-ca.test.js
```

EXPECT: All pass

### Full Test Suite

```bash
npm test && NEXT_PUBLIC_BRAND=tokenhop npm test
npm run build && NEXT_PUBLIC_BRAND=tokenhop npm run build
```

EXPECT: No regressions vs known-fails baseline; both builds succeed

### Manual Validation

- [ ] `npm --prefix cli run pack:cli`; tarball lists `src/shared/dataDir/index.cjs` and `src/shared/brand/index.cjs`
- [ ] Packed CLI: `node -e "console.log(require('<extracted>/hooks/sqliteRuntime').getDataDir())"` under a temp HOME
- [ ] Docker image: MITM `paths.js` loads; app starts and serves `/`

---

## Acceptance Criteria

- [ ] All tasks completed
- [ ] All validation commands pass
- [ ] Tests written and passing
- [ ] No lint errors
- [ ] Brand baseline lowered for touched files

## Completion Checklist

- [ ] Code follows discovered patterns
- [ ] Exported names/signatures unchanged
- [ ] No new `9router` literal outside the brand module
- [ ] No new dependencies

## Risks

| Risk                                          | Likelihood | Impact | Mitigation                                     |
| --------------------------------------------- | ---------- | ------ | ---------------------------------------------- |
| Next/Turbopack fails importing `.cjs` in app  | Low        | High   | Both brand builds + `npm run start` smoke      |
| Docker MITM child misses `src/shared`         | Med        | High   | Dockerfile COPY + in-image require check       |
| Packed CLI can't find the module              | Low        | High   | Pack test + run from extracted tarball         |
| Stale `cli/src/shared` copy in a dev checkout | Low        | Low    | Overwritten on every CLI build (same as brand) |

## Notes

Decisions (for the PR):

- The fifth copy `src/mitm/paths.js` is consolidated too; the issue listed four.
- The edge cases where the copies disagreed now follow `src/lib/dataDir.js` (the server):
  the CLI and MITM gain the win32 Unix-path guard and the unwritable fallback, and the
  CLI runtime dir uses `%USERPROFILE%\AppData\Roaming` when `APPDATA` is unset. This
  makes the CLI look for the PID file and runtime dir where the server writes them.
  Default paths are unchanged.
- Warnings are deduplicated per message because the CLI resolves per call.
