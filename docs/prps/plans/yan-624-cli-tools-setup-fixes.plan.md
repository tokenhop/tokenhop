# Plan: cli-tools setup fixes (YAN-624..628)

## Summary

Five small v0.6.x cli-tools bugs (GH #440–#444), one PR into `master`, then backported with `backport:0.6`.
`release/0.6` and `master` are byte-identical in all touched paths, so the cherry-pick is clean.

## User Story

As a dashboard user setting up CLI tools, I want the manual snippets, remote steps, card state and
Reset to match what Apply really does, so that my tool configs work and don't silently change.

## Metadata

- Complexity: Small (6 files)
- Target: v0.6.x patch — PR into `master`, label `backport:0.6`
- Linear: YAN-624, YAN-625, YAN-626, YAN-627, YAN-628 — GitHub: #440–#444

## Worktree Setup

- **Parent**: .claude/worktrees/tokenhop-yan-624-cli-tools/ (branch: fix/yan-624-cli-tools-setup-fixes)

## UX Design

- DeepSeek TUI manual snippet starts with `provider = "openai"` and a comment that it replaces the whole file.
- Remote "Intercept tools" lists only Antigravity and Kiro (the `MITM_TOOLS` with hosts), not Cursor/Copilot.
- Grok Build card shows the saved main model and subagent overrides after reload.
- Claude Code Reset also removes `ANTHROPIC_DEFAULT_FABLE_MODEL`.
- jcode card preselects the saved API key.

## Mandatory Reading

- `src/app/(dashboard)/dashboard/cli-tools/components/DeepSeekTuiToolCard.js` — `getManualConfigs`
- `src/app/api/cli-tools/deepseek-tui-settings/route.js` — `build9RouterConfig` (source of truth)
- `src/app/(dashboard)/dashboard/cli-tools/components/InterceptTools.js` — `RemoteInterceptSteps`
- `src/shared/constants/cliTools.js` — `MITM_TOOLS`, `CLI_TOOLS.claude.defaultModels`
- `src/app/(dashboard)/dashboard/cli-tools/components/GrokBuildToolCard.js` — `hydrate`
- `src/app/api/cli-tools/claude-settings/route.js` — `RESET_ENV_KEYS`
- `src/app/api/cli-tools/jcode-settings/route.js` — GET, `readProviderEnv`
- `tests/unit/cli-tools-config-safety.test.js` — route test pattern (HOME is a temp dir)

## Patterns to Mirror

- One-shot hydrate on first status load (DeepSeekTuiToolCard.js):

  ```js
  useEffect(() => {
    if (status?.installed && !hasInitializedModel.current) {
      hasInitializedModel.current = true;
  ```

- Route tests call the exported handler directly: `claude.POST(req({...}))`, `claude.DELETE()`.
- Brand guard ratchet: no new `9router` literals in touched files (`npm run lint:brand`).

## Files to Change

| File                                                                        | Change                                 |
| --------------------------------------------------------------------------- | -------------------------------------- |
| `src/app/(dashboard)/dashboard/cli-tools/components/DeepSeekTuiToolCard.js` | Snippet = Apply output                 |
| `src/app/(dashboard)/dashboard/cli-tools/components/InterceptTools.js`      | Iterate `MITM_TOOLS`                   |
| `src/app/(dashboard)/dashboard/cli-tools/components/GrokBuildToolCard.js`   | Hydrate once from status               |
| `src/app/api/cli-tools/claude-settings/route.js`                            | Derive reset keys from `defaultModels` |
| `src/app/api/cli-tools/jcode-settings/route.js`                             | GET returns `envApiKey`                |
| `tests/unit/cli-tools-config-safety.test.js`                                | Reset removes every key Apply writes   |

## NOT Building

- Shared per-tool config builder and parity test (YAN-617).
- Copy that still names Copilot on the MITM page (YAN-622 scope).
- Any brand-switch change; no unfinished work is exposed.

## Step-by-Step Tasks

### Task 1: DeepSeek TUI snippet (YAN-624)

- ACTION: Prefix the manual snippet with a replace-the-file comment and `provider = "openai"`.
- MIRROR: `build9RouterConfig` in the route.
- IMPLEMENT: Content becomes comment, `provider = "openai"`, blank line, then the existing `[providers.openai]` block.
- VALIDATE: `npm run lint`.

### Task 2: Remote intercept steps (YAN-625)

- ACTION: Build `RemoteInterceptSteps` entries from `MITM_TOOLS` that have `TOOL_HOSTS`.
- IMPLEMENT: `Object.entries(MITM_TOOLS).flatMap(([id, tool]) => TOOL_HOSTS[id] ? [{ toolId: id, tool, hosts: TOOL_HOSTS[id] }] : [])`; drop the unused `CLI_TOOLS` import if no longer needed.
- VALIDATE: `npm run lint`.

### Task 3: Grok Build hydrate (YAN-626)

- ACTION: Hydrate from status once it first loads.
- MIRROR: DeepSeekTuiToolCard one-shot `useRef` effect.
- IMPLEMENT: Plain `useState("")`/`useState({})` initialisers; effect calls `hydrate(status)` when `status?.installed` and the ref is unset.
- VALIDATE: `npm run lint`.

### Task 4: Claude Reset keys (YAN-627)

- ACTION: Derive model env keys from `CLI_TOOLS.claude.defaultModels[].envKey`.
- VALIDATE: new unit test in Task 6.

### Task 5: jcode saved key (YAN-628)

- ACTION: GET returns `envApiKey` from the provider env file; route-local const for the env var name so no new brand literal is added.
- VALIDATE: `npm run lint:brand`.

### Task 6: Test

- ACTION: In `cli-tools-config-safety.test.js`, POST every `defaultModels` envKey plus base URL/token/auto-compact, DELETE, assert none remain and an unrelated env key survives.
- VALIDATE: `cd tests && npx vitest run unit/cli-tools-config-safety.test.js`.

## Testing Strategy

Only the YAN-627 route test (explicitly requested in the issue). The UI fixes are one-line state/derivation changes covered by lint and build.

## Validation Commands

```bash
npm run lint
npm run lint:brand
cd tests && npx vitest run unit/cli-tools-config-safety.test.js
cd tests && npx vitest run --reporter=json --outputFile=results.json; node __baseline__/verify-no-regression.mjs results.json
npm run build
```

## Acceptance Criteria

- [ ] DeepSeek snippet contains `provider = "openai"`.
- [ ] Remote intercept list excludes cursor and copilot.
- [ ] Grok Build fields show saved values on load.
- [ ] Claude Reset removes `ANTHROPIC_DEFAULT_FABLE_MODEL` (test).
- [ ] jcode GET returns `envApiKey`.
- [ ] Lint, brand guard, tests, build green.

## Completion Checklist

- [ ] PR into `master` with `Closes #440`…`#444` and `Closes YAN-624`…`YAN-628`, label `backport:0.6`
- [ ] Review + fixes, CI green, squash merge
- [ ] Backport PR into `release/0.6`, green, merged

## Risks

- jcode GET now returns the saved gateway key to the browser. Same exposure as Claude (GET returns `settings.env.ANTHROPIC_AUTH_TOKEN`); cli-tools routes are local-only behind `dashboardGuard`.

## Notes

`ponytail:` snippets stay hand-built per card; YAN-617 replaces them with shared builders.
