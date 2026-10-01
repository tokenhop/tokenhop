# Plan: Cowork and OpenClaw manual setup parity (YAN-618, YAN-619)

## Summary

Move Claude Cowork and OpenClaw onto the shared config builders from #477 so the manual
snippet remote users copy is what Apply writes. Cowork gets all four files, OS-aware paths,
seeded plugins and a remotely usable marketplace. OpenClaw gets the allowlist, per-agent
overrides and per-agent `models.json`, plus agent rows that can be added remotely.

## User Story

As a user opening the dashboard remotely, I want the Cowork and OpenClaw manual setup to
contain everything Apply would write, so that pasting it gives the same behaviour.

## Problem → Solution

- Cowork snippet: 1 macOS-only file with 4 keys → 4 fragments (`claude_desktop_config.json`
  `deploymentMode: "3p"`, `_meta.json`, `<appliedId>.json` with the security profile and
  `managedMcpServers`, `config.json` `operonSkipMcpApprovals`) for macOS / Linux / Windows.
- Cowork remote: Exa can't be ticked, MCP list empty, "+ Browse" 403 → plugins seeded from
  `DEFAULT_PLUGINS`, the read-only registry GET is reachable with normal dashboard auth, the
  tool probe stays local-only and the modal falls back to the registry tool names.
- OpenClaw snippet: primary + one model → primary, allowlist, `agents.list[].model`, all
  models in the provider, one `<agentDir>/models.json` per agent. Remotely the user adds
  agent rows (id + agent dir).

## Metadata

- Complexity: Medium (9 files)
- Target: `v1.0.0` — PR into `master`, no backport (builds on v1.0.0-only builders, #477)
- Linear: YAN-618, YAN-619 (parent YAN-616) — GitHub: #481, #482
- Branch: `feat/yan-618-619-cowork-openclaw-manual-parity`

## Worktree Setup

- **Parent**: <repo-root>/.config/opencode/worktrees/tokenhop-yan-618-619/ (branch: feat/yan-618-619-cowork-openclaw-manual-parity)

## UX Design

### Before

Remote Cowork: empty MCP list, dead Exa checkbox, "+ Browse" error, one macOS file.
Remote OpenClaw: no per-agent section, snippet without allowlist.

### After

Remote Cowork: Exa/Tavily listed and toggleable, Browse lists the registry (tools from the
registry), four snippets with "(merge into existing)" / "(create if missing)" hints for the
browser's OS. Remote OpenClaw: "Per-agent models" section with an "Add agent" row (id +
agent dir); snippet includes every file Apply writes.

### Interaction Changes

Fragments may carry a `note` that replaces the default filename suffix in the manual list.

## Mandatory Reading

- `src/lib/cliToolConfigs/shared.js`, `src/lib/cliToolConfigs/copilot.js` (platform paths)
- `src/app/api/cli-tools/cowork-settings/route.js`, `src/shared/constants/coworkPlugins.js`
- `src/app/api/cli-tools/openclaw-settings/route.js`, `src/lib/cliToolBrand.js`
- `src/app/(dashboard)/dashboard/cli-tools/components/CoworkToolCard.js`, `OpenClawToolCard.js`
- `src/dashboardGuard.js`, `src/shared/components/McpMarketplaceModal.js`
- `tests/unit/cli-tools-parity.test.js`, `tests/unit/dashboard-guard.test.js`

## Patterns to Mirror

### SERVICE_PATTERN

Pure builder returning `[{ file, format, merge, value }]`, `null` when a required input is
missing; route calls it and writes `value`; card renders `toManualConfigs(build(...))`.

```js
export const buildKiloConfig = ({ baseUrl, apiKey, model }) => {
  if (!model) return null;
  return [{ file: "~/.local/share/kilo/auth.json", format: "json", merge: true, value }];
};
```

### NAMING_CONVENTION

`build<Tool>Config`, `<tool>ConfigFile(platform)` for OS display paths (`copilotConfigFile`).

### TEST_STRUCTURE

`describe.each(["", "tokenhop"])` brand loop, temp `HOME`, `load(brand, route)`,
`loadModule(brand, "@/lib/cliToolConfigs/<x>.js")`, compare parsed files to fragment values.

## Files to Change

