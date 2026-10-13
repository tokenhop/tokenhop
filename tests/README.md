# tokenhop Tests

Vitest suite for the gateway (`src/`) and routing engine (`open-sse/`). `tests/` is an independent ESM package; the root `npm test` runs it plus the regression gate.

## Setup

Tests import from `src/`, so install root dependencies first, then the test package's own:

```bash
npm install                 # from the repo root
cd tests && npm install
```

## Running

From the `tests/` directory:

```bash
npx vitest run                           # whole suite
npx vitest run unit/capabilities.test.js # single file (path relative to tests/)
```

`npm test` runs the same thing with `--reporter=verbose`.

CI runs the suite twice, with the users & teams switch off and on (YAN-351). Both must pass. To run the on state locally:

```bash
TOKENHOP_MULTI_USER=on npm test          # from the repo root; =off, or unset, is the default state
```

> **Always load `tests/vitest.config.js`.** Run tests via `npm test`, from `tests/`, or with `npx vitest run -c tests/vitest.config.js`. Never point vitest at another config. Without this config the setup below never runs, `HOME` stays your real home, and the CLI-tool tests write to and delete under it (one such run deleted a real `~/.config`). The root `vitest.config.mjs` re-exports this config, so a bare `npx vitest` from the repo root is safe too.

## Data isolation

Tests never read or write your real data dir. Two setup hooks in `vitest.config.js` handle it:

- `setup/tempRoot.js` (`globalSetup`) records your real home in `TOKENHOP_TEST_REAL_HOME`, creates one parent temp dir (`<os.tmpdir()>/tokenhop-test-XXXX`) and deletes it after the run, even when files are skipped or fail to load.
- `setup/isolateDataDir.js` (`setupFiles`) runs before every test file's imports. It creates a fresh per-file root inside that parent, points `DATA_DIR` at `<root>/data`, and points `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` and the `XDG_*` dirs inside `<root>/home`. It uses the `forks` pool, because a worker thread's `os.homedir()` ignores the override, and it throws if the override isn't honored.

You don't need a `DATA_DIR=$(mktemp -d)` prefix. `unit/test-data-isolation.test.js` fails if the resolved data dir or home is outside the temp root.

Tests that write to or delete under the home dir must get it from `helpers/isolatedHome.js`: use `assertIsolatedHome()` instead of a bare `os.homedir()`, and `removeUnderHome(dirs)` instead of `fs.rm`. Both throw `HOME is not isolated …` unless the home lies inside this file's temp root, so a run without the setup fails before it touches anything. `unit/isolated-home-guard.test.js` covers the guard.

`vitest.config.js` splits the suite into two projects: `unit` (everything except `translator/real/**`) and `real` (`translator/real/**`). The live tests in `real` need your credentials. They skip isolation and use your real data dir only when their live gate (`RUN_REAL=1` or `RUN_E2E=1`) is set. `unit` stays isolated even then.

```bash
RUN_REAL=1 npx vitest run translator/real/antigravity-cache
```

The Antigravity prompt-cache probe also lives in `real/` and reads connections from the
real SQLite DB through the app DB layer. The OAuth client credentials are read at module
load, so they must be present in the environment before vitest starts — export them, or
use the `with-env.sh` wrapper to load them from the gitignored `.env.local`:

```bash
RUN_REAL=1 ENV_FILE=../.env.local ../scripts/with-env.sh npx vitest run translator/real/antigravity-cache
```

It requires `ANTIGRAVITY_OAUTH_CLIENT_ID` / `_SECRET` (plain values or 1Password `op://`
references in `.env.local`) and skips cleanly when the credential DB is unavailable or there is no active
Antigravity connection with a refresh token and project ID.

## Kimi live-models E2E fixture (YAN-192)

`tests/e2e/kimi-live-models.mjs` exercises the real production app under a
disposable `HOME`/`DATA_DIR` plus a loopback mock relay speaking the
`x-relay-target` / `x-relay-path` protocol. It asserts dashboard
(`/api/providers/:id/models`) and public (`/v1/models`) endpoints for
success → 503 failure → refresh recovery, including warning sanitization
(no synthetic secret echoed) and cache reuse. `--serve` keeps the fixture
alive for browser checks (`/dashboard/providers/kimi`); SIGINT cleans up the
app, relay, and temp tree. Not part of `npm test`. Requires a prior
`npm run build` (parent-gated); do not set `RUN_REAL=1` / `RUN_E2E=1`.

