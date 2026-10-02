# PR Review #570 — feat(cli-tools): persist multi-model card settings and the endpoint option (YAN-639, YAN-647)

**Reviewed**: 2026-10-02
**Mode**: PR
**Author**: yandy-r
**Branch**: feat/yan-639-647-multi-model-card-settings → master
**Decision**: APPROVE (after fixes)

## Summary

Parallel review (correctness, security, quality) against the plan
(`docs/prps/plans/yan-639-647-multi-model-card-settings.plan.md`) and the #560
lessons. The six multi-model cards migrate cleanly: no stale state reads or
undefined identifiers remain (`card.selectedApiKey`, `customBaseUrl`,
`modelList`, `selectedModels`, `agentModels`/`remoteAgents` state, seeding
effects and `hasHydrated`/`hydrate` are all gone), `defaults`/`disk`/
`endpointContext` are memoized in every card, no render loops (the per-render
`savedEndpointUrl`/`asList`/`asMap` work is pure and state-free), and behaviour
parity holds where it must: Codex still fills the subagent model when empty,
OpenCode still advances the active model on removal (modal deselect and chip
remove both write `activeModel: next[0] || ""`), OpenCode/Copilot flush the DB
row (`await flushToolSettings(...)`) before the immediate file POST and keep
the remote early-returns (`isLocalOnly()` guards in `clearActiveModel`,
`removeServerModel`, modal close), and Apply/manual snippet bodies all read
persisted values.

YAN-647 checks out: `resolveSavedEndpoint` falls back to the saved URL for
legacy URL-only rows, missing options and `__custom__` (verified by running
it: disabled tunnel → saved URL, unknown id → saved URL, `local` without an
origin → saved URL); the picker's mount-once init sees the resolved URL
because every card gates `checking={... || !setup.loaded}` and SetupScaffold
only renders children when not checking; `readPresets()` and
`window.location.origin` are SSR-safe (`typeof window === "undefined"`
guards), so the pre-hydration render matches.

