# PR Review #703 — feat(models): live model catalog for OpenRouter

**Reviewed**: 2026-10-03
**Mode**: PR
**Author**: yandy-r
**Branch**: feat/yan-144-openrouter-live-models → master
**Decision**: REQUEST CHANGES

## Summary

The resolver and filter bar are sound. Two consumers outside the provider page broke on multi-kind live entries (the model picker and Basic Chat). They need fixing before merge; the rest is minor polish. Three parallel reviewers: correctness, security, quality.

## Findings

### HIGH

- **[F001]** `src/shared/components/modelSelect/modelSelectHelpers.js:312` — The picker dedupes on `value` alone, before the kind filter. The image row of an image+text OpenRouter model wins, so the LLM picker drops the model.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Key `seen` on `${kind}:${value}`.

- **[F002]** `src/app/(dashboard)/dashboard/providers/detail/ModelsSection.js:192` — The search input uses the default tall sizing next to the compact Select. The shared `ToolbarSearch` exists.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Size-match with `inputClassName="py-1.5 text-xs sm:text-xs"`. Don't use `ToolbarSearch`: its page-wide "/" shortcut belongs to page toolbars. Comment explains why.

### MEDIUM

- **[F003]** `src/app/(dashboard)/dashboard/basic-chat/chatHelpers.js:136` — Basic Chat lists live non-chat (image/video/tts/embedding) entries as chat models.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: `normalizeLiveModel` returns null for non-llm kinds.

- **[F004]** `src/lib/providerModels/openrouterModels.js:25` — The per-kind fan-out invariant isn't documented, so a later change could reintroduce id-only dedupe.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Add a comment on `parseOpenRouterModels`.

- **[F005]** `src/lib/providerModels/openrouterModels.js:47` — The catalog fetch ignores per-connection proxy settings. Every simple resolver (openai, xai) has the same gap.
  - **Status**: Open
  - **Category**: Security
  - **Suggested fix**: Repo-wide follow-up: route simple resolvers through `proxyAwareFetch` with `resolveConnectionProxyConfig`. Out of scope for this PR.

### LOW

- **[F006]** `src/lib/providerModels/openrouterModels.js:32` — A malformed non-array `output_modalities` throws and drops the whole catalog.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Guard with `Array.isArray`.

- **[F007]** `src/lib/providerModels/openrouterModels.js:55` — The full upstream error body is echoed into the warning.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Truncate to 300 chars.

- **[F008]** `src/app/(dashboard)/dashboard/providers/detail/ModelsSection.js:215` — Screen readers hear the zero-match state twice: the "0 of N" counter and the message.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Set `aria-hidden` on the visual message; the live counter announces it.

- **[F009]** `docs/prps/plans/yan-144-openrouter-live-catalog.plan.md:69` — The plan lists `description`, which the code omits. It has no consumers.
  - **Status**: Open
  - **Category**: Completeness
  - **Suggested fix**: None needed: intentional, to keep a ~650-entry payload lean.

## Validation Results

| Check      | Result                            |
| ---------- | --------------------------------- |
| Type check | Skipped (JS project)              |
| Lint       | Pass                              |
| Tests      | Pass                              |
| Build      | Skipped (dev server smoke-tested) |

## Files Reviewed

- `src/lib/providerModels/openrouterModels.js` (Added)
- `src/lib/providerModels/liveResolvers.js` (Modified)
- `src/shared/utils/liveModels.js` (Modified)
- `open-sse/providers/registry/openrouter.js` (Modified)
- `src/app/api/providers/[id]/models/route.js` (Modified)
- `src/app/(dashboard)/dashboard/providers/detail/ModelsSection.js` (Modified)
- `tests/unit/openrouter-live-models.test.js` (Added)
- `tests/unit/live-model-resolvers.test.js` (Modified)
- `tests/unit/live-models-utils.test.js` (Modified)
