# Plan: Triage and fix ~86 known-failing tests behind the known-fails regression gate (YAN-416 / GH #351)

## Summary

~86 tests are pinned in `tests/__baseline__/known-fails.txt`; the regression gate only fails on _new_ failures, so real product defects stay hidden. Triage grouped failures by root cause: two confirmed **product bugs** in the translator engine, a batch of **obsolete tests** (assert deliberately-changed behavior), a batch of **infra tests** (`node:test` files never collected by vitest, cwd-relative paths, timeouts), and a group still under triage. Fix the bugs, repair/convert/delete the stale tests, flip stale `it.fails` markers, and regenerate `known-fails.txt` so the baseline shrinks.

## User Story

As a 9router maintainer, I want the known-fails baseline to trend to empty and the remaining failures to be genuine, so that `npm test` in CI catches real regressions instead of masking them.

## Problem → Solution

91-line baseline hides product bugs (translator normalization, dropped tool-arg deltas) → baseline regenerated after fixes; every entry either fixed, consciously deleted, or linked to a follow-up issue.

## Metadata

- **Complexity**: Large (20+ test files, 2-4 app-code files)
- **Source PRD**: N/A — Linear YAN-416, GitHub issue #351
- **PRD Phase**: N/A
- **Estimated Files**: ~25

---

## Worktree Setup

- **Parent**: 9router/.config/opencode/worktrees/9router-fix-known-fails/ (branch: fix/yan-416-known-fails-triage, off re-design)

---

## UX Design

N/A — internal change (tests + translator engine internals). No user-facing behavior change beyond fixing silent data-loss bugs in request/response translation.

---

## Mandatory Reading

| Priority | File                                                   | Lines                       | Why                                                                     |
| -------- | ------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------- |
| P0       | `open-sse/translator/request/openai-to-claude.js`      | 278-306                     | PRODUCT_BUG 1: assistant `reasoning_content` dropped                    |
| P0       | `open-sse/translator/response/openai-to-claude.js`     | 200-260                     | PRODUCT_BUG 2: sanitized tool args only emitted on `finish_reason`      |
| P0       | `open-sse/translator/request/claude-to-openai.js`      | 202-240                     | Pattern: tool_result image handling (context for `it.fails` flips)      |
| P0       | `open-sse/translator/request/openai-to-kiro.js`        | 365-377                     | Post-`d4372b7b`: no top-level `systemPrompt` (400 REQUEST_BODY_INVALID) |
| P0       | `tests/__baseline__/verify-no-regression.mjs`          | all                         | Gate semantics                                                          |
| P1       | `tests/vitest.config.js`                               | all                         | collection, isolation, projects                                         |
| P1       | `tests/unit/security-audit.test.js`                    | 20,114,141,165              | cwd-relative `path.resolve` bug                                         |
| P1       | `src/app/api/oauth/cursor/auto-import/route.js`        | 15-39,71-77,154-159,215-216 | current route contract for rewrite                                      |
| P1       | `tests/unit/openai-to-kiro.test.js`                    | 359-600                     | stale `result.systemPrompt` assertions                                  |
| P2       | `open-sse/translator/concerns/reasoning.js`            | `extractReasoningText`      | thinking-block mapping convention                                       |
| P2       | `open-sse/translator/request/openai-to-commandcode.js` | 142                         | sibling `reasoning_content` handling to mirror                          |

## External Documentation

None needed — internal patterns only.

---

## Patterns to Mirror

### TEST_STRUCTURE (vitest, globals on)

```
// SOURCE: tests/unit/rtk.test.js:1-2
import { describe, it, expect, beforeEach } from "vitest";
import { compressMessages, formatRtkLog } from "../../open-sse/rtk/index.js";
```

### NODE_TEST → VITEST conversion (4 files)

```
// FROM: import { test } from "node:test"; import assert from "node:assert/strict";
// TO:   import { describe, it, expect } from "vitest";
// assert.equal(a,b) → expect(a).toBe(b); assert.deepEqual → toEqual;
// assert.ok(x) → expect(x).toBeTruthy(); test("name", fn) → it("name", fn)
```

### REPO-RELATIVE PATH (fix cwd bug)

