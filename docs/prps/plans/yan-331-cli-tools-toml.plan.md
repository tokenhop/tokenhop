# YAN-331 — tokenhop entries in TOML/YAML tool configs, with in-place migration

Target `v1.0.0` → base `master`, PR into `master`, no backport (RELEASING.md).
Trunk landing: behind the brand switch (handbook §5.1).

## Shared pattern — `src/lib/cliToolBrand.js` (pure, no fs; routes and cards import it)

| Export                                   | Default brand                      | tokenhop brand            |
| ---------------------------------------- | ---------------------------------- | ------------------------- |
| `CLIENT_KEY` (written)                   | `9router`                          | `tokenhop`                |
| `CLIENT_NAME`                            | `9Router`                          | `tokenhop`                |
| `LEGACY_CLIENT_KEYS` (migrated on Apply) | `[]`                               | `LEGACY.clientConfigKeys` |
| `ALL_CLIENT_KEYS` (detect + reset)       | active first, then every known key | same                      |
| `JCODE_API_KEY_ENV`                      | `JCODE_9ROUTER_API_KEY`            | `JCODE_TOKENHOP_API_KEY`  |

Helpers: `findClientEntry(map)`, `takeLegacyEntry(map)` (removes legacy keys, returns the
first one found), `isClientKey(value)`. Extra fields carry over only from a migrated legacy
entry, so default-brand output is unchanged.

- Detect: `hasTokenhop` true for any of `ALL_CLIENT_KEYS` (ships unconditionally).
- Apply: write `CLIENT_KEY`, spread the legacy entry under ours, delete legacy, repoint
  references. Default brand: no legacy keys → byte-for-byte today's behaviour.
- Reset: remove every key in `ALL_CLIENT_KEYS` (ships unconditionally).
- Parse failure: unchanged 422 path; message names `ACTIVE.name`.

## Per tool

- **Codex** — `model_providers.<key>`, `model_provider`, `profiles.*.model_provider` repointed;
  card preview from `CLIENT_KEY`/`CLIENT_NAME`.
- **jcode** — `providers.<key>` (keeps `models`, extra fields, falls back to legacy
  `default_model`), `provider.default_provider` repointed, env var + `provider-<key>.env`.
  Order: write new env file → write config → remove legacy env file (all its vars were
  copied first, so nothing is lost).
- **DeepSeek TUI / Hermes** — files carry no brand key; rename `build9RouterConfig` /
  `has9RouterConfig`, messages from `CLIENT_NAME`.
- **Grok Build** — `grokBuildConfig.js` reads the slot key from the brand at module load. Apply first migrates
  legacy markers (`# <legacy>-prev-*`, sentinel), section headers, `[models] default` and
  `[subagents.models]` mappings; Reset restores and removes for every known key, so a legacy
  apply + new reset returns the user's previous default.

## Status field rename (all 13 routes + consumers)

`has9Router` → `hasTokenhop`: routes, `toolStatus.js`, `ToolSummaryCard`, `ToolGridCard`,
every card's `resetDisabled`, `cli/src/cli/menus/cliTools.js`, `cli/src/cli/api/client.js`,
tests. No alias (dashboard and CLI ship together).

## Tests — `tests/unit/cli-tools-brand-migration.test.js`

Fixtures in `tests/fixtures/legacy/cli-tools/`. Each case loads the routes fresh under an
explicit brand, so results don't depend on CI's `NEXT_PUBLIC_BRAND`.

- Codex, jcode, Grok: legacy → apply (new entry, legacy gone, model kept, unrelated
  content equal); legacy → reset (clean). Codex also covers a fresh file.
- DeepSeek TUI, Hermes: detection only (their files carry no brand key)
- Grok: legacy markers restore the previous default and subagents
- jcode: env-file migration (other vars kept, legacy file removed)
- Codex/jcode: parse-failure file untouched
- default brand: Apply output unchanged from today

## Verify

`npm run lint`, `npm run lint:brand` (+ `--update` lowers the baseline), `npm test` and
`npm run build` under both brands; a manual Apply/Reset against a temp HOME seeded with
legacy configs, with the diffs in the PR.
