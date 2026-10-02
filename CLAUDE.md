# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

tokenhop (`tokenhop-app`) — a local AI routing gateway + Next.js dashboard. It exposes one OpenAI-compatible endpoint (`/v1/*`) and routes traffic across 40+ upstream providers with format translation, model-combo fallback, multi-account fallback, OAuth/API-key credential management, token refresh, quota/usage tracking, and optional cloud sync.

Two published artifacts live in this one repo:

- The **dashboard + gateway** (root `package.json`, `tokenhop-app`) — the Next.js server that does the actual routing.
- The **CLI launcher** (`cli/`, published to npm as `tokenhop`) — a separate package that installs/starts the server and manages the tray. It has its own `package.json`, version, and build.

The code lives in `src/` (Next.js app + dashboard/compat APIs), `open-sse/` (the provider-agnostic routing/translation engine), `cli/` (the launcher package), and `tests/`.

## Branching & releases

**Read [`RELEASING.md`](RELEASING.md) before creating a branch, opening a PR, or cutting a release.** It defines the current trunk, which branch each change targets, backports, and the release steps. Never open "sync master into …" PRs.

## Commands

Dashboard/gateway (run from repo root):

```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev   # dev (webpack, port 20127 by default via next dev)
npm run build && PORT=20128 HOSTNAME=0.0.0.0 npm run start           # production
```

- Bun variants: `npm run dev:bun` / `build:bun` / `start:bun`.
- Default runtime port is **20128** (dashboard at `/dashboard`, API at `/v1`).
- Lint/format: `npm run lint` (Biome for JS/JSON/CSS, markdownlint + Prettier for Markdown/YAML, ShellCheck), `npm run lint:fix`, `npm run format`. Config: `biome.json`, `.markdownlint.json`, `.prettierrc`. Many legacy a11y/React rules are warnings, not errors — don't add new ones. Import sorting is off on purpose: translators self-register via import side effects, so import order matters.
- Git hooks (lefthook, auto-installed by `npm install`): pre-commit formats + lints staged files, commit-msg runs commitlint (Conventional Commits), pre-push runs full lint. Bypass once with `--no-verify`.
- CI: `.github/workflows/ci.yml` (tests vs known-fails baseline, alias/OAuth baselines, `next build`), `lint.yml`, `pr-title.yml`, `i18n-translate.yml` (translation bot PR; see Dashboard i18n below). Node version pinned in `.nvmrc`.

CLI package (`cli/`):

```bash
npm run cli:pack       # build + npm pack from root
cd cli && npm run dev  # nodemon watch
```

Tests (vitest, in `tests/`, an **independent** ESM package; root `npm test` runs it plus the regression gate, same as CI):

```bash
npm install                             # ROOT deps first — tests import from src/ which needs `open`, `undici`, etc.
cd tests && npm install                 # then tests' own deps (vitest) → tests/node_modules (allowed by tests/.gitignore)
npm test                                # (from root) full run gated on known-fails.txt — what CI runs
npx vitest run                          # all tests; auto-discovers tests/vitest.config.js
npx vitest run unit/capabilities.test.js   # single file (path relative to tests/)
```

> `vitest.config.js` resolves the `open-sse`/`@/` aliases from the repo root regardless of where vitest lives.
>
> **Always run tests via `npm test`, from `tests/`, or with `-c tests/vitest.config.js`.** Never use another vitest config. That config's setup moves `HOME`/`DATA_DIR` to a temp dir; without it the CLI-tool tests write to and `rm -rf` under your real home (one run deleted a real `~/.config`). The root `vitest.config.mjs` re-exports it so a bare root `npx vitest` is safe, and tests that touch the home dir must go through `tests/helpers/isolatedHome.js`, which throws when `HOME` isn't isolated.
>
> **Runs are isolated by default.** Every test file gets its own temp `DATA_DIR`/`HOME` (`tests/setup/`, forks pool), so your real data dir is never touched and no `DATA_DIR=$(mktemp -d)` prefix is needed. Only `translator/real/**` under `RUN_REAL=1`/`RUN_E2E=1` uses the real data dir. Guarded by `unit/test-data-isolation.test.js`; details in `tests/README.md`.
>
> The suite runs green on a plain checkout; judge regressions against `tests/__baseline__/known-fails.txt`, not a raw run (from `tests/`):
>
> ```bash
> npx vitest run --reporter=json --outputFile=results.json; node __baseline__/verify-no-regression.mjs results.json
> ```
>
> Live-network tests are env-gated (`RUN_REAL=1` / `RUN_E2E=1`); they skip without credentials.

- `*.real.test.js` under `tests/translator/real/` make live provider calls — skip unless credentials are set.
- Regression baselines: `tests/__baseline__/verify-*.mjs` compare against committed snapshots (providers, aliases, OAuth URLs). Run these after touching provider registry / alias logic.

## Architecture

Two authoritative docs already exist — read them before working in these areas rather than re-deriving:

- `docs/ARCHITECTURE.md` — full system: request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, data model.
- `open-sse/AGENTS.md` — the routing/translation engine's own conventions and "how to add a provider/executor/translator". **Read this before editing anything under `open-sse/`.**

### Request flow (the thing to understand first)