```
// FROM: path.resolve("src/...")   // cwd = tests/ → ENOENT
// TO:   path.resolve(import.meta.dirname, "../../src/...")
```

### PRODUCT_BUG 1 — reasoning_content → thinking block (mirror sibling)

```
// SOURCE: open-sse/translator/request/openai-to-commandcode.js:142
const rc = m.reasoning_content || m.thought || m.reasoning;
// Apply in openai-to-claude.js assistant branch: unshift
// { type: CLAUDE_BLOCK.THINKING, thinking: rc } before text blocks
```

### PRODUCT_BUG 2 — flush buffered tool args (move emission out of finish_reason gate)

```
// SOURCE: open-sse/translator/response/openai-to-claude.js:236-252
// buffered+sanitized delta emission currently inside if (choice.finish_reason)
// move the input_json_delta emission (~240-252) out; keep content_block_stop/
// message_delta inside the gate
```

### REGENERATE BASELINE

```
cd tests && npx vitest run --update=new --reporter=json --outputFile=results.json
node __baseline__/verify-no-regression.mjs results.json
# rewrite known-fails.txt from results.json failures (same format:
# "<repo-relative path> :: <fullName>", "<path> :: <file>" for file-level)
```

---

## Files to Change

### App code (product bugs)

1. `open-sse/translator/request/openai-to-claude.js` — map assistant `msg.reasoning_content` (alias `reasoning`/`thought`) to a leading Claude thinking block; preserve existing content handling. Fixes `tests/translator/bugs-toClaude-context.test.js`.
2. `open-sse/translator/response/openai-to-claude.js` — emit buffered+sanitized tool `input_json_delta` regardless of `finish_reason`; keeps `content_block_stop`/`message_delta` gated. Fixes `tests/unit/openai-to-claude.test.js` "omits empty Read pages tool argument".
3. (pending third triage group) RTK export `setRtkEnabled`, parseSSELine/flattening, misc executors — see Batch D; only if triage confirms PRODUCT_BUG. NOTE: `parseSSELine(rawJson)` is **by design** gated on `format === FORMATS.OLLAMA` (raw NDJSON without "data:"); the test asserts the no-format call returns the parsed object — triage says verify intended contract before touching app code (prefer test update if format-gating is deliberate).

### Test fixes — OBSOLETE_TEST (rewrite/update assertions to current intentional behavior)

1. `tests/unit/openai-to-kiro.test.js` (~19 tests, lines 359-600) — assert thinking prefix on `result.conversationState.currentMessage.userInputMessage.content` instead of removed top-level `systemPrompt`; rename "top-level systemPrompt" tests accordingly. `additionalModelRequestFields` assertions unchanged.
2. `tests/translator/claude-kiro-direct.test.js` (9 tests, 78-227) — same rewrite on `out.conversationState.currentMessage.userInputMessage.content`.
3. `tests/unit/commandcode-to-openai.test.js` (116-122) — expect `feed()` to **throw** `/Boom/` (f8e696a2 replaced fake stop chunks with throw); assert no `[object Object]`.
4. `tests/unit/openai-to-commandcode.test.js` (264-266, 286-288) + `tests/translator/bugs-gemini-cursor-commandcode.test.js` (90) — add `mediaType: "image/png"` to 3 expected literals (37da50d9).
5. `tests/translator/bugs-claudeCode-context.test.js` + `tests/translator/bugs-openai-bridge.test.js` — `it.fails(` → `it(` (bugs fixed by 37da50d9; become regression coverage).
6. `tests/unit/oauth-cursor-auto-import.test.js` — full rewrite to current route: mock `require("better-sqlite3")` with `.prepare().get(key)`; expect "Checked locations" not-found text and `{ found: false, windowsManual: true, dbPath }`; drop fuzzy-LIKE / "login to Cursor" / linux single-path / freebsd-400 assertions (ef72a9c6, 88845301, 3a33aae1).
7. `tests/unit/kimchi.test.js` — convert `node:test` → vitest AND fix `category` expectation `"oauth"` → `"freeTier"` (cd531158 intentional).

### Test fixes — INFRA

