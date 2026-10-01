# PR Review #426 — fix(tts): honour OpenAI voice and response_format, close Kiro import modal

**Reviewed**: 2026-10-01
**Mode**: PR
**Author**: yandy-r
**Branch**: fix/yan-58-122-tts-voice-kiro-import → master
**Decision**: APPROVE with comments

## Worktree Setup

- **Parent**: .config/opencode/worktrees/tokenhop-fix-yan-58-122/ (branch: fix/yan-58-122-tts-voice-kiro-import)

## Summary

The fix is correct and stays in scope, and every caller keeps working. Three parallel reviewers (correctness, security,
quality) found no CRITICAL or HIGH issues. There are two MEDIUM findings: the TTS skill doc is stale, and the new 400 on an
unknown body `response_format` changes behaviour.

## Findings

### MEDIUM

- **[F001]** `skills/9router-tts/SKILL.md:21` — The skill doc doesn't mention body `voice` or body `response_format` (the
  codec), and it doesn't explain the envelope vs codec split.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: Add `voice` and `response_format` rows and one line on query envelope vs body codec. Note that only
    openai and selfhosted-tts honour them. Don't add any new 9router brand literals.
- **[F002]** `src/sse/handlers/tts.js:61` — A body `response_format` outside the OpenAI codec set used to be ignored and now
  returns 400. That is a behaviour change in a patch.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Keep the 400 on purpose, for OpenAI parity and fail-fast (OpenAI rejects the same values). Document
    it in SKILL.md and in the PR body.

### LOW

- **[F003]** `open-sse/handlers/ttsProviders/openai.js:7` — The TTS model filter checks only `m.kind`. Sibling adapters use
  `m.kind || m.type`.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Use `(m.kind || m.type) === "tts"`.
- **[F004]** `src/shared/components/KiroOAuthWrapper.js:14` — The state and branch comments don't mention the CLIProxyAPI
  import.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Mention `import-cli-proxy` in both comments.
- **[F005]** `docs/prps/plans/yan-58-122-tts-voice-kiro-import.plan.md:40` — The OpenRouter `openai/gpt-4o-mini-tts` parse
  bug has no tracked issue.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: File a Linear issue and reference it in the plan.
- **[F006]** `src/sse/handlers/tts.js:59` — `voice` has no length cap. The request body size limit bounds it.
  - **Status**: Open
  - **Category**: Security
  - **Suggested fix**: Deferred. The only sink is `JSON.stringify` into the upstream body, so there is no injection surface.
- **[F007]** `open-sse/handlers/ttsCore.js:60` — `format` is checked against the allow-list only at the HTTP edge, so a
  direct `handleTtsCore` caller could set any `Content-Type`.
  - **Status**: Open
  - **Category**: Security
  - **Suggested fix**: Deferred. This is defence in depth only, and HTTP can't reach it. Re-validate in `handleTtsCore`
    on its next change.
- **[F008]** `src/sse/handlers/tts.js:29` — The codec set and the `"mp3"` default are local magic values. AGENTS.md
  prefers `open-sse/config/`.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Deferred to keep the patch minimal.
- **[F009]** `tests/unit/openai-tts-body-fields.test.js:1` — The new 400 branches have no test.
  - **Status**: Open
  - **Category**: Completeness
  - **Suggested fix**: Deferred. The checks are trivial guards, and a `handleTts` test needs DB and settings mocks.

## Validation Results

| Check      | Result                              |
| ---------- | ----------------------------------- |
| Type check | Skipped (no tsconfig)               |
| Lint       | Pass                                |
| Tests      | Pass (`No regression. now fails=0`) |
| Build      | Pass                                |

## Files Reviewed

- `docs/prps/plans/yan-58-122-tts-voice-kiro-import.plan.md` (Added)
- `open-sse/handlers/ttsCore.js` (Modified)
- `open-sse/handlers/ttsProviders/openai.js` (Modified)
- `open-sse/handlers/ttsProviders/selfhostedTts.js` (Modified)
- `src/shared/components/KiroOAuthWrapper.js` (Modified)
- `src/sse/handlers/tts.js` (Modified)
- `tests/unit/openai-tts-body-fields.test.js` (Added)
