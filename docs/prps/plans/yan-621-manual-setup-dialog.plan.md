# Plan: Manual setup dialog (YAN-621)

## Summary

Replace the cramped inline manual snippet that remote dashboard users see on
each CLI tool card with a large "Set up manually" dialog. The dialog has one tab
per file, shows the full per-OS path, format and merge badges with a one-line
instruction, readable code blocks, Copy / Copy all / Download, an OS switch
remembered per viewer, and a "Complete these first" state instead of configs
with placeholders. The same dialog replaces the existing local
`ManualConfigModal`, so every card gets it with no per-card JSX changes.

## User Story

As a user on the remote dashboard, I want a readable manual setup dialog with
correct paths for my OS and clear merge guidance, so that I can configure a CLI
tool by hand without wiping my other settings.

## Problem → Solution

Inline `<pre>` with `break-all` in a narrow panel, files stacked, merge only
hinted in the filename, paths fixed to the browser OS, modal unreachable
remotely → primary "Set up manually" button opens a `full` modal with tabs per
file, badges, instructions, no-wrap code, copy/download, OS switch and a
missing-inputs checklist.

## Metadata

- **Complexity**: Medium
- **Source PRD**: N/A (Linear YAN-621, GitHub #493)
- **PRD Phase**: N/A
- **Estimated Files**: 9
- **Target release**: `v1.0.0` — PR into `master`, no backport.

## Batches

| Batch | Tasks    | Depends On | Parallel Width |
| ----- | -------- | ---------- | -------------- |
| B1    | 1.1      | —          | 1              |
| B2    | 2.1, 2.2 | B1         | 2              |

- **Total tasks**: 3
- **Total batches**: 2
- **Max parallel width**: 2

## Worktree Setup

- **Parent**: ~/.claude-worktrees/tokenhop-6b1661957219e94e/feat-yan-621-manual-setup-dialog/ (branch: feat/yan-621-manual-setup-dialog)

---

## UX Design

### Before

```
┌ Claude Code ─────────────────┐
│ [controls…]                  │
│ ~/.claude/settings.json (mer │
│ ge into existing)    [Copy]  │
│ ┌──────────────────────────┐ │
│ │{"env":{"ANTHROPIC_BASE_U │ │  ← break-all, max-h-60
│ │RL":"https://tokenhop.hom │ │
│ └──────────────────────────┘ │
│ ~/.claude.json …  (stacked)  │
└──────────────────────────────┘
```

### After

```
┌ Claude Code ─────────────────┐
│ [controls…]                  │
│ 2 files to edit [Set up manually] │
└──────────────────────────────┘

┌ Claude Code — Manual configuration ─────────────── ✕ ┐
│ OS: [macOS|Linux|Windows]                [Copy all]  │
│ settings.json | .claude.json          (Tabs)         │
│ ~/.claude/settings.json   [JSON] [Merge]             │
│ Merge these keys into the existing file.             │
│ ┌───────────────────────────────────────── scroll → ┐│
│ │{ "env": { "ANTHROPIC_BASE_URL": "https://…" } }   ││
│ └───────────────────────────────────────────────────┘│
│                              [Download] [Copy]       │
└──────────────────────────────────────────────────────┘
```

Missing inputs: the body shows a "Complete these first" callout listing
"Pick a model" and/or "Choose or create an API key" instead of tabs.

### Interaction Changes

| Touchpoint            | Before                              | After                               | Notes                                                |
| --------------------- | ----------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| Remote card footer    | Inline snippet list                 | Summary + primary "Set up manually" | Opens the card's existing modal via `onManualConfig` |
| Local "Manual config" | `xl` modal, stacked `<pre>`         | Same new dialog                     | Shared component                                     |
| Paths                 | Browser OS only                     | OS switch, persisted per viewer     | `~/` shown as `%USERPROFILE%\` on Windows            |
| Merge guidance        | "(merge into existing)" in filename | Badge + instruction                 | Fragment `note` overrides the instruction            |
| Missing model/key     | "Pick a model…" or placeholder key  | "Complete these first" checklist    |                                                      |

---

## Mandatory Reading

| Priority | File                                                                  | Lines   | Why                                                     |
| -------- | --------------------------------------------------------------------- | ------- | ------------------------------------------------------- |
| P0       | `src/shared/components/ManualConfigModal.js`                          | all     | Component being rewritten                               |
| P0       | `src/lib/cliToolConfigs/shared.js`                                    | all     | Fragment contract, `toManualConfigs`, `browserPlatform` |
| P0       | `src/app/(dashboard)/dashboard/cli-tools/components/SetupScaffold.js` | 100-150 | Remote inline snippet to replace                        |
| P1       | `src/shared/components/Tabs.js`                                       | all     | WAI-ARIA tabs (RTL-aware)                               |
| P1       | `src/shared/components/SegmentedControl.js`                           | all     | OS switch                                               |
| P1       | `src/shared/components/Modal.js`                                      | 100-180 | Sizes, focus trap, `footer`                             |
| P1       | `src/store/themeStore.js`                                             | all     | zustand `persist` pattern                               |
| P2       | `src/app/(dashboard)/dashboard/settings/sections/ConfigTransfer.js`   | 36-47   | Blob download pattern                                   |
| P2       | `src/lib/cliToolConfigs/copilot.js`                                   | 1-21    | Per-OS paths from `platform`                            |
| P2       | `src/lib/cliToolConfigs/cowork.js`                                    | 20-100  | Per-OS root, `note` usage                               |

## External Documentation

No external research needed.

---

## Patterns to Mirror

### NAMING_CONVENTION

```
// SOURCE: src/lib/cliToolConfigs/copilot.js:5
export const copilotConfigFile = (platform) => {
  if (platform === "win32") return "%APPDATA%\\Code\\User\\chatLanguageModels.json";
```

### ERROR_HANDLING

```
// SOURCE: src/shared/components/ManualConfigModal.js:29-37
icon={copied === copyId ? "check" : error === copyId ? "error" : "content_copy"}
onClick={() => copy(config.content, copyId)}
<CopyStatus copied={copied} error={error} id={copyId} />
```

### LOGGING_PATTERN

```
// SOURCE: src/app/(dashboard)/dashboard/cli-tools/hooks/useToolSetupData.js:59
console.error("Error loading CLI tools data:", err);
// Copy failures surface in the UI only (useCopyToClipboard error id); no logging.
```

### REPOSITORY_PATTERN

```
// SOURCE: src/store/themeStore.js:7-8
const useThemeStore = create(
  persist(
```

### SERVICE_PATTERN

```
// SOURCE: src/app/(dashboard)/dashboard/settings/sections/ConfigTransfer.js:37-46
const url = URL.createObjectURL(new Blob([...], { type: "application/json" }));
const anchor = document.createElement("a");
anchor.href = url; anchor.download = ...;
document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
```

### TEST_STRUCTURE

```
// SOURCE: tests/unit/signal-form-primitives.test.js (pure helpers, node env)
import { describe, expect, it } from "vitest";
expect(buttonClasses("primary","md")).toContain("bg-lime")
```

---

## Files to Change

| File                                                                                   | Action | Justification                                                                                             |
| -------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `src/lib/cliToolConfigs/shared.js`                                                     | UPDATE | `toManualConfigs` keeps `file/format/merge/note`; add `formatLabel`, `displayPath`, `manualMissingInputs` |
| `src/lib/cliToolConfigs/cowork.js`                                                     | UPDATE | Sentence-case `note` (now shown as the instruction)                                                       |
| `src/lib/cliToolConfigs/openclaw.js`                                                   | UPDATE | Sentence-case `note`                                                                                      |
| `src/store/manualSetupStore.js`                                                        | CREATE | Persisted per-viewer OS choice                                                                            |
| `src/shared/components/ManualConfigModal.js`                                           | UPDATE | New dialog (tabs, badges, copy all, download, OS switch, missing state)                                   |
| `src/app/(dashboard)/dashboard/cli-tools/components/SetupScaffold.js`                  | UPDATE | Remote: summary + "Set up manually" instead of inline list                                                |
| `src/app/(dashboard)/dashboard/cli-tools/components/LocalOnlyNotice.js`                | UPDATE | Pointer copy matches the new button                                                                       |
| `src/app/(dashboard)/dashboard/cli-tools/components/{Copilot,Cowork,Droid}ToolCard.js` | UPDATE | Builders take the stored OS instead of the browser guess                                                  |
| `tests/unit/manual-setup-helpers.test.js`                                              | CREATE | Critical pure-helper checks                                                                               |

## NOT Building

- Syntax highlighting (no highlighter bundled; Monaco is too heavy here).
- Shell one-liners that write/merge files (optional in the issue; unsafe across OSes).
- Fixing Kilo's Linux-only VS Code path in Apply (separate bug; the dialog shows what Apply writes).
- Per-tool missing-input reasons beyond model and API key.
- YAN-622 intercept tools and YAN-623 guide tools.

---

## Step-by-Step Tasks

### Task 1.1: Shared helpers, store and test — Depends on [none]

- **BATCH**: B1
- **ACTION**: Extend `src/lib/cliToolConfigs/shared.js`, create `src/store/manualSetupStore.js`, sentence-case the two notes, add the test.
- **IMPLEMENT**: `toManualConfigs` returns `{ file, filename: file, format: formatLabel(fragment), merge, note, content }`. `formatLabel` → `JSON`/`TOML` from format, else by extension (`.yaml/.yml` → `YAML`, `.env` → `.env`, `.toml` → `TOML`, else `Text`). `displayPath(file, platform)` → on `win32` turns a leading `~/` into `%USERPROFILE%\` and `/` into `\`; other paths unchanged. `manualMissingInputs(configs)` → `["model"]` when empty, `["apiKey"]` when any content includes `API_KEY_PLACEHOLDER`. Store: zustand `persist`, key `${ACTIVE.storageKeyPrefix}manual-setup`, state `{ platform: browserPlatform(), setPlatform }`, export `useManualPlatform()`.
- **MIRROR**: REPOSITORY_PATTERN, NAMING_CONVENTION
- **IMPORTS**: `create`, `persist` from zustand; `ACTIVE` from `@/shared/brand`.
- **GOTCHA**: keep `filename` for back-compat; `.env` check must match `provider-x.env` and `~/.hermes/.env`.
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/manual-setup-helpers.test.js tests/unit/cli-tools-parity.test.js`

### Task 2.1: Dialog rewrite — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: Rewrite `src/shared/components/ManualConfigModal.js` keeping default export `ManualConfigModal({ isOpen, onClose, title, configs })`.
- **IMPLEMENT**: Modal `size="full"`. Header row: SegmentedControl (macOS `darwin` / Linux `linux` / Windows `win32`, `aria-label="Operating system"`, size sm) bound to the store, plus "Copy all". Missing inputs → Callout "Complete these first" with list items. Else one file → panel directly; several → `Tabs` (label = basename, two last segments when basenames repeat). Panel: mono path (`dir="ltr"`, `break-all` allowed for the path only), Badge format (neutral) + Badge Merge/Replace (info/warn), instruction (note, else "Merge these keys into the existing file." / "Replace the file, or create it."), `<pre dir="ltr" class="max-h-[50vh] overflow-auto whitespace-pre …">`, buttons Copy and (single-file only) Download (basename, Blob `text/plain`). `ManualConfigList` stays exported only if still used (remove otherwise).
- **MIRROR**: ERROR_HANDLING, SERVICE_PATTERN
- **IMPORTS**: Modal, Tabs, SegmentedControl, Badge, Callout, Button, CopyStatus, useCopyToClipboard, store, shared helpers.
- **GOTCHA**: copy-tone: no `!` ("Copied", not "Copied!"); static English JSX text only; pre/code are skipped by i18n.
- **VALIDATE**: `npm run lint`, `npm run build`, browser check at 1440/1024/390, RTL, both themes.

### Task 2.2: Wire remote button and OS store into cards — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: Update `SetupScaffold.js`, `LocalOnlyNotice.js`, Copilot/Cowork/Droid cards.
- **IMPLEMENT**: Replace the inline `ManualConfigList` with a row: muted text ("N files to edit" / "Complete the fields above first") and a primary `Button` "Set up manually" (`icon="content_copy"`) calling `onManualConfig`. LocalOnlyNotice line → "Use Set up manually on each tool to copy its configuration." Cards: `platform: useManualPlatform()` (Droid drops the `navigator.platform` check).
- **MIRROR**: existing SetupScaffold Button usage.
- **GOTCHA**: hooks at component top level, not inside `getManualConfigs`.
- **VALIDATE**: `npm run lint`; remote view (non-localhost origin) shows the button and opens the dialog.

---

## Testing Strategy

### Unit Tests

| Test                | Input                                                            | Expected Output                         | Edge Case? |
| ------------------- | ---------------------------------------------------------------- | --------------------------------------- | ---------- |
| formatLabel         | json / toml / text `.yaml` / `.env` / `provider-x.env` / `.toml` | JSON / TOML / YAML / .env / .env / TOML | yes        |
| displayPath         | `~/.claude/settings.json`, win32                                 | `%USERPROFILE%\.claude\settings.json`   |            |
| displayPath         | `%APPDATA%\Code\…`, win32; `~/x`, darwin                         | unchanged                               | yes        |
| manualMissingInputs | `[]` / placeholder content / full                                | `["model"]` / `["apiKey"]` / `[]`       |            |
| toManualConfigs     | builder fragments                                                | keeps file, format label, merge, note   |            |

### Edge Cases Checklist

- [x] Empty input (null builder → missing model)
- [x] Clipboard unavailable on plain HTTP (existing execCommand fallback + error state)
- [x] Duplicate basenames (OpenClaw per-agent models.json)

---

## Validation Commands

### Static Analysis

```bash
npm run lint && npm run lint:brand
```

EXPECT: no errors

### Unit Tests

```bash
npx vitest run -c tests/vitest.config.js tests/unit/manual-setup-helpers.test.js tests/unit/cli-tools-parity.test.js
```

EXPECT: pass

### Full Test Suite

```bash
npm test
```

EXPECT: no regressions vs baseline

### Browser Validation

```bash
npm run build && NEXT_PUBLIC_BRAND=tokenhop npm run build
PORT=20128 npm run dev   # open via a non-localhost origin (LAN IP) for remote mode
```

EXPECT: dialog works remotely and locally

### Manual Validation

- [ ] Remote: card shows "Set up manually"; dialog opens; tabs switch with arrows (mirrored in RTL)
- [ ] OS switch changes Copilot/Cowork paths and `~` → `%USERPROFILE%` on Windows; persists after reload
- [ ] Copy, Copy all, Download work; no `break-all` in code blocks
- [ ] No model → "Complete these first"

---

## Acceptance Criteria

- [ ] Remote users get a readable dialog with correct per-OS paths and merge guidance for every custom-config tool
- [ ] No inline `break-all` block remains
- [ ] Lint, brand lint, tests and both builds pass

## Completion Checklist

- [ ] Follows discovered patterns
- [ ] No new dependencies
- [ ] Copy is sentence case, no `!`
- [ ] No brand literals

## Risks

| Risk                                     | Likelihood | Impact | Mitigation                                                                  |
| ---------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------- |
| Persisted store hydration mismatch       | Low        | Low    | Dialog and remote UI render only after client interaction / `markLocalOnly` |
| Kilo VS Code path wrong on macOS/Windows | Known      | Low    | Out of scope; shows what Apply writes                                       |

## Notes

The Windows `~` mapping mirrors Apply, which uses `path.join(os.homedir(), …)`
with the same layout on every OS.