1. `tests/auth/saml.test.js` — convert 4 `node:test` tests → vitest describe/it/expect.
2. `tests/unit/cline-auth.test.js` — convert → vitest.
3. `tests/unit/kimchi-strip-reasoning.test.js` — convert → vitest.
4. `tests/unit/security-audit.test.js` (9 tests) — `path.resolve(import.meta.dirname, "../../src/...")`; app code already has all guards (escapeHtml 175-188, LOCK_FILE 53 + wx 559, mitmIsRestarting 456-468, validateProxyUrl).
5. `tests/unit/antigravity-oauth-client.test.js` — raise timeout to ≥15s on the two OAuth-login `it`s (cold import hits 5s default under load); update stale baseline comment.
6. `tests/unit/xai-oauth-service.test.js` — passes now; drop baseline lines; optional timeout bump on discovery test.
7. `tests/unit/embeddings.cloud.test.js` — DELETE (cloud/ worker removed in 28d33ffb).

### Batch D (pending third triage report — executor/misc group)

`claude-header-forwarding`, `codex-image-fetch`, `combo-autoswitch`, `cursor-models`, `db-benchmark`, `devin-cli-executor`, `executor-const-guard`, `force-stream-config`, `image-fetch-hardening`, `kiro-external-idp`, `kiro-terminal-integrity`, `mimo-free.live`, `request-details-tab`, `windsurf-executor`, `translator-helpers-edge`, `rtk`, `translator-request-normalization`.

### Baseline

1. `tests/__baseline__/known-fails.txt` — regenerate after each batch; final state empty or survivors documented with linked follow-up issues.

## NOT Building

- No new product features; no new tests beyond converting/repairing existing ones (goal explicitly: no unnecessary tests).
- No changes to `verify-no-regression.mjs` gate semantics.
- No baseline entries added without either a fix or a linked follow-up issue.
- Out-of-scope: related issues YAN-14 / YAN-15 (fixture-data / live-credentialed tests) — separate tickets.

---

## Step-by-Step Tasks

### Batch A — INFRA test repairs (no app code)

- **A1.** Convert `tests/auth/saml.test.js`, `tests/unit/cline-auth.test.js`, `tests/unit/kimchi-strip-reasoning.test.js` from `node:test` to vitest.
  - ACTION: mechanical import/assertion mapping per TEST_STRUCTURE pattern; run each file.
  - VALIDATE: `cd tests && npx vitest run auth/saml.test.js unit/cline-auth.test.js unit/kimchi-strip-reasoning.test.js` all pass.
- **A2.** Convert `tests/unit/kimchi.test.js` → vitest; change `category` expectation to `"freeTier"`.
  - VALIDATE: file passes under vitest.
- **A3.** Fix `tests/unit/security-audit.test.js` path base → `import.meta.dirname`.
  - VALIDATE: all 17 tests pass.
- **A4.** Bump timeouts: `antigravity-oauth-client.test.js` two OAuth-login `it`s ≥15s; `xai-oauth-service.test.js` discovery `it` ≥15s.
  - VALIDATE: both files pass in isolation AND under a full unit run.
- **A5.** Delete `tests/unit/embeddings.cloud.test.js`.
  - VALIDATE: gone; no other file imports it.
- **A6.** Regenerate baseline; expect −24 lines (1+1+1+1+9+2+2+1 … per file counts). Gate reports no regression.

### Batch B — OBSOLETE_TEST updates (no app code)

- **B1.** Rewrite kiro thinking-budget assertions in `openai-to-kiro.test.js` (19) and `claude-kiro-direct.test.js` (9) onto `conversationState.currentMessage.userInputMessage.content`; keep `additionalModelRequestFields` assertions.
  - VALIDATE: both files fully green.
- **B2.** Update `commandcode-to-openai.test.js` error-event test to expect throw.
  - VALIDATE: file green.
- **B3.** Add `mediaType` to 3 expected literals (`openai-to-commandcode.test.js` ×2, `bugs-gemini-cursor-commandcode.test.js` ×1).
  - VALIDATE: both files green.
- **B4.** Flip `it.fails` → `it` in `bugs-claudeCode-context.test.js` and `bugs-openai-bridge.test.js`.
  - VALIDATE: both files green (now hard regression coverage).
