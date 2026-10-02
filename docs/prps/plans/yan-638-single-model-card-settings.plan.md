# Plan: Persist single-model CLI card settings (YAN-638)

## Summary

Move the Cline, Kilo, DeepSeek TUI, jcode and Hermes cards onto the persisted
tool settings from YAN-636 (#543): model, endpoint and API key autosave per tool
(`kv` scope `cliToolSettings`) and reload on the host and remotely.

## Metadata

- **Complexity**: Medium (8 files)
- **Source**: Linear YAN-638 (parent YAN-635), GitHub #554
- **Target release**: `v1.0.0` → base/PR `master`, no backport. Complete in one
  PR, nothing half-built, so no switch.

## Worktree Setup

- **Parent**: .claude/worktrees/yan-638 (branch: feat/yan-638-single-model-card-settings)

## UX

Before: pick a model / endpoint / key, refresh → empty (remote) or last-applied
file values (host; Kilo always empty).
After: same edit survives a refresh on both; the card shows the quiet
"Saved · Reset to defaults" row and, on the host, "Saved settings differ from
<file> · Load from file" when the saved model/key differs from the file.

## Mandatory Reading

| File                                                                            | Why                                          |
| ------------------------------------------------------------------------------- | -------------------------------------------- |
| `src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js`          | Reference consumer of `useToolSettings`      |
| `src/app/(dashboard)/dashboard/cli-tools/hooks/useToolSettings.js`              | Hook contract                                |
| `src/app/(dashboard)/dashboard/cli-tools/components/setupCard.js`               | Shared panel hook the 5 cards use            |
| `src/app/(dashboard)/dashboard/cli-tools/components/EndpointSegmentedPicker.js` | `savedUrl` / `currentUrl` / `{ init: true }` |

## Patterns to Mirror

- Claude card: `defaults` / `disk` memoized; `useToolSettings(toolId, defaults, disk)`.
- API key saved as `apiKeyId` (id from `/api/keys`); typed keys stay in memory
  (`ponytail:` → YAN-642).
- Endpoint: mount `onChange(url, { init: true })` goes to local `initUrl`, user
  edits to `setField("endpoint")`; picker remounts (`key`) on reset/load.
- `checking={card.checking || !settings.loaded}`.

## Architecture

- **New `useSetupSettings({ toolId, apiKeys, defaults, disk })`** in
  `setupCard.js`: wraps `useToolSettings` and owns `initUrl`, `customKey`,
  `pickerKey`. Returns `values`, `setField`, `loaded`, `selectedApiKey`,
  `onApiKeyChange`, `endpoint`, `pickerKey`, `pickerProps`, `scaffoldProps(fileHint)`.
  One place for the shared wiring; YAN-639/641 reuse it.
- **Disk** per card: model (+ `apiKeyId` where GET returns the raw key: jcode
  `envApiKey`, DeepSeek `providers.openai.api_key`). Kilo GET returns nothing → no disk.
- **Endpoint is not merged from disk**: the file URL is normalized
  (`localhost`→`127.0.0.1`, Cline drops `/v1`), which would always "differ".
  The file URL keeps feeding `currentUrl` (preselect + "Current" row). Saved wins.
- **File-level Reset keeps saved preferences** (same as Claude; "Reset to
  defaults" clears them).
- **Defaults**: DeepSeek TUI and jcode start from `tool.defaultModels[0].defaultValue`.
  DeepSeek entries get routable `ds/…` `defaultValue`s (bare `deepseek-*`
  infers openrouter). `JCODE_DEFAULT_MODEL` derives from `CLI_TOOLS.jcode`.

### NOT Building

- Multi-model cards, Cowork, guide tools, preset move (YAN-639..642).
- Claude card refactor onto the new helper.
- Server-side changes: API already accepts all 5 ids.

## Files to Change

| File                                                                        | Change                                 |
| --------------------------------------------------------------------------- | -------------------------------------- |
| `src/app/(dashboard)/dashboard/cli-tools/components/setupCard.js`           | add `useSetupSettings`                 |
| `src/app/(dashboard)/dashboard/cli-tools/components/ClineToolCard.js`       | migrate                                |
| `src/app/(dashboard)/dashboard/cli-tools/components/KiloToolCard.js`        | migrate                                |
| `src/app/(dashboard)/dashboard/cli-tools/components/DeepSeekTuiToolCard.js` | migrate, default model                 |
| `src/app/(dashboard)/dashboard/cli-tools/components/JcodeToolCard.js`       | migrate, default model                 |
| `src/app/(dashboard)/dashboard/cli-tools/components/HermesToolCard.js`      | migrate                                |
| `src/shared/constants/cliTools.js`                                          | DeepSeek TUI `defaultValue`s           |
| `src/lib/cliToolConfigs/jcode.js`                                           | `JCODE_DEFAULT_MODEL` from `CLI_TOOLS` |

## Step-by-Step Tasks

### Task 1: shared hook + Cline (reference)

- **ACTION**: add `useSetupSettings` to `setupCard.js`; migrate `ClineToolCard.js`.
- **MIRROR**: ClaudeToolCard.js lines 102-170.
- **IMPLEMENT**: drop `selectedModel` state and the status seeding effect; model
  from `values.model`; Apply/snippet use `endpoint` + `selectedApiKey`.
- **VALIDATE**: `npm run lint`; card renders and persists in dev.

### Task 2: Kilo + Hermes (depends on 1)

- **ACTION**: same migration. Kilo: `disk = null`. Hermes: disk model `settings.model.default`.
- **VALIDATE**: lint; parity tests.

### Task 3: DeepSeek TUI + jcode + constants (depends on 1)

- **ACTION**: migrate; defaults from `tool.defaultModels[0].defaultValue`; disk
  `apiKeyId` from the raw key; DeepSeek `defaultValue`s; `JCODE_DEFAULT_MODEL` single source.
- **VALIDATE**: lint; `cli-tools-parity`, `cli-tools-brand-migration` tests.

## Testing Strategy

No new tests: storage, API, merge and store are covered by
`tests/unit/cli-tool-settings.test.js`; Apply/builder parity by
`tests/unit/cli-tools-parity.test.js`. Manual browser check on host and remote.

## Validation Commands

```bash
npm run lint
npx vitest run -c tests/vitest.config.js tests/unit/cli-tools-parity.test.js tests/unit/cli-tools-brand-migration.test.js tests/unit/cli-tool-settings.test.js
npm test
npm run build
```

## Acceptance Criteria

- [ ] Each of the 5 cards: model, endpoint, API key survive a refresh on host and remotely.
- [ ] Snippet and Apply use the persisted values.
- [ ] Kilo keeps its model on the host.
- [ ] DeepSeek TUI / jcode start from their default model.
- [ ] "Reset to defaults" restores starting values.

## Completion Checklist

- [ ] lint, tests, build green
- [ ] manual host + remote check

## Risks

- Picker init race: `savedUrl` only known after load → render picker after
  `loaded` (scaffold shows loading until then).
- jcode previously sent an empty model so the route kept the legacy model; with
  a default prefilled, Apply sends it. Users who edit keep theirs.
