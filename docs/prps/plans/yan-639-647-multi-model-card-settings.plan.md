# Plan: Persist multi-model card settings + endpoint option (YAN-639, YAN-647)

## Summary

Move the Codex, Grok Build, Droid, OpenClaw, OpenCode and Copilot cards onto the
persisted tool settings (`useSetupSettings` → `useToolSettings`, kv scope
`cliToolSettings`). Every field (models, lists, per-agent maps, OpenClaw remote
agent rows) plus endpoint and API key autosaves and reloads on the host and
remotely (YAN-639). In the same PR, the saved endpoint stores the picker
option id (`local`, `tunnel`, `tailscale`, `cloud`, `saved:<name>`,
`__custom__`) next to the URL. On load, built-in and preset ids resolve
against the current `buildEndpointOptions`, so a restarted tunnel's new URL
wins (YAN-647). This covers every card on the settings store: the 6 above,
the 5 single-model cards from #560 and Claude.

## Metadata

- **Complexity**: Medium-large (~17 files, mostly mechanical per-card moves)
- **Source**: Linear YAN-639 (GitHub #563) + YAN-647 (GitHub #564), parent YAN-635
- **Target release**: `v1.0.0` → base/PR `master`, no backport. The PR only
  changes existing cards and ships complete, so it needs no feature switch.

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/tokenhop/tokenhop-yan-639 (branch: feat/yan-639-647-multi-model-card-settings)

## UX

Before:

- Multi-model cards forget everything on refresh. Remotely they go blank; on
  the host they show the last-applied file. OpenClaw remote agent rows go
  away.
- If you pick Tunnel and the tunnel later restarts, the old URL stays.

After:

- Every field survives a refresh.
- Cards show "Saved · Reset to defaults" and, on the host, "Saved settings
  differ from <file> · Load from file".
- A saved Tunnel/Tailscale/Cloud/Local/preset choice follows that option's
  current URL.
- Copilot preselects the endpoint it already has configured.

## Mandatory Reading

| File                                                                            | Why                                                         |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `src/app/(dashboard)/dashboard/cli-tools/hooks/useSetupSettings.js:15-73`       | Hook being extended                                         |
| `src/app/(dashboard)/dashboard/cli-tools/hooks/useToolSettings.js:31-59`        | `values`, `setField`, `settings.setFields`, merge/differs   |
| `src/app/(dashboard)/dashboard/cli-tools/components/ClineToolCard.js:41-225`    | Reference migrated card (#560)                              |
| `src/app/(dashboard)/dashboard/cli-tools/components/EndpointSegmentedPicker.js` | `savedUrl` init (94-126), change handlers (153-180)         |
| `src/app/(dashboard)/dashboard/cli-tools/lib/toolStatus.js:104-156`             | `buildEndpointOptions`, `ENDPOINT_CUSTOM_VALUE`             |
| `src/lib/cliToolConfigs/toolSettings.js:56-66`                                  | `isValidToolSettings`: arrays are rejected today            |
| `src/store/toolSettingsStore.js:82-103`                                         | `setToolSettings` (shallow patch), `flushToolSettings`      |
| `docs/prps/reviews/pr-560-review.md`                                            | F001: values become remote-writable; F002: type-guard reads |

## Patterns to Mirror (from #543 / #560)

- `defaults` / `disk` are memoized. `disk` is `null` unless `status?.installed`;
  empty or missing fields are `undefined`, so they fall through.
- The endpoint is **not** taken from disk, because the normalized file URL would
  always "differ". The file URL keeps feeding the picker's `currentUrl` and the
  "Current" row.
- The API key is saved as `apiKeyId`; typed keys stay in memory (`ponytail:` →
  YAN-642). Disk `apiKeyId` = `apiKeys.find((k) => k.key === rawKey)?.id`.
- `checking={card.checking || !setup.loaded}`, `<EndpointSegmentedPicker key={setup.pickerKey} …>`,
  `{...setup.scaffoldProps(fileHint)}`.
- The file-level **Reset keeps saved preferences**. Remove the `setX("")`
  clears from each `handleReset`; "Reset to defaults" clears the saved row.
- Saved values are reachable by any signed-in remote user and are read by host
  Apply, so read them type-guarded (the API allows any scalar or one nested
  level).

## Architecture

### 1. Storage shape: allow flat arrays (`toolSettings.js`)

`isValidToolSettings` rejects arrays today (`tests/unit/cli-tool-settings.test.js:61`
asserts `{ list: ["a"] }` → 400). Droid/OpenCode/Copilot model lists need them.
Add one case: an array of at most `MAX_KEYS` scalars. Per-agent maps
and OpenClaw remote agents fit the existing "one nested object of scalars"
shape (`{ [agentId]: model }`, `{ [agentId]: agentDir }`), so no other
change. `mergeToolSettings` already replaces arrays whole (`isPlain` is false
for arrays), and `diffFromDisk` compares with `JSON.stringify`. Both are fine.

```js
// toolSettings.js, isValidToolSettings
return Object.values(value).every(
  (v) =>
    isScalar(v) ||
    (Array.isArray(v) && v.length <= MAX_KEYS && v.every(isScalar)) ||
    (isPlain(v) && validKeys(v) && Object.values(v).every(isScalar)),
);
```

Update the JSDoc and the 400 message in `src/app/api/cli-tool-settings/[toolId]/route.js:52`
("…, arrays of them, or one nested level of them"). In the test, replace
`{ list: ["a"] }` with `{ list: [["a"]] }` and `{ list: [{ a: 1 }] }`, and add
`{ list: ["a"] }` to the round-trip.

### 2. Endpoint option id (YAN-647)

**Picker** (`EndpointSegmentedPicker.js:153-180`): user changes report the
option id as `meta.id`. Init (`{ init: true }`) is unchanged.

```js
// handleSegmentChange
if (nextValue === ENDPOINT_CUSTOM_VALUE) { …; onChange?.("", { id: ENDPOINT_CUSTOM_VALUE }); return; }
…; if (found.url) onChange?.(found.url, { id: nextValue });
// handleSavedChange
if (found?.url) onChange?.(found.url, { id: next });
// handleCustomChange
onChange?.(next, { id: ENDPOINT_CUSTOM_VALUE });
```

**Pure resolver** (`lib/toolStatus.js`, next to `buildEndpointOptions`, tested
in `tests/unit/cli-tools-status.test.js`):

```js
/**
 * URL for a saved endpoint: a built-in or preset id follows that option's current URL;
 * Custom, a legacy row (URL only) or an option that's gone keeps the saved URL.
 */
export function resolveSavedEndpoint({ endpoint = "", endpointId = "" } = {}, ctx = {}) {
  if (!endpointId) return endpoint;
  return buildEndpointOptions(ctx).find((o) => o.value === endpointId)?.url || endpoint;
}
```

`__custom__` has `url: ""`, so it falls through to `endpoint` with no special
case. Old rows without `endpointId` behave exactly as today (back-compat).

**Hook** (`useSetupSettings.js`) takes the endpoint context the picker
already gets and resolves it where the card can read it. `setup.endpoint`
(used by Apply and the snippet) and the picker's `savedUrl` are then both the
resolved URL. The picker's existing init matches that URL to the option, so
the picker needs no `savedId` prop and no init change. The picker is spread
from `pickerProps`, so cards drop the duplicated tunnel/tailscale/cloud props.

```js
import { readPresets } from "../components/cliEndpointPresets";
import { resolveSavedEndpoint } from "../lib/toolStatus";

/** Saved endpoint resolved against the live options (also used by the Claude card). */
export const savedEndpointUrl = (values, endpointContext) =>
  resolveSavedEndpoint(
    { endpoint: str(values.endpoint), endpointId: str(values.endpointId) },
    {
      ...endpointContext,
      localOrigin: typeof window === "undefined" ? "" : window.location.origin,
      savedPresets: readPresets(),
    },
  );

export function useSetupSettings({ toolId, apiKeys = [], defaults, disk = null, endpointContext = {} }) {
  const [values, setField, settings] = useToolSettings(toolId, defaults, disk);
  …
  const onEndpointChange = (url, meta) => {
    if (meta?.init) setInitUrl(url);
    else settings.setFields({ endpoint: url, endpointId: meta?.id });
  };
  const savedEndpoint = savedEndpointUrl(values, endpointContext);
  return {
    values,                      // YAN-639: extra fields (lists, maps)
    setField,
    setFields: settings.setFields,
    model: str(values.model),
    setModel: (v) => setField("model", v),
    loaded: settings.loaded,
    selectedApiKey,
    onApiKeyChange,
    endpoint: savedEndpoint || initUrl,
    pickerKey,
    pickerProps: { ...endpointContext, savedUrl: savedEndpoint, onChange: onEndpointChange },
    scaffoldProps,               // unchanged
  };
}
```

Move `str` to module scope. Delete the endpoint `ponytail:` comment
(`useSetupSettings.js:35-36`). Cards pass:

```js
endpointContext: { tunnelEnabled, tunnelPublicUrl, tailscaleEnabled, tailscaleUrl,
                   cloudEnabled, cloudUrl, requiresExternalUrl: tool.requiresExternalUrl }
```

`window`/`readPresets()` run during render. `buildEndpointOptions` is a few
pushes, so the result isn't memoized. On SSR the card still shows the loading
skeleton (`!setup.loaded`), so no endpoint renders before hydration.
`useToolSetupData` loads the tunnel/tailscale URLs before `ToolSetupPanel`
mounts a card (`ToolSetupPanel.js:31`), so the first resolve already sees
them.

**Type guards** for extra fields, exported from `useSetupSettings.js` (2 lines,
used by 6 cards):

```js
export const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : []);
export const asMap = (v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string"))
    : {};
```

Re-export `asList`/`asMap` from `setupCard.js` next to `useSetupSettings`.

**Claude** (`ClaudeToolCard.js`) keeps its own copy (it has a
`diskToken` key fallback the hook lacks). It changes in three places:

- `handleEndpointChange` (150-153) saves `setFields({ endpoint: url, endpointId: meta?.id })`.
- `const savedEndpoint = savedEndpointUrl(values, { tunnelEnabled, … })` replaces
  `values.endpoint` at 206, 319 and 320.
- `handleLoadFromFile` (162): when `settings.differs.includes("endpoint")`,
  also clear `endpointId` (`setFields({ endpointId: undefined })`). Otherwise
  the id would keep winning over the file URL.

### 3. Per-card field mapping (YAN-639)

All six: `defaults` include `endpoint: ""`, `apiKeyId: ""`. Remove
`card.selectedApiKey` / `card.setSelectedApiKey` / `card.customBaseUrl` uses.
`ApiKeySelect` gets `value={setup.selectedApiKey} onChange={setup.onApiKeyChange}`.
Delete the "first key" effect (the hook falls back to the first key) and the
status-seeding effect/refs.

| Card                              | Saved keys (defaults)                                                     | Disk (host, `status?.installed`)                                                                                                                                                                                                                                                | Today's seeding / state to delete                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Codex `CodexToolCard.js`          | `model: ""`, `subagentModel: ""`                                          | `model`: `/^model\s*=\s*"([^"]+)"/m` over `status.config`; `subagentModel`: `/^default_subagent_model\s*=\s*"([^"]+)"/m`. No `apiKeyId` (key lives in an `http_headers` string; not seeded today).                                                                              | state 46-47, key effect 50-52, seed 54-61, reset clears 108-109                                                        |
| Grok Build `GrokBuildToolCard.js` | `model: ""`, `subagentModels: {}` (`{ [typeId]: model }`)                 | `model: status.settings?.model?.model`, `subagentModels: subagentsFromStatus(status)` (35), `apiKeyId` from `status.settings?.model?.api_key`                                                                                                                                   | state 63-64, `hasHydrated` 66, `hydrate` 68-72 + call at 128 (keep `card.setStatus(fresh)`), seed 74-80, reset 147-148 |
| Droid `DroidToolCard.js`          | `models: []`                                                              | `models`: the sort/legacy logic at 59-70 moved into `disk` (`undefined` when empty); `apiKeyId` from the first `isCustomModelId` entry's `apiKey`                                                                                                                               | state 48 (keep `modelInput` 49 as a draft), key effect 52-54, seed 56-72, reset 128                                    |
| OpenClaw `OpenClawToolCard.js`    | `model: ""`, `agentModels: {}`, `remoteAgents: {}` (`{ [id]: agentDir }`) | when `findClientEntry(status.settings?.models?.providers)`: `model: splitModelRef(primary)?.model ?? primary`, `apiKeyId` from `provider.apiKey` (today 71-73). `agentModels` from `status.agents[].currentModel` (76-79). No disk for `remoteAgents` (remote-only).            | state 51-52, 56 (keep `agentDraft` 57, `agentModalFor` 53), key effect 60-62, seed 64-81, reset 130-132                |
| OpenCode `OpenCodeToolCard.js`    | `models: []`, `activeModel: ""`, `subagentModel: ""`                      | `models: status.opencode?.models` (undefined when empty), `activeModel: status.opencode?.activeModel \|\| undefined`, `subagentModel: splitModelRef(status.config?.agent?.explorer?.model)?.model`, `apiKeyId` from `findClientEntry(status.config?.provider)?.options?.apiKey` | state 48-50, key effect 58-60, seed 62-67, reset 175-177                                                               |
| Copilot `CopilotToolCard.js`      | `models: []`                                                              | our entry (`CLIENT_NAME`, then `isClientKey`) when `Array.isArray(status?.config)`: `models: entry.models.map((m) => m.id)` (undefined when empty), `apiKeyId` from `entry.apiKey`                                                                                              | state 48, key effect 55-57, seed 59-66, reset 124                                                                      |

Per-card notes:

- **Codex**: main pick (212-215) keeps "fill subagent if empty":
  `setup.setFields({ model: m.value, ...(subagentModel ? {} : { subagentModel: m.value }) })`.
- **Grok Build**: subagent edits use
  `setup.setField("subagentModels", { ...subagentModels, [t.id]: val })`, with
  `subagentModels = asMap(setup.values.subagentModels)`. `mapSubagents` (95)
  is unchanged.
- **Droid**: `models = asList(setup.values.models)`.
  `addModel` → `setup.setField("models", [...models, val])`, and the same in the
  modal `onSelect` (252). `removeModel` → filter.
- **OpenClaw**: `remoteAgents = asMap(setup.values.remoteAgents)`.
  `agents = localOnly ? Object.entries(remoteAgents).map(([id, agentDir]) => ({ id, agentDir })) : …` (146).
  `addRemoteAgent` → `setup.setField("remoteAgents", { ...remoteAgents, [id]: agentDir })`.
  `removeRemoteAgent` → one `setup.setFields({ remoteAgents: rest, agentModels: restModels })`.
- **OpenCode**:
  - Read `models = asList(…)`, `activeModel`/`subagentModel = str(...)`. Keep
    `selectedModelsRef` (52-56), fed from `models`.
  - Modal `onSelect` (348):
    `setup.setFields({ models: [...models, m.value], ...(activeModel ? {} : { activeModel: m.value }) })`.
    `onDeselect` (357) works the same way.
  - Modal `onClose` (344-346): call `flushToolSettings("opencode")` **before**
    `if (!isLocalOnly()) postModels(...)`. The DB write goes out first. Remotely
    it's the only store, and the store's `beforeunload` flush also covers this.
  - `clearActiveModel` (95) and `removeServerModel` (120): run the DB update
    (`setField("activeModel", "")` / `dropModel`) **before** the PATCH/DELETE,
    not after a successful response. Remotely they return early as today.
  - Chip click `setActiveModel(m)` (280, 285) → `setField("activeModel", m)`.
- **Copilot**: same flush-then-POST on modal close (235-237). The chip remove
  (208) and modal `onSelect`/`onDeselect` (239-244) go to `setField("models", …)`.
  **Pass `currentUrl`** to the picker:
  `status?.currentUrl?.replace(/\/chat\/completions.*$/, "") || ""`. The GET
  returns `${baseUrl}/chat/completions#models.ai.azure.com`
  (`api/cli-tools/copilot-settings/route.js:71`, builder `copilot.js:16`).
  Without the strip the URL matches no option.
- `flushToolSettings` is imported from `@/store/toolSettingsStore` in those two
  cards. No hook API is added for one caller pair.

### NOT Building

- Cowork / guide tools / preset move to the DB (YAN-641/642).
- Persisting typed (non-`/api/keys`) API keys (YAN-642).
- Picker re-init when the saved value changes after mount (pr-560 F005). It
  isn't needed: the picker renders after `loaded`, and the resolved URL is
  known at mount.
- Server route changes beyond the validator and its message.
- A React test harness for the cards (manual check instead).

## Files to Change

| File                                                                            | Change                                                                                   |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/lib/cliToolConfigs/toolSettings.js`                                        | allow flat scalar arrays                                                                 |
| `src/app/api/cli-tool-settings/[toolId]/route.js`                               | 400 message wording                                                                      |
| `tests/unit/cli-tool-settings.test.js`                                          | array accept/reject cases                                                                |
| `src/app/(dashboard)/dashboard/cli-tools/lib/toolStatus.js`                     | `resolveSavedEndpoint`                                                                   |
| `tests/unit/cli-tools-status.test.js`                                           | resolver cases                                                                           |
| `src/app/(dashboard)/dashboard/cli-tools/components/EndpointSegmentedPicker.js` | `meta.id` on user change; JSDoc                                                          |
| `src/app/(dashboard)/dashboard/cli-tools/hooks/useSetupSettings.js`             | `values`/`setField`/`setFields`, `endpointContext`, `savedEndpointUrl`, `asList`/`asMap` |
| `src/app/(dashboard)/dashboard/cli-tools/components/setupCard.js`               | re-export `asList`, `asMap`                                                              |
| `tests/unit/cli-setup-settings.test.js`                                         | endpoint id saved; mock `setFields`                                                      |
| `…/components/{Codex,GrokBuild,Droid,OpenClaw,OpenCode,Copilot}ToolCard.js`     | migrate (YAN-639)                                                                        |
| `…/components/{Cline,Kilo,DeepSeekTui,Jcode,Hermes}ToolCard.js`                 | pass `endpointContext`, drop duplicated picker props                                     |
| `…/components/ClaudeToolCard.js`                                                | endpoint id save/resolve, load-from-file clears id                                       |

## Step-by-Step Tasks

### Batch 1: shared primitives (3 parallel tasks, separate files)

**Task 1.1: array settings**

- **ACTION**: `toolSettings.js` validator + JSDoc; route message; `cli-tool-settings.test.js:55-70`.
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/cli-tool-settings.test.js`

**Task 1.2: resolver**

- **ACTION**: add `resolveSavedEndpoint` to `toolStatus.js`. Test in `cli-tools-status.test.js`
  `describe("buildEndpointOptions")`:
  - (a) `tunnel` id + new `tunnelPublicUrl` → new URL + `/v1`
  - (b) legacy `{ endpoint }` only → URL
  - (c) `__custom__` → URL
  - (d) `tunnel` id with tunnel disabled → saved URL
  - (e) `saved:x` with `savedPresets` → preset URL
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/cli-tools-status.test.js`

**Task 1.3: picker id**

- **ACTION**: `EndpointSegmentedPicker.js` handlers 153-180 pass `{ id }`; update the `onChange` JSDoc (21).
- **VALIDATE**: `npm run lint`

### Batch 2: hook (depends on 1.2, 1.3)

**Task 2.1**

- **ACTION**: extend `useSetupSettings.js` per Architecture §2. Re-export
  `asList`/`asMap` in `setupCard.js`. Update `cli-setup-settings.test.js`:
  - add `setFields` to the mocked settings
  - line 70-71 now expects `setFields({ endpoint: "https://custom/v1", endpointId: "__custom__" })`
    when called with `{ id: "__custom__" }`
  - add one case: saved `{ endpoint: "https://old/v1", endpointId: "tunnel" }`
    with `endpointContext: { tunnelEnabled: true, tunnelPublicUrl: "https://new" }`
    → `render().endpoint === "https://new/v1"`. The node env has no
    `window`, so `localOrigin` is "".
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/cli-setup-settings.test.js`

### Batch 3: cards (depends on 2.1; one task per file, all parallel)

| Task | File                                             | Notes                                                                         |
| ---- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| 3.1  | `CodexToolCard.js`                               | table row + Codex note                                                        |
| 3.2  | `GrokBuildToolCard.js`                           | drop `hydrate`, keep `card.setStatus(fresh)`                                  |
| 3.3  | `DroidToolCard.js`                               | `modelInput` stays local                                                      |
| 3.4  | `OpenClawToolCard.js`                            | `remoteAgents` map; `agentDraft` stays local                                  |
| 3.5  | `OpenCodeToolCard.js`                            | DB-first ordering, flush before POST                                          |
| 3.6  | `CopilotToolCard.js`                             | flush before POST; `currentUrl`                                               |
| 3.7  | `ClaudeToolCard.js`                              | §2 Claude                                                                     |
| 3.8  | `Cline/Kilo/DeepSeekTui/Jcode/HermesToolCard.js` | `endpointContext` into `useSetupSettings`; remove the now-spread picker props |

Each task follows **MIRROR** `ClineToolCard.js:41-53, 166-178` and
**VALIDATE**s with `npm run lint` plus the card rendering and persisting in
`PORT=20128 npm run dev`.

### Batch 4: full validation (depends on 3.x)

Run the validation commands below and the manual test plan.

## Testing Strategy

- Unit (cheap and security-relevant only):
  - array shape accept/reject (`cli-tool-settings.test.js`)
  - endpoint id resolution incl. legacy rows (`cli-tools-status.test.js`)
  - hook saves the id and resolves the endpoint (`cli-setup-settings.test.js`)
- Apply/builder parity is unchanged and covered by `tests/unit/cli-tools-parity.test.js`
  (the card bodies keep the same shapes).
- OpenClaw remote-row persistence and per-card reloads are checked by hand.
  A card-level React test would need a new harness.

## Validation Commands

```bash
npm run lint
npx vitest run -c tests/vitest.config.js tests/unit/cli-tool-settings.test.js tests/unit/cli-tools-status.test.js tests/unit/cli-setup-settings.test.js tests/unit/cli-tools-parity.test.js tests/unit/cli-tools-brand-migration.test.js
npm test
npm run build
```

## Manual Test Plan

Run `PORT=20128 npm run dev`. "Remote" means the dashboard opened signed in
through the tunnel or Tailscale URL, where `localOnly` is true.

1. For each of Codex, Grok Build, Droid, OpenClaw, OpenCode and Copilot, on
   both the host and remote:
   1. Change every field (models, subagent/agent models, endpoint, API key).
   2. Wait for "Saved", then refresh. Every value must come back.
   3. Open Manual config. The snippet must match the fields.
   4. On the host only, click Apply, then check the file.
2. OpenClaw, remote:
   1. Add 2 agent rows and give one a model, then refresh. Both rows and the
      model must remain.
   2. Remove a row, then refresh. It stays gone.
3. OpenCode and Copilot, host: add models in the modal, close it, then refresh
   at once. The DB and the file both hold the list. Remote: same steps, and the
   list persists with no 403 in the console.
4. OpenCode, host: clear the active chip, then remove a chip, then refresh.
   Neither change comes back.
5. Copilot, host, with an existing config: the picker preselects the
   configured endpoint.
6. YAN-647 (repeat steps 2 and 3 on Claude and on one single-model card):
   1. Pick Tunnel on Codex.
   2. Restart the tunnel so it gets a new URL, then reload.
   3. The picker shows Tunnel, and the snippet and Apply use the new URL.
7. Back-compat: put a legacy row (`{ endpoint: "https://x/v1" }`, no
   `endpointId`) in place via `PUT /api/cli-tool-settings/codex`. The card
   shows Custom (or the matching option) with that URL.
8. On the Claude card with a saved Tunnel endpoint, edit
   `~/.claude/settings.json`'s base URL, then click "Load from file". The card
   uses the file URL.
9. "Reset to defaults" clears every saved field. The file-level Reset keeps
   them.

## Acceptance Criteria

- [ ] On each of the 6 cards, host and remote, every field survives a refresh.
- [ ] Snippet and Apply read the persisted values, and the parity tests pass.
- [ ] OpenClaw remote agent rows survive a refresh.
- [ ] On OpenCode and Copilot, the host still writes the file immediately and
      the DB is written first. Remotely the DB is the only store.
- [ ] Copilot picker receives `currentUrl`.
- [ ] A saved built-in or preset endpoint follows that option's current URL on
      all 12 settings-backed cards. Legacy URL-only rows still work.

## Risks

- **Remote-writable values reach host Apply** (pr-560 F001). The new fields
  reach these writers:
  - Codex via `stringifyTOML`
  - Grok via `tomlString` (JSON-quoted)
  - Droid, OpenCode, Copilot and OpenClaw via JSON

  None interpolates raw text. OpenClaw `agentModels` keys only take effect for
  ids already in the host's `agents.list`. `remoteAgents` (`agentDir`) is only
  used for the remote manual snippet, never on the host. Keep the `asList`/`asMap`
  guards.

- **Local means "this dashboard"**. `local` saved on the host resolves to the
  remote dashboard origin when viewed remotely. That's the right URL for the
  remote snippet. Apply is host-only.
- **Option gone** (tunnel off): the card falls back to the last saved URL and
  the picker shows Custom. The behavior is explicit, not silent.
- **Nested merge**: `agentModels` and `subagentModels` merge one level with
  disk, so a key deleted from saved can reappear from disk. Clearing writes
  `""`, which wins. Remote removal has no disk.
- **OpenCode DB-first**: if the PATCH/DELETE fails, the DB already holds the
  change and the error message shows. The next Apply reconciles the file.
- **Multi-select modal**: `onSelect` reads `models` from render. The modal
  re-renders between clicks, so there's no lost update in practice. Use one
  `setFields` per event, not two setters.
- **Map order**: `remoteAgents` keys that look like integers sort first in JS
  objects. This only affects display order.