`src/app/api/v1/*` route (Next rewrite maps `/v1/*` → `/api/v1/*` in `next.config.mjs`)
→ `src/sse/handlers/chat.js` (parse, combo expansion, account-selection loop)
→ `open-sse/handlers/chatCore.js` (detect source format, translate request, dispatch to executor, retry/refresh, stream setup)
→ `open-sse/executors/*` (per-provider upstream call; `default.js` handles any OpenAI-compatible provider)
→ `open-sse/translator/*` (client format ↔ provider format)
→ SSE back to client.

`src/sse/` is the app-side entry glue; `open-sse/` is the provider-agnostic engine (also usable standalone). Cross that boundary consciously.

### Translator engine (`open-sse/translator/`)

- Pivots through **OpenAI as the intermediate format**. A translator registered on an exact `source:target` pair (e.g. `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop. Prefer a direct route for fragile pairs (thinking blocks, tool ids, non-base64 images, `is_error`).
- Translators **self-register** via `register(from, to, reqFn, resFn)` as an import side effect — a new translator file MUST be imported in `open-sse/translator/index.js` or it never runs.
- Never hardcode role/block/model strings — use `open-sse/translator/schema/` and `open-sse/config/` constants. Config-driven and DRY is enforced by convention here.

### Provider registry (`open-sse/providers/registry/*`)

- One file per provider. `providers/registry/index.js` is an **auto-generated** static import list — regenerate it with `scripts/migrate-registry.mjs` / `injectDisplayToRegistry.mjs`, don't hand-edit.
- Add a provider: copy `providers/REGISTRY_TEMPLATE.js`, add models to `config/providerModels.js`. Only add an executor for non-OpenAI-compatible upstreams.

### Persistence — IMPORTANT (ARCHITECTURE.md is stale here)

State is **no longer `db.json`**. It's a SQLite layer under `src/lib/db/` with an adapter fallback chain (`driver.js`): `bun:sqlite` → `better-sqlite3` (optional native dep) → `node:sqlite` (Node ≥22.5) → `sql.js` (pure-JS fallback, always works). `better-sqlite3` is deliberately in `optionalDependencies` so install never fails without build tools.

- `src/lib/localDb.js` is a **backward-compat shim** re-exporting `src/lib/db/index.js`. New code should import from `@/lib/db/index.js`; per-entity logic lives in `src/lib/db/repos/*`. Schema/migrations in `src/lib/db/migrations/`.
- DB file location resolves via `src/lib/db/paths.js` (`DATA_DIR`, else `~/.tokenhop/`, or a legacy data dir that already exists; see `src/lib/dataDir.js`).
- Usage and request logs live in the same SQLite DB under `DATA_DIR` — `src/lib/usageDb.js` is just a shim re-exporting `@/lib/db/index.js`. `usage.json` is only a legacy one-time migration source; `log.txt` no longer exists.

### RTK token saver (`open-sse/rtk/`)

Pre-translate hooks that compress `tool_result` content in-place to cut tokens. **Fail-open**: any error returns null and leaves the body untouched — never throw out of them. Skips `is_error`/`status:"error"` results to preserve traces.

### Dashboard i18n (`public/i18n/literals/`)

- `src/i18n/runtime.js` translates visible DOM text by exact lookup in `public/i18n/literals/<locale>.json`: 34 locales, keyed by the English source string, key-sorted. A missing key renders in English, so untranslated strings never break the UI. `scripts/i18n-literals.mjs` extracts the literals and reports missing keys, orphaned keys and placeholder drift.
- **Don't translate in feature PRs.** After dashboard source lands on master, `.github/workflows/i18n-translate.yml` translates the missing keys through `scripts/translate-literals.mjs`, against the tokenhop gateway with a model combo. It then opens or refreshes the `i18n/auto-translate` bot PR with auto-merge (squash) on, so it lands once the required checks pass. Only that bot writes the locale files. `tests/unit/i18n-coverage.test.js` therefore doesn't check for missing keys, only placeholder drift and the provider risk notice. Config is the repo secrets `TRANSLATE_BASE_URL`, `TRANSLATE_API_KEY`, `TRANSLATE_MODEL` and `I18N_BOT_TOKEN` (a PAT: `GITHUB_TOKEN` can't open PRs here, and PRs it opens don't trigger the required checks).
- **General Translation (generaltranslation.com) was piloted and rejected** (YAN-608). Its quality is good, it diffs per segment, and it imports existing translations for free. It bills per target locale, though: about $1 per 1K input tokens × 34 locales, so roughly $2 per fix PR and about $400 per redesign-sized batch. Its Locadex automations cost the same plus agent fees. Don't re-propose paid translation services unless pricing changes.

## Conventions & gotchas

- Plain JavaScript (ESM), no TypeScript. `@/*` path alias → `src/*` (`jsconfig.json`).
- `custom-server.js` wraps the Next standalone server to derive client IP from the TCP socket and strip attacker-controlled `X-Forwarded-For` — trusting forwarding headers only from a loopback reverse proxy, and then only the rightmost XFF hop (appending proxies like cloudflared/nginx leave the leftmost entries client-controlled). Preserve this when touching request/IP/rate-limit code.
- Security-sensitive env: `JWT_SECRET` (session cookie), `INITIAL_PASSWORD` (default `123456` — must override), `API_KEY_SECRET`, `MACHINE_ID_SALT`. Full env contract in `.env.example` and ARCHITECTURE.md's env matrix.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — they're handled inside their own executor, not the translator.
- Versioning, CHANGELOG, and tagging: see [`RELEASING.md`](RELEASING.md). Commit style is Conventional Commits (`fix(translator): …`, `feat(...)`).