```bash
node tests/e2e/kimi-live-models.mjs          # headless HTTP assertions
node tests/e2e/kimi-live-models.mjs --serve  # keep alive for browser protocol
```

## Upgrade end to end

`tests/e2e/` holds the upgrade verification for the rebrand (`UPGRADING.md`). It
writes real state with the last release before the rebrand, starts the tokenhop
build of this checkout on it, and checks that nothing was lost: data, keys, SAML
issuer, tool configs, legacy env vars, backup import, autostart, MITM CA,
`tokenhop data migrate`, and the Docker volume under the repo's `compose.yml`.

It is not part of `npm test` (vitest only picks up `*.test.js`) and needs prebuilt
inputs. The script's header lists the exact commands, what it covers, and the
checks that stay manual. Everything runs under a temp `HOME` and `th344-`-prefixed
containers and volumes, all removed on exit.

## v1.0.3 → master upgrade rehearsal and gateway bench (YAN-378)

Two manual, Docker-based, non-CI scripts (stdlib only; helpers in `tests/e2e/upgrade-v1/`).

`tests/e2e/upgrade-from-v1.0.mjs` pulls `ghcr.io/tokenhop/tokenhop:1.0.3` (never a local `:latest`) and builds this checkout as `yan378-master`, labeled with a fingerprint of HEAD, the tracked diff and untracked file contents. `--reuse-master` accepts only an image whose label matches the current tree; `--final` marks the log `EVIDENCE=final` (otherwise `baseline`). Image IDs and the 1.0.3 RepoDigest/version are printed, and each container runs the resolved immutable image ID, not the tag. The 1.0.3 tag is not digest-pinned: a registry retag between `pull` and run is a documented TOCTOU, visible as a different printed RepoDigest. It seeds v1.0.3 through its real HTTP API (stored password, mock OIDC IdP with RS256 JWKS, SAML config, an openai-compatible node on a loopback mock upstream, connection, 2 combos, alias, 2 keys, 200 stream and non-stream chat calls with exact per-key/model/token totals), then:

- **Leg A** (switch off, no `INITIAL_PASSWORD`, so the stored hash must authenticate): data, keys, SSO/SAML, usage and the in-container CLI survive; no activation markers.
- **Leg B** (`TOKENHOP_MULTI_USER=on`): activation migration, protected `gateway-key-activation-*` backup (pre-activation, integrity ok, `0700`/`0600`), master root modes, no seeded secret in live DB/WAL bytes or TEXT/BLOB rows (with a positive control on the pre-upgrade DB), authenticated envelopes and hashed keys, restart without a second activation, then a second SSO user with positive own-resource controls and exact-status negatives (providers, combos, aliases, nodes, key detail, mutations, export, users, audit, usage stats/stream, chat with no/bad/other-user keys).
- **Fail closed**: wrong root and missing root must TERMINATE with a nonzero exit, leave no TCP listener and answer no HTTP status; a container that stays `Running` and returns 500 counts as failure. Switch-off after activation keeps hashed storage. After a second user exists, owner password re-login sends the owner's explicit login identifier, because omitting it is ambiguous by product design.
- **Rollback** per `UPGRADING.md`: the intended pre-schema backup is restored with no `-wal`/`-shm`, sha256 and `integrity_check` verified before start, 1.0.3 started with a different `INITIAL_PASSWORD`, schema objects compared (the automatic backup snapshot is table shells and rows only: indexes, triggers and `requestDetails` are omitted by `backupDbLite` by design, so the backup is compared on table shells while the live restored DB must round-trip the complete schema), and keys, combos, alias, node, connection, SSO settings, password and usage re-asserted.

`tests/e2e/gateway-overhead-bench.mjs` copies the seeded DB to three variants (1.0.3, master off, master on) and runs at least 5 rounds. Each round has four cells (sequential/concurrent x stream/non-stream) with the variant order shuffled per round. The accepted-risk note: automatic backups exclude `requestDetails`, so rollback compares only `usageHistory`. It asserts content, upstream-hit and usage-row deltas, and that activation really differs between variants. Master-on additionally carries exactly one active, non-limiting workspace TOTAL budget: spend delta must equal its request count, stay under 1% of every limit and never produce `budget_exceeded`. The gate is the median over rounds of master-on vs 1.0.3 at p50 and p95 per cell, 5% threshold, with the 95% interval and absolute ms printed. On a ~20 ms request 5% is ~1 ms, so read the absolute deltas on a noisy host. It exits 2 when 1-minute load exceeds `--max-load`.

