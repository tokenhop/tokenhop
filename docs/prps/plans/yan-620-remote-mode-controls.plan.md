# Plan: cli-tools remote mode controls (YAN-620)

## Summary

When the dashboard is opened remotely, every `/api/cli-tools/*` route answers 403 `LOCAL_ONLY`,
so card status never loads. Seed what cards need from static data, keep remote-only edits in
local state, and make every visible control either change the manual snippet or say it is a
server setting.

## Metadata

- Complexity: Small (7 files)
- Target: v0.7.0 — PR into `master`, no backport
- Linear: YAN-620 (parent YAN-616) — GitHub: #452
- Branch: `feat/yan-620-remote-mode-controls`

## Design

| Control                  | Remote today                                     | Change                                                                   |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------ |
| Claude model mapping     | empty, snippet has no `ANTHROPIC_DEFAULT_*`      | seed from `tool.defaultModels[].defaultValue` once `localOnly` is known  |
| Claude "Append [1m]"     | models picked after the toggle lose the marker   | picker selection goes through `withContextMarker(value, oneMContext)`    |
| Claude "Add Exa MCP"     | no effect on snippet                             | snippet adds the `~/.claude.json` `mcpServers.exa` fragment Apply merges |
| Claude "Filter naming"   | works (PATCH `/api/settings`), looks like a file | "Server setting" tag next to the label                                   |
| OpenCode chip click / X  | PATCH / DELETE, 403                              | `localOnly`: local state only                                            |
| OpenCode picker close    | POST, 403 swallowed                              | `localOnly`: skip (Copilot precedent)                                    |
| Codex "Current"          | "not configured" (unknown remotely)              | render only when a URL is known, like every other card                   |
| Endpoint "Local" segment | dashboard origin labelled "Local"                | label "Dashboard" when `localOnly` (`buildEndpointOptions({ remote })`)  |
| Grok Build note          | "After Apply, run grok…"                         | wording that holds for Apply and the manual config                       |

Out of scope (own issues): Cowork plugins/Exa/marketplace (YAN-618), OpenClaw per-agent rows
(YAN-619), shared config builders and parity test (YAN-617), MITM alias remotely (YAN-622).

## Files

- `src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js`
- `src/app/(dashboard)/dashboard/cli-tools/components/OpenCodeToolCard.js`
- `src/app/(dashboard)/dashboard/cli-tools/components/CodexToolCard.js`
- `src/app/(dashboard)/dashboard/cli-tools/components/EndpointSegmentedPicker.js`
- `src/app/(dashboard)/dashboard/cli-tools/lib/toolStatus.js`
- `src/shared/constants/cliTools.js`
- `tests/unit/cli-tools-status.test.js` (remote label case)

## Validation

`npm run lint`, `npm run lint:brand`, `npm test`, `npm run build`, and
`NEXT_PUBLIC_BRAND=tokenhop npm run build`.
