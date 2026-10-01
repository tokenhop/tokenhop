# YAN-332 — tokenhop entries in JSON tool configs and CLI menus, with in-place migration

Target `v1.0.0` → base `master`, PR into `master`, no backport (RELEASING.md).
Trunk landing: behind the brand switch (handbook §5.1). Same split as YAN-331: writes,
ids, prefixes and messages follow the active brand; detect and Reset accept every name.

## Shared helpers — `src/lib/cliToolBrand.js` (additions)

| Export                          | Purpose                                                             |
| ------------------------------- | ------------------------------------------------------------------- |
| `modelRef(m)`                   | `` `${CLIENT_KEY}/${m}` ``                                          |
| `splitModelRef(v)`              | `{ key, model }` when `v` is `<any known key>/<model>`, else `null` |
| `isLegacyModelRef(v)` (private) | ref under a key Apply migrates (tokenhop brand only)                |
| `repointModelRef(v)`            | legacy ref → same model under `CLIENT_KEY`; anything else unchanged |
| `urlNamesClient(url)`           | base URL contains any known key (Kilo / Cline detection)            |
| `CUSTOM_MODEL_ID_PREFIX`        | `ACTIVE.customModelIdPrefix` (Droid ids)                            |
| `isCustomModelId(id)`           | ours under any brand (detect + Reset)                               |
| `isOwnedCustomModelId`          | active prefix, plus legacy prefix under tokenhop (Apply replaces)   |

Test harness shared with YAN-331: `tests/helpers/cliToolsBrand.js`.

## Per tool

- **OpenCode** — `provider[CLIENT_KEY]`; Apply takes legacy entries (merging their models
  and options under ours), writes `modelRef`, repoints `agent.*.model`; PATCH/DELETE and
  card read-back use `splitModelRef`; Reset removes every known key.
- **OpenClaw** — `models.providers[CLIENT_KEY]` and per-agent `models.json`; legacy block
  spread under ours; `agents.defaults.models` allowlist drops owned namespaces; primary,
  fallbacks and `agents.list[*].model` repointed; Reset removes every known key/prefix.
- **Kilo** — auth key detect via `findClientEntry`, URL detect via `urlNamesClient`; VS Code
  `customProvider.name = CLIENT_NAME`; Apply drops legacy auth keys under tokenhop.
- **Droid** — ids `${CUSTOM_MODEL_ID_PREFIX}<i>`; Apply replaces `isOwnedCustomModelId`;
  detect/Reset use `isCustomModelId`. Display names carry no brand (unchanged).
- **Copilot** — entry `name: CLIENT_NAME`; Apply replaces the active entry or, under
  tokenhop, the legacy one in place and drops other legacy duplicates; detect/Reset via
  `isClientKey(name)`. Third-party extension `hotrungnhan.9router-for-github-copilot` kept.
- **Cline** — URL detect via `urlNamesClient`; messages.
- **Claude, Cowork, Devin** — already brand-neutral after YAN-331 (`hasTokenhop`); no change.
- **Antigravity MITM** — the route's admin-restart message from `ACTIVE.name`. The MITM
  cards' JSX copy stays: its literals are i18n keys in 34 locales, so it moves with the UI
  copy and i18n issues (YAN-335/YAN-336).
- **CLI menus** — `cli/src/cli/menus/cliTools.js` reads brand via `requireShared("brand")`,
  accepts every key/prefix when reading status, labels from `ACTIVE.name`.
- `has9RouterConfig` / `get9RouterEntry` internals renamed.

Out of scope: TOML tools (YAN-331), general UI copy (`InterceptTools`, `SetupScaffold`,
`toolStatus` comments → YAN-335), upstream-facing ids (YAN-330).

## Tests

`tests/unit/cli-tools-brand-opencode.test.js` (OpenCode, OpenClaw) and
`tests/unit/cli-tools-brand-json.test.js` (Kilo, Droid, Copilot, Cline), legacy JSON
fixtures in `tests/fixtures/legacy/cli-tools/`. Per tool: legacy → apply (tokenhop) migrates
in place keeping unrelated config; legacy → reset (any brand) clean; default brand Apply
output unchanged; GET reports `hasTokenhop` for legacy configs.

## Verify

`npm run lint`, `npm run lint:brand -- --update`, `npm test` and `npm run build` under both
brands; manual Apply/Reset against a temp HOME seeded with legacy configs.