All containers and scratch state are `yan378-` prefixed and labeled `yan378-run=<id>`, bind loopback only (asserted), and are removed on exit, SIGHUP, SIGINT and SIGTERM; nothing else on a shared Docker daemon is touched. Run on a quiet host:

```bash
node tests/e2e/upgrade-from-v1.0.mjs          # --reuse-master reuses a fingerprint-matching image
node tests/e2e/gateway-overhead-bench.mjs     # [--rounds 5..31] [--requests 120] [--concurrency 4] [--max-load N] [--reuse-master] [--final]
```

## Tenancy isolation tests

Users & teams (YAN-354). SQLite has no row-level security, so two guards run in `npm test`:

- `unit/tenancy-guard.test.js` fails when a table or `kv` scope is missing from `src/lib/db/tenancy.js`, or when an exported function in `src/lib/db/repos/` touches a `scoped` table or kv scope without taking `ctx` first or ending in `Unscoped`. A new table or kv scope needs a class there. Scoping an existing one moves it from `pending-scope` to `scoped` with its `scopeColumn`.
- `setup/tenancyHarness.js` seeds owner A, user B, their personal workspaces and a shared workspace (A owner, B member) into the file's isolated DB. `unit/tenancy-isolation.test.js` is the sample.

```js
import { callRoute, denied, seedTenancy } from "../setup/tenancyHarness.js";

const { a, b, shared } = await seedTenancy(); // { user, ctx, personal } each
expect(await denied(db.getWorkspace(b.ctx, a.personal))).toBe(true);
const res = await callRoute(GET, "/api/keys", { as: b }); // or { apiKey: "sk-…" }
```

`denied()` is true for `null`/`false` or a `TenancyError` `NOT_FOUND`/`FORBIDDEN`, and rethrows anything else; for lists, assert the other user's ids are absent. `callRoute()` signs a session cookie with the `sub`, `sv` and `wid` claims (ADR-0004), or sends `Authorization: Bearer`, and passes `{ params }` like Next.js.

Every scoping PR lists its negative tests in an isolation matrix:

```markdown
| Resource               | Read | List | Update | Delete | Use | Test                             |
| ---------------------- | ---- | ---- | ------ | ------ | --- | -------------------------------- |
| workspace (A personal) | ✅   | ✅   | ✅     | ✅     | n/a | `unit/tenancy-isolation.test.js` |
```

## Regression check

The suite runs green on a plain checkout. Compare a run against the known failures in `__baseline__/known-fails.txt` (empty since YAN-416 triaged all ~86 pinned failures) instead of reading raw results:

```bash
npx vitest run --reporter=json --outputFile=results.json; node __baseline__/verify-no-regression.mjs results.json
```

It reports tests (keyed by repo-relative path) and whole-file failures such as load errors, empty suites or throwing hooks (keyed as `<path> :: <file>`) that are not in the baseline. Other `__baseline__/verify-*.mjs` scripts check provider, alias and OAuth URL snapshots. Run them after changing the provider registry or alias logic.

## Embeddings

Unit tests for the `/v1/embeddings` endpoint implementation.

### Test Files

| File                          | What it tests                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `unit/embeddingsCore.test.js` | `open-sse/handlers/embeddingsCore.js` — core logic: body builder, URL router, headers, handler flow |

### Coverage Summary (36 tests)

#### `embeddingsCore.test.js` (36 tests)

- `buildEmbeddingsBody`: single string, array, encoding_format, default float
- `buildEmbeddingsUrl`: openai, openrouter, openai-compatible-*, unsupported providers
- `buildEmbeddingsHeaders`: per-provider header sets, fallback to accessToken
- `handleEmbeddingsCore` input validation: missing, wrong type, null, empty
- `handleEmbeddingsCore` success: response format, CORS, Content-Type, callbacks
- `handleEmbeddingsCore` errors: 400/429/500, network error, invalid JSON
- `handleEmbeddingsCore` token refresh: 401 retry, graceful fallback