- **B5.** Rewrite `oauth-cursor-auto-import.test.js` against current route contract.
  - VALIDATE: file green; 8 tests kept where contract allows, otherwise trimmed.
- **B6.** Regenerate baseline; gate green.

### Batch C — PRODUCT_BUG fixes (app code + their tests)

- **C1.** `openai-to-claude.js` request: assistant `reasoning_content` → thinking block (mirror openai-to-commandcode.js:142).
  - VALIDATE: `bugs-toClaude-context.test.js` green; full translator suite no new failures.
- **C2.** `openai-to-claude.js` response: flush sanitized tool-arg deltas outside `finish_reason` gate.
  - VALIDATE: `openai-to-claude.test.js` green incl. existing finish_reason tests; no double emission.
- **C3.** (Batch D product bugs if confirmed — e.g. RTK `setRtkEnabled` export.)
- **C4.** Regenerate baseline; gate green.

### Batch D — third triage group (executor/misc) fixes per report

- **D1.** Apply per-item fixes from the pending triage report (classify PRODUCT_BUG / OBSOLETE_TEST / ENV_BOUND / INFRA each).
  - VALIDATE: each touched file's tests green; env-bound items either skip-if-unconfigured or stay baselined with linked follow-up issues.
- **D2.** Regenerate baseline; gate green.

### Batch E — final gate + closeout

- **E1.** Full `npm test` from repo root; regenerate `known-fails.txt` final.
  - VALIDATE: gate prints `✅ No regression`; baseline empty or every survivor has a linked GH issue + Linear follow-up.
- **E2.** Update baseline header comment (no stale flake note); ensure `npm run lint` passes on touched files.
- **E3.** Commit per Conventional Commits: `fix(translator): …`, `test(…): …` grouped logically; push; open PR to `re-design` linking GH #351 ("Closes #351").
- **E4.** Review PR (subagent), fix findings, monitor CI until green, squash-merge, cleanup branches/worktree, close Linear YAN-416.

---

## Testing Strategy

- Per-file vitest runs after every edit (fast loop), full `npm test` per batch (baseline regeneration).
- The gate itself is the acceptance harness: `node tests/__baseline__/verify-no-regression.mjs results.json`.
- No new tests created except converting existing `node:test` files and updating assertions — per goal constraint.

## Validation Commands

```bash
cd tests && npx vitest run <file>                       # per-file
cd tests && npx vitest run --update=new --reporter=json --outputFile=results.json && node __baseline__/verify-no-regression.mjs results.json   # gate
npm run lint:modified                                   # style on touched files
```

## Acceptance Criteria

- `npm test` gate green; `known-fails.txt` empty or survivors each linked to a follow-up issue.
- Two translator product bugs fixed with regression coverage via the flipped/updated tests.
- CI (Tests, build, CLI, Docker) green on the PR; PR squash-merged to `re-design`; Linear YAN-416 Done.

## Completion Checklist

- [ ] Batch A complete, baseline regenerated
- [ ] Batch B complete, baseline regenerated
- [ ] Batch C complete (product bugs), baseline regenerated
- [ ] Batch D complete, baseline regenerated
- [ ] Final full `npm test` + gate green
- [ ] Lint passes on touched files
- [ ] PR opened → reviewed → fixes applied → CI green → squash merged to re-design
- [ ] Branches/worktree cleaned up; Linear ticket closed

## Risks

- **Kiro thinking-budget rewrites (B1)** are the largest edit surface (~28 tests) — keep assertions faithful to `kiroConstants.js` behavior; run full translator suite after.
- **C2 (response translator)** touches shared streaming path — verify no double `input_json_delta` emission and no regression in finish_reason flows.
- **Live/env-bound tests** (mimo-free.live, cursor-models, image-fetch-hardening) may be unfixable locally — allowed to remain baselined ONLY with linked follow-up issues (per Linear issue's done definition).
- Baseline regeneration must use the isolated-run semantics (tests/setup/) or the comment header becomes misleading.

## Notes

- Triage evidence: three parallel read-only triage agents; reports for groups A (kiro/translator) and B (oauth/security) complete; group C (executor/misc) pending — Batch D absorbs it.
- Baseline header: "Failures on master from an isolated run (tests/setup/)" — current branch baseline was captured from re-design HEAD 11469026.
