# Plan: one config builder per CLI tool, shared by Apply and the manual snippet (YAN-617)

## Summary

Every custom-config CLI tool builds its config twice: in the Apply route and in the card's
`getManualConfigs()`. They drift. Extract one pure builder per tool under
`src/lib/cliToolConfigs/`, make the route and the card both use it, and add a parity test
that fails when they diverge.

## User Story

As a user running the dashboard on a remote server, I want the manual setup snippet to
contain exactly what Apply would write, so that pasting it gives the same working tool config.

## Problem → Solution

Two hand-written copies per tool (route + card) that drift → one pure builder per tool
returning file fragments; route merges them into the user's files, card renders them; a
vitest parity test compares Apply's output on a clean HOME with the builder's fragments.

## Metadata

- **Complexity**: XL (11 tools × builder/route/card + shared + test)
- **Source PRD**: N/A (Linear YAN-617, parent YAN-616; GitHub #465)
- **PRD Phase**: N/A
- **Estimated Files**: ~37
- **Target**: `v0.6.x` → PR into `master`, then `backport:0.6` cherry-pick to `release/0.6`
- **Branch**: `feat/yan-617-cli-tool-config-builders`

## Batches

| Batch | Tasks                                                         | Depends On | Parallel Width |
| ----- | ------------------------------------------------------------- | ---------- | -------------- |
| B1    | 1.1, 1.2                                                      | —          | 2              |
| B2    | 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12 | B1         | 12             |
| B3    | 3.1, 3.2                                                      | B2         | 2              |

- **Total tasks**: 16
- **Total batches**: 3
- **Max parallel width**: 12

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/tokenhop/tokenhop/.claude/worktrees/tokenhop-feat-yan-617/ (branch: feat/yan-617-cli-tool-config-builders)

---

## UX Design

### Before

Remote manual panel: whole-file snippets with `provider/model-id` placeholders, missing files
(Kilo VS Code settings), whole-table TOML for Grok Build, three different key placeholders.

### After

Same panel, but every snippet is generated from the builder Apply uses. Each file label says
whether to replace the file or merge the keys into it. When a required input (model) is
missing, the panel shows "Pick a model to see the configuration." instead of an invalid config.

### Interaction Changes

| Touchpoint           | Before                                              | After                                                                    |
| -------------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| Manual snippet label | `~/.x/config.json`                                  | `~/.x/config.json` + " (merge into existing)" when merged                |
| No model picked      | config with `provider/model-id`                     | "Pick a model to see the configuration."                                 |
| Key placeholder      | 3 different strings                                 | `<API_KEY_FROM_DASHBOARD>` everywhere                                    |
| Kilo                 | auth.json only                                      | auth.json + VS Code `settings.json` fragment                             |
| Grok Build           | whole-file tables, raw strings                      | engine output (`applyGrokBuildConfig`), escaped                          |
| jcode                | env path `~/.config` only; Apply lacks `[[models]]` | both emit `[[providers.<key>.models]]`; route honours `$XDG_CONFIG_HOME` |

---

## Mandatory Reading

| Priority | File                                                              | Lines   | Why                                                                  |
| -------- | ----------------------------------------------------------------- | ------- | -------------------------------------------------------------------- |
| P0       | `src/lib/cliToolBrand.js`                                         | all     | Pure brand helpers builders must use (no `9router` literals)         |
| P0       | `src/app/(dashboard)/dashboard/cli-tools/components/setupCard.js` | 142-156 | Key fallbacks being unified                                          |
| P1       | `src/lib/grokBuildConfig.js`                                      | all     | Pure text-edit engine; Grok builder wraps it                         |
| P1       | `src/lib/cliToolConfig.js`                                        | all     | Server-only readers; builders must NOT import it                     |
| P1       | `tests/helpers/cliToolsBrand.js`                                  | all     | Test harness (`load`, `loadModule`, `post`, `readJson`, `clearHome`) |
| P2       | `src/shared/components/ManualConfigModal.js`                      | all     | `{filename, content}` rendering                                      |

## External Documentation

| Topic                   | Source                                                               | Key Takeaway                                           |
| ----------------------- | -------------------------------------------------------------------- | ------------------------------------------------------ |
| jcode per-model entries | jcode README (`[[providers.<name>.models]]`, `id`, `context_window`) | The models array is real schema; Apply should write it |
| confbox                 | `node_modules/confbox` (0.3.1, ESM, no node imports)                 | `confbox/toml` is browser-safe for `stringifyTOML`     |

---

## Patterns to Mirror

### NAMING_CONVENTION

```js
// SOURCE: src/lib/cliToolBrand.js:5-9
export const CLIENT_KEY = ACTIVE.clientConfigKey;
export const CLIENT_NAME = ACTIVE.name;
```

Builders: `src/lib/cliToolConfigs/<tool>.js` exporting `build<Tool>Config(opts)`.

### ERROR_HANDLING

```js
// SOURCE: src/app/api/cli-tools/cline-settings/route.js:117-121
} catch (error) {
  const res = configErrorResponse(error);
  if (res) return res;
```

Routes keep their 400 validation and 422 `ConfigParseError` paths unchanged.

### SERVICE_PATTERN (pure, browser-safe module)

```js
// SOURCE: src/lib/grokBuildConfig.js:1,19
import { CLIENT_KEY, CLIENT_NAME } from "@/lib/cliToolBrand";
const tomlString = (value) => JSON.stringify(String(value));
```

### TEST_STRUCTURE

```js
// SOURCE: tests/unit/cli-tools-brand-json.test.js:19-29
beforeEach(() => clearHome([".factory", ".local", ".config", ".cline"]));
afterEach(restoreBrand);
const kilo = await load("tokenhop", "kilo-settings");
expect((await apply(kilo)).status).toBe(200);
```

---

## Shared contract (Task 1.1 defines it; every B2 task uses it verbatim)

`src/lib/cliToolConfigs/shared.js` (pure; imports only `@/shared/brand` and `confbox/toml`):

- `API_KEY_PLACEHOLDER = "<API_KEY_FROM_DASHBOARD>"`
- `withV1(url)` / `withoutV1(url)`: append / strip a trailing `/v1`.
- `resolveApiKey(selectedApiKey, apiKeys, cloudEnabled)`: `selected?.trim() || apiKeys?.[0]?.key || (!cloudEnabled ? ACTIVE.defaultApiKey : null)` (exact current `keyFallback` semantics; cards use it for Apply).
- `manualApiKey(selectedApiKey, apiKeys, cloudEnabled)`: `resolveApiKey(...) ?? API_KEY_PLACEHOLDER` (cards use it for snippets).
- Fragment shape: `{ file, format, merge, value }`
  - `file`: display path starting `~/` (or an absolute OS path for Copilot/Windows-style paths).
  - `format`: `"json" | "toml" | "text"` (`text` covers YAML, env, hand-edited TOML).
  - `merge`: `true` (merge these keys/lines into the existing file) or `false` (replace the whole file).
  - `value`: object for json/toml; string for text.
- `renderFragment(fragment)`: json → `JSON.stringify(value, null, 2)`; toml object → `stringifyTOML(value)`; text → value.
- `toManualConfigs(fragments)`: `null`/`undefined` → `[]`; else `[{ filename, content }]` where `filename` is `file` plus `" (merge into existing)"` when `merge` is true.

Builder contract: `build<Tool>Config(opts)` returns a fragment array, or `null` when a required
input (usually the model) is missing. The value for each file is exactly what Apply writes to that
file when it does not exist yet. Routes keep their own legacy migration and merge-into-existing
logic, but every key/value they set comes from the builder.

---

## Files to Change

| File                                                                                                                                                | Action | Justification                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------- |
| `src/lib/cliToolConfigs/shared.js`                                                                                                                  | CREATE | Fragment helpers, key resolution, placeholder                     |
| `src/lib/cliToolConfigs/{claude,codex,copilot,cline,droid,kilo,opencode,deepseekTui,hermes,jcode,grokBuild}.js`                                     | CREATE | One pure builder per tool                                         |
| `src/app/api/cli-tools/{claude,codex,copilot,cline,droid,kilo,opencode,deepseek-tui,hermes,jcode,grok-build}-settings/route.js`                     | UPDATE | Apply takes values from the builder                               |
| `src/app/(dashboard)/dashboard/cli-tools/components/{Claude,Codex,Copilot,Cline,Droid,Kilo,OpenCode,DeepSeekTui,Hermes,Jcode,GrokBuild}ToolCard.js` | UPDATE | Snippet = `toManualConfigs(builder(...))`                         |
| `src/app/(dashboard)/dashboard/cli-tools/components/{Cowork,OpenClaw,Default}ToolCard.js`                                                           | UPDATE | Switch to unified key helpers only                                |
| `src/app/(dashboard)/dashboard/cli-tools/components/setupCard.js`                                                                                   | UPDATE | Re-export unified helpers; drop `keyFallback`/`manualKeyFallback` |
| `src/app/(dashboard)/dashboard/cli-tools/components/SetupScaffold.js`                                                                               | UPDATE | Show empty-state when snippet is `[]`                             |
| `src/shared/components/ManualConfigModal.js`                                                                                                        | UPDATE | Empty-state text in `ManualConfigList`                            |
| `tests/unit/cli-tools-parity.test.js`                                                                                                               | CREATE | Parity test, both brands                                          |

## NOT Building

- Claude Cowork builder and its four files (YAN-618).
- OpenClaw allowlist / per-agent overrides builder (YAN-619).
- Manual setup dialog redesign (YAN-621), intercept/MITM tools (YAN-622), guide tools (YAN-623).
- Devin and DefaultToolCard builders (no files written / template only).
- Reading the remote user's existing files (snippets are merge fragments, not full files).
- Any new dependency.

---

## Step-by-Step Tasks

### Task 1.1: Shared builder module — Depends on [none]

- **BATCH**: B1
- **ACTION**: Create `src/lib/cliToolConfigs/shared.js` exactly per "Shared contract". Make `setupCard.js` re-export `resolveApiKey`, `manualApiKey`, `API_KEY_PLACEHOLDER`, keeping `keyFallback`/`manualKeyFallback` as-is for now (removed in 3.2).
- **IMPLEMENT**: Small pure functions; import `stringifyTOML` from `confbox/toml` (browser-safe subpath).
- **MIRROR**: SERVICE_PATTERN.
- **IMPORTS**: `ACTIVE` from `@/shared/brand`; `stringifyTOML` from `confbox/toml`.
- **GOTCHA**: No `fs`, `os`, `path`, `next/server`, `process.env` reads here. No `9router` literal (brand guard).
- **VALIDATE**: `npm run lint`; `node -e` import not needed — covered by parity test in 3.1.

### Task 1.2: Empty-state for missing required inputs — Depends on [none]

- **BATCH**: B1
- **ACTION**: `ManualConfigList` renders `<p className="text-[13px] text-muted">Pick a model to see the configuration.</p>` when `configs` is empty. `SetupScaffold` shows the inline list when `localOnly && Array.isArray(manualConfigs)` (empty array included); `null` still hides it.
- **IMPLEMENT**: Two small edits; keep the copy button logic untouched.
- **MIRROR**: existing JSX in `ManualConfigModal.js`.
- **IMPORTS**: none.
- **GOTCHA**: Cards that never return `[]` must keep passing an array; cards with no snippet pass `null`.
- **VALIDATE**: `npm run lint`.

### Task 2.1: Claude Code — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: Create `claude.js` `buildClaudeConfig({ env, exaMcpEnabled, autoCompactWindow })` returning `~/.claude/settings.json` (merge: `hasCompletedOnboarding`, `env` incl. auto-compact keys exactly as the route sets them) and, when `exaMcpEnabled`, `~/.claude.json` (merge: `mcpServers.exa`). Route POST and `ClaudeToolCard` snippet use it.
- **IMPLEMENT**: Move value construction (incl. `/v1` handling) out of the route; route keeps deep-merge and Exa removal on disable.
- **MIRROR**: the current Claude route and card.
- **IMPORTS**: shared helpers; existing Exa constants.
- **GOTCHA**: Replace the inline `<API_KEY_FROM_DASHBOARD>` logic in the card with `manualApiKey`.
- **VALIDATE**: `cd tests && npx vitest run unit/cli-tools` passes.

### Task 2.2: Codex — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: `codex.js` `buildCodexConfig({ baseUrl, apiKey, model, subagentModel })` → `~/.codex/config.toml` (toml, merge). `null` when no model. Route merges builder value into parsed TOML after `takeLegacyEntry` (legacy extras still spread into our entry).
- **IMPLEMENT**: Card drops its whole-file template.
- **MIRROR**: the current Codex route and card.
- **IMPORTS**: shared, `CLIENT_KEY`, `CLIENT_NAME`.
- **GOTCHA**: Keep `wire_api`, `Authorization` header shape identical to today's route.
- **VALIDATE**: brand migration tests for codex still pass.

### Task 2.3: Copilot — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: `copilot.js` exports `copilotConfigFile(platform)` (win32 / darwin / else XDG `~/.config/...`) and `buildCopilotConfig({ baseUrl, apiKey, models, platform })` → `chatLanguageModels.json` (json, merge: our azure-vendor entry). `null` when no models. Route passes `os.platform()`; card passes a platform guessed from `navigator.userAgent` (mac/win/linux).
- **IMPLEMENT**: Route keeps legacy migrate-in-place upsert, sourcing the entry from the builder.
- **MIRROR**: the current Copilot route and card.
- **IMPORTS**: shared.
- **GOTCHA**: Builder must not read `process.env`; route resolves real absolute path itself, builder only provides the display path for the given platform. The file is a JSON array: `value` is the array with our single entry.
- **VALIDATE**: parity test (linux path).

### Task 2.4: Cline — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: `cline.js` `buildClineConfig({ baseUrl, apiKey, model })` → `~/.cline/data/globalState.json` (merge, base without `/v1`) and `~/.cline/data/secrets.json` (merge). `null` when no model.
- **IMPLEMENT**: Route assigns builder values onto read objects.
- **MIRROR**: the current Cline route and card.
- **IMPORTS**: shared (`withoutV1`).
- **GOTCHA**: none.
- **VALIDATE**: parity test.

### Task 2.5: Droid — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: `droid.js` `buildDroidConfig({ baseUrl, apiKey, models, activeModel })` → `~/.factory/settings.json` (merge: `customModels` with our entries, active first, ids `CUSTOM_MODEL_ID_PREFIX<index>`). `null` when no models. Route removes owned ids then inserts builder entries. Route apiKey fallback `"your_api_key"` → `ACTIVE.defaultApiKey`.
- **IMPLEMENT**: Card filename stops using `navigator.platform` for this file (path is `~/.factory/settings.json` everywhere).
- **MIRROR**: the current Droid route and card.
- **IMPORTS**: shared, `CUSTOM_MODEL_ID_PREFIX`.
- **GOTCHA**: Keep index/ordering identical to today's route so brand tests pass.
- **VALIDATE**: brand-json droid tests still pass.

### Task 2.6: Kilo — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: `kilo.js` `buildKiloConfig({ baseUrl, apiKey, model })` → `~/.local/share/kilo/auth.json` (merge: `openai-compatible`) and `~/.config/Code/User/settings.json` (merge: `kilocode.customProvider`, `kilocode.defaultModel`). `null` when no model.
- **IMPLEMENT**: Card snippet now includes the VS Code fragment.
- **MIRROR**: the current Kilo route and card.
- **IMPORTS**: shared, `CLIENT_NAME`.
- **GOTCHA**: Route's VS Code write stays best-effort (skip on unparseable).
- **VALIDATE**: brand-json kilo tests still pass.

### Task 2.7: OpenCode — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: `opencode.js` `buildOpenCodeConfig({ baseUrl, apiKey, models, activeModel, subagentModel })` → `~/.config/opencode/opencode.json` (merge). Active: `activeModel === ""` → `model: ""`, else `modelRef(activeModel || models[0])`. Subagent `agent.explorer.model = modelRef(subagentModel || activeModel || models[0])` (one rule for both paths). `null` when no models.
- **IMPLEMENT**: Route keeps legacy migration, upsert of models into existing provider (previously applied models kept), `repointModelRef`; values come from the builder. Card passes the same args it POSTs.
- **MIRROR**: the current OpenCode route and card.
- **IMPORTS**: shared, `CLIENT_KEY`, `modelRef`.
- **GOTCHA**: PATCH/DELETE unchanged. Existing opencode brand tests must still pass.
- **VALIDATE**: `cli-tools-brand-opencode.test.js` passes.

### Task 2.8: DeepSeek TUI — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: `deepseekTui.js` `buildDeepSeekTuiConfig({ baseUrl, apiKey, model })` → `~/.deepseek/config.toml` (text, replace; includes `provider = "openai"`). `null` when no model. Route writes `renderFragment`.
- **IMPLEMENT**: Use `JSON.stringify` for TOML string escaping like `grokBuildConfig`.
- **MIRROR**: the current DeepSeek route and card.
- **IMPORTS**: shared.
- **GOTCHA**: GET detector still requires `provider = "openai"`.
- **VALIDATE**: parity test.

### Task 2.9: Hermes — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: `hermes.js` moves `MODEL_BLOCK_RE`/`upsertModelBlock`/`upsertEnvVar` from the route; `buildHermesConfig({ baseUrl, apiKey, model, existingYaml = "", existingEnv = "" })` → `~/.hermes/config.yaml` (text, merge) and, only when `apiKey`, `~/.hermes/.env` (text, merge). `null` when no model.
- **IMPLEMENT**: Route passes current file text and writes fragment values; card passes no existing text.
- **MIRROR**: the current Hermes route and card.
- **IMPORTS**: shared, `CLIENT_NAME`.
- **GOTCHA**: Card snippet now matches route URL normalisation (decide one: keep card's `localhost→127.0.0.1` in the card's base URL before calling the builder, same value it POSTs).
- **VALIDATE**: parity test.

### Task 2.10: jcode — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: `jcode.js` `JCODE_DEFAULT_MODEL = "cc/claude-opus-5"`; `buildJcodeConfig({ baseUrl, apiKey, model, envDir = "~/.config/jcode" })` → `~/.jcode/config.toml` (toml, merge: `providers.<CLIENT_KEY>` incl. `models: [{ id: model }]`) and `<envDir>/provider-<key>.env` (text, merge). `null` when no model in the card; route falls back to `legacy.default_model || JCODE_DEFAULT_MODEL`.
- **IMPLEMENT**: Route merges legacy extras then builder entry; env file path from `$XDG_CONFIG_HOME` (already) passed as `envDir`.
- **MIRROR**: the current jcode route and card.
- **IMPORTS**: shared, `CLIENT_KEY`, `JCODE_API_KEY_ENV`.
- **GOTCHA**: `[[providers.<key>.models]]` from a legacy entry must not be duplicated: our model replaces/unions by `id`.
- **VALIDATE**: brand-migration jcode tests still pass (update expectation only where `models` is now written).

### Task 2.11: Grok Build — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: `grokBuild.js` `buildGrokBuildConfig({ baseUrl, apiKey, model, contextWindow, subagentModels, existingToml = "" })` → `~/.grok/config.toml` (text, merge) = `applyGrokBuildConfig(existingToml, …)`. `null` when no model.
- **IMPLEMENT**: Route computes normalised context windows, then calls the builder with the current file text. Card passes its model caps' context window (no `|| 200000` invention) and no existing text.
- **MIRROR**: the current Grok Build route and card.
- **IMPORTS**: `applyGrokBuildConfig` from `@/lib/grokBuildConfig`.
- **GOTCHA**: `api_key`/`context_window` only when set (engine already does this).
- **VALIDATE**: brand-migration grok tests pass.

### Task 2.12: Other cards switch to unified key helpers — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: `CoworkToolCard.js`, `OpenClawToolCard.js`, `DefaultToolCard.js`: replace `keyFallback`/`manualKeyFallback`/inline `your-api-key` with `resolveApiKey`/`manualApiKey`/`API_KEY_PLACEHOLDER`.
- **IMPLEMENT**: Mechanical swap only.
- **MIRROR**: Shared contract.
- **IMPORTS**: from `./setupCard`.
- **GOTCHA**: No behaviour change beyond the placeholder text.
- **VALIDATE**: `npm run lint`.

### Task 3.1: Parity test — Depends on [2.1–2.11]

- **BATCH**: B3
- **ACTION**: Create `tests/unit/cli-tools-parity.test.js`. For each brand in `["", "tokenhop"]` and each tool fixture: `clearHome`, `load(brand, "<tool>-settings")`, POST the fixture body, then load the builder with `loadModule(brand, "@/lib/cliToolConfigs/<tool>.js")`, build with the same options (Copilot `platform: "linux"`), and for each fragment read `file` (with `~` → HOME) and compare: json → `toEqual(value)`, toml → `parseTOML(content)` vs `value` (object) or exact text, text → exact string.
- **IMPLEMENT**: One table of fixtures, `describe.each` brands × `it.each` tools. Also assert every fragment file exists and no builder returns `null` for a complete fixture, and returns `null` without a model.
- **MIRROR**: TEST_STRUCTURE.
- **IMPORTS**: helpers from `../helpers/cliToolsBrand.js`, `parseTOML` from `confbox`.
- **GOTCHA**: Builder must be loaded after `load()` with the same brand (`loadModule` resets modules).
- **VALIDATE**: `cd tests && npx vitest run unit/cli-tools-parity.test.js`.

### Task 3.2: Remove old key helpers — Depends on [2.1–2.12]

- **BATCH**: B3
- **ACTION**: Delete `keyFallback` and `manualKeyFallback` from `setupCard.js` once no card imports them (`grep`).
- **IMPLEMENT**: Deletion only.
- **MIRROR**: n/a.
- **IMPORTS**: n/a.
- **GOTCHA**: grep `src` for both names first.
- **VALIDATE**: `npm run lint`, `npm run build`.

---

## Testing Strategy

### Unit Tests

| Test                         | Input         | Expected Output                  | Edge Case?            |
| ---------------------------- | ------------- | -------------------------------- | --------------------- |
| parity × 11 tools × 2 brands | fixture body  | route files == builder fragments | brand keys            |
| builder without model        | `{ baseUrl }` | `null`                           | yes                   |
| existing brand/safety tests  | unchanged     | still pass                       | legacy migration, 422 |

### Edge Cases Checklist

- [x] Legacy (9router) entries still migrated under tokenhop brand (existing tests)
- [x] Unparseable config still 422 (existing safety tests)
- [x] Missing model → empty-state, not an invalid snippet
- [x] Both brands produce matching output

---

## Validation Commands

```bash
npm run lint
npm run lint:brand
npm test
npm run build
NEXT_PUBLIC_BRAND=tokenhop npm run build
```

EXPECT: all pass; `verify-no-regression` reports 0 new failures.

---

## Acceptance Criteria

- [ ] Every custom-config tool in scope (11) goes through a builder in `src/lib/cliToolConfigs/`
- [ ] Parity test covers each of them for both brands
- [ ] One key helper pair and one placeholder string
- [ ] No snippet shows `provider/model-id` for in-scope tools; missing model shows the empty-state
- [ ] Lint, brand guard, tests and both builds pass

## Completion Checklist

- [ ] Builders are pure (no fs/os/next imports)
- [ ] No new `9router` literals (brand guard)
- [ ] Existing route behaviour on existing files preserved (brand tests green)
- [ ] PR body has `Closes YAN-617` and `Closes #465`

## Risks

| Risk                                                                                        | Likelihood | Impact | Mitigation                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Route refactor changes behaviour on existing files                                          | M          | H      | Keep merge/migration code; existing brand tests are the guard                                                                               |
| `confbox/toml` in the client bundle breaks the build                                        | L          | M      | Pure ESM, no node imports; both builds run in validation                                                                                    |
| Backport to `release/0.6` conflicts heavily (no `cliToolBrand.js`, no #449/#455/#460 there) | H          | M      | `/ycc:backport` with minimal resolution; if it needs real rework, write it as its own PR against `release/0.6` (RELEASING.md "Backporting") |
| 12 parallel tasks drift on the shared contract                                              | M          | M      | Contract fixed in this plan; parity test catches mismatches                                                                                 |

## Notes

- Grok Build "field-level edits": the snippet is the engine's own output, so it uses the same
  `setSectionField` edits Apply makes. Pasted into an empty file it equals Apply; the label says
  "merge into existing".
- Markers (`# <key>-prev-default`) only appear when taking over an existing default, which the
  remote snippet cannot know; Apply still writes them.