| File                                                                     | Action                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `src/lib/cliToolConfigs/shared.js`                                       | `note` in `toManualConfigs`; `browserPlatform()` moved here |
| `src/lib/cliToolConfigs/cowork.js`                                       | CREATE builder, paths, MCP server list                      |
| `src/lib/cliToolConfigs/openclaw.js`                                     | CREATE builder                                              |
| `src/app/api/cli-tools/cowork-settings/route.js`                         | use builder                                                 |
| `src/app/api/cli-tools/openclaw-settings/route.js`                       | use builder                                                 |
| `src/app/(dashboard)/dashboard/cli-tools/components/CoworkToolCard.js`   | builder snippet, seeded plugins/Exa                         |
| `src/app/(dashboard)/dashboard/cli-tools/components/OpenClawToolCard.js` | builder snippet, remote agent rows                          |
| `src/app/(dashboard)/dashboard/cli-tools/components/CopilotToolCard.js`  | import shared `browserPlatform`                             |
| `src/dashboardGuard.js`                                                  | registry GET exempt from local-only gate                    |
| `src/shared/components/McpMarketplaceModal.js`                           | local-only probe → registry tool names, no error            |
| `tests/unit/cli-tools-parity.test.js`                                    | Cowork + OpenClaw (primary, allowlist, two agents)          |
| `tests/unit/dashboard-guard.test.js`                                     | registry GET remote-allowed, tools POST still 403           |

## NOT Building

- Remote tool probe (`cowork-mcp-tools`): stays local-only; it fetches user URLs (SSRF).
- Local stdio bridge entries in the snippet: they need the host and its CLI token.
- Removal of legacy 1p `mcpServers` in the snippet: only matters for old local installs.
- Brand renames of Cowork's `gateway` provider id (YAN-332 owns renames).

## Step-by-Step Tasks

### Task 1: Shared helpers

- **ACTION**: In `shared.js` add optional `note` to fragments (`toManualConfigs` uses
  `${file} (${note})` when set) and move `browserPlatform()` from `CopilotToolCard.js`.
- **MIRROR**: existing `toManualConfigs`.
- **VALIDATE**: `npm run lint`; Copilot card still imports it.

### Task 2: Cowork builder + route + card

- **ACTION**: `cowork.js` exports `coworkRoots(platform)`, `coworkMeta(id)`,
  `buildCoworkMcpServers({ plugins, localServers, customPlugins })`,
  `buildCoworkConfig({ baseUrl, apiKey, models, managedMcpServers, appliedId, platform })`.
  Route builds servers through it, injects CLI-token headers, writes each fragment (meta only
  when missing, via `coworkMeta`). Card seeds `plugins` from `DEFAULT_PLUGINS`, takes Exa from
  the constant, generates a stable `appliedId` when status has none.
- **IMPLEMENT**: `SECURITY_RELAX` and `PROVIDER` move into the builder.
- **VALIDATE**: parity test.

### Task 3: OpenClaw builder + route + card

- **ACTION**: `openclaw.js` exports `buildOpenClawConfig({ baseUrl, apiKey, model, agents,
agentModels })`. Route keeps its migration logic (owned refs, legacy entries, fallbacks)
  and takes primary, allowlist, provider fields, list models and per-agent files from the
  builder. Card: agents = status agents, or user-added rows when remote.
- **VALIDATE**: parity test with two agents.

### Task 4: Remote marketplace

- **ACTION**: Guard lets `GET /api/cli-tools/cowork-mcp-registry` skip the local-only gate
  (normal `/api/*` auth still applies). Modal treats a local-only probe as "no probe".
- **VALIDATE**: guard test.

### Task 5: Tests

- **ACTION**: Extend parity test and guard test as listed above.
- **VALIDATE**: `npx vitest run tests/unit/cli-tools-parity.test.js tests/unit/dashboard-guard.test.js`.

## Testing Strategy

### Unit Tests

Parity for Cowork (4 files, Exa + custom MCP) and OpenClaw (primary, allowlist, 2 agents
with `agentDir`, one override). Guard: remote authenticated registry GET passes; probe POST
stays 403 `LOCAL_ONLY`.

### Edge Cases Checklist

- [ ] No models → builders return `null` ("pick a model" state)
- [ ] Plugins toggled all off → no `managedMcpServers`, empty skip map
- [ ] Windows display paths use `%LOCALAPPDATA%` / `%APPDATA%`
- [ ] Both brands (`""`, `tokenhop`)

## Validation Commands

```bash
npm run lint
npm run lint:brand
npx vitest run tests/unit/cli-tools-parity.test.js tests/unit/dashboard-guard.test.js tests/unit/cli-tools-brand-json.test.js
npm test
npm run build
NEXT_PUBLIC_BRAND=tokenhop npm run build
```

## Acceptance Criteria

- [ ] Cowork snippet lists all four files with OS-aware paths and merge hints
- [ ] Exa toggle and MCP list work remotely; Browse lists the registry remotely
- [ ] OpenClaw snippet has allowlist, per-agent list entries and per-agent `models.json`
- [ ] Remote OpenClaw users can add agent rows
- [ ] Parity test covers both tools; lint, tests, both builds pass

## Risks

- Exempting the registry route widens remote surface: GET only, fixed upstream URL, no fs or
  secrets, still behind dashboard auth.
- OpenClaw `agents.list` is an array; the snippet marks it "merge by id".