The validator change is safe where it matters: every host writer escapes or
type-guards what it writes (Codex via confbox `stringifyTOML`, Grok via
`tomlString = JSON.stringify`, Droid/OpenCode/Copilot/OpenClaw via
`JSON.stringify` with per-element `typeof` guards; OpenClaw `remoteAgents`
`agentDir` values never reach a host writer — the Apply route passes the
host's own `settings.agents.list`, the map only shapes the remote snippet).
One #560-F002-class gap slipped through in Codex (F001), and there are two
minor correctness nits.

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

- **[F001]** `src/app/(dashboard)/dashboard/cli-tools/components/CodexToolCard.js:86` — `const subagentModel = setup.values.subagentModel;` is the only newly persisted field read without a type guard. The API accepts any scalar, flat array or one-level nested object (`toolSettings.js` `isValidToolSettings`), and the value is remotely writable; the plan's own rule ("read them type-guarded") is applied everywhere else (`setup.model` via `str`, `models` via `asList`, `agentModels`/`subagentModels` via `asMap`, OpenCode's own `subagentModel` via a `typeof` check). A saved non-string reaches:
  - `<SingleModelRow value={subagentModel}>` → a non-string controlled-input value (React warning, `[object Object]` shown, `{value && …}` renders the clear button for any truthy object),
  - the Apply POST body and the manual snippet (`subagentModel: setup.values.subagentModel || setup.model`), so `~/.codex/config.toml` gets a semantically wrong `agents.default_subagent_model`: `stringifyTOML` (confbox) turns `{a: 1}` into a valid-TOML `[agents.default_subagent_model]` table and `42` into `default_subagent_model = 42` (verified by running confbox) — Codex expects a string model id there.
    No injection is possible (confbox escapes strings correctly, unlike the #560 Hermes YAML case), but a remote user can corrupt the semantics of the host's Codex config on the next Apply. Same class as #560 F002.
  - **Status**: Fixed
  - **Category**: Correctness / Security-adjacent
  - **Suggested fix**: Guard at the top: `const subagentModel = typeof setup.values.subagentModel === "string" ? setup.values.subagentModel : "";` and use it in `handleApply`, `getManualConfigs` and the modal `onSelect` (all already read the local `subagentModel`, so replacing line 86 suffices). Mirror of `OpenCodeToolCard.js:95-97`.

### LOW

- **[F002]** `src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js:187` — `handleLoadFromFile` clears `endpointId` only when `settings.differs.includes("endpoint")`. `diffFromDisk` compares the saved **URL string** with the file URL, so when they are equal but the saved option id now resolves elsewhere (tunnel restarted after an Apply, i.e. exactly the YAN-647 scenario), the endpoint is not in `differs`, `endpointId` survives and the resolved (new) URL keeps winning after "Load from file" — the file URL the user asked for does not take effect. Only reachable when some other key differs (otherwise the button is hidden), but then it silently defeats the click for the endpoint.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Clear the id whenever it is set and the file has a base URL: `if (settings.differs.includes("endpoint") || values.endpointId) settings.setFields({ endpointId: undefined });` (or include `endpointId` in the keys `loadFromDisk` clears).
- **[F003]** `src/lib/cliToolConfigs/toolSettings.js:40` — `diffFromDisk` compares nested maps with `JSON.stringify`, which is key-order sensitive. This PR adds two map fields whose saved and disk orders legitimately differ: Grok Build `subagentModels` (saved in user-edit order, disk rebuilt in `SUBAGENT_TYPES` order) and OpenClaw `agentModels` (saved in edit order, disk in `status.agents` order). Verified by running it: `{a:"x",b:"y"}` vs `{b:"y",a:"x"}` reports a diff. Result: a false "Saved settings differ from <file>" hint after an Apply, and `loadFromDisk` churn on keys that hold identical values. Pre-existing since #543 (Claude `models`), amplified by this PR.
  - **Status**: Fixed
  - **Category**: Correctness (UI)
  - **Suggested fix**: Compare maps order-independently in `diffFromDisk` (sort keys, or deep-compare with a small helper); or build the saved maps in the canonical order the disk uses before saving.
- **[F004]** `src/app/api/cli-tool-settings/[toolId]/route.js:52` — The updated 400 message reads "Settings must be JSON object of strings, numbers, booleans, arrays them, or one nested level them". "arrays them" / "nested level them" is broken wording; the plan asked for "…, arrays of them, or one nested level of them".
  - **Status**: Failed (false positive: the route message already reads "arrays of them, or one nested level of them")
  - **Category**: Completeness (user-facing error text)
  - **Suggested fix**: `"Settings must be a JSON object of strings, numbers, booleans, arrays of them, or one nested level of them"`.

## Notes (no change requested)

- Per-render `readPresets()` (localStorage `getItem` + `JSON.parse`) and a fresh
  `buildEndpointOptions` array in `savedEndpointUrl` for all 12 settings cards
  is deliberate per the plan ("a few pushes, so the result isn't memoized") and
  measured against card re-render frequency it is cheap. Fine to leave.
- OpenCode/Copilot chip actions (`removeServerModel`, `clearActiveModel`) write
  the store before the PATCH/DELETE without an explicit flush; the 500 ms
  debounce, the unmount flush and the `beforeunload` flush cover persistence,
  and the modal close explicitly `await flushToolSettings(...)` before
  `postModels`. The DB-first ordering on failed PATCH/DELETE (DB already holds
  the change; error shown; next Apply reconciles) is the documented plan
  trade-off.
- Picker props: `{...setup.pickerProps}` (which spreads only
  `endpointContext` + `savedUrl` + `onChange`) never conflicts with the
  explicit `key`/`value`/`currentUrl` props on any card, and Claude passes its
  picker props explicitly. Verified across all 12 cards.
- Back-compat verified by running `resolveSavedEndpoint` and by the new tests:
  URL-only rows, `__custom__`, a disabled tunnel and a preset id all resolve
  as the plan specifies.

## Validation Results

| Check      | Result                                                                                 |
| ---------- | -------------------------------------------------------------------------------------- |
| Type check | Skipped (no tsconfig)                                                                  |
| Lint       | Pass (`npm run lint`)                                                                  |
| Tests      | Pass — targeted suites 112/112; `npm test` "No regression (fails=0, baseline known=0)" |
| Build      | Pass (`npm run build`)                                                                 |

## Files Reviewed

- `src/lib/cliToolConfigs/toolSettings.js` (Modified — array validation)
- `src/app/api/cli-tool-settings/[toolId]/route.js` (Modified — 400 message)
- `src/app/(dashboard)/dashboard/cli-tools/lib/toolStatus.js` (Modified — `resolveSavedEndpoint`)
- `src/app/(dashboard)/dashboard/cli-tools/components/EndpointSegmentedPicker.js` (Modified — `meta.id`)
- `src/app/(dashboard)/dashboard/cli-tools/hooks/useSetupSettings.js` (Modified — `values`/`setFields`, `endpointContext`, `savedEndpointUrl`, `asList`/`asMap`)
- `src/app/(dashboard)/dashboard/cli-tools/components/setupCard.js` (Modified — re-exports)
- `src/app/(dashboard)/dashboard/cli-tools/components/CodexToolCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/GrokBuildToolCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/DroidToolCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/OpenClawToolCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/OpenCodeToolCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/CopilotToolCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/{Cline,Kilo,DeepSeekTui,Jcode,Hermes}ToolCard.js` (Modified — `endpointContext`)
- Writers audited for the new remote-writable shapes: `src/lib/cliToolConfigs/{codex,grokBuild,droid,opencode,copilot,openclaw,hermes}.js`, `src/lib/grokBuildConfig.js`, `src/lib/cliToolConfigs/shared.js`, `src/app/api/cli-tools/{codex,openclaw}-settings/route.js`
- `tests/unit/cli-tool-settings.test.js`, `tests/unit/cli-tools-status.test.js`, `tests/unit/cli-setup-settings.test.js` (Modified)
