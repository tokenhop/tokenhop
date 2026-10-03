# Plan: YAN-197 OpenCode Go live model catalog

Target: v1.1.0, PR into `master`, no backport. GitHub #742. Part of YAN-135. No
switch needed: a failed fetch keeps the static catalog and shows a warning.

## Upstream

`GET https://opencode.ai/zen/go/v1/models`. OpenAI-style ids only, a shared
catalog (returns 200 for any or no key). Live on 2026-10-03: 43 ids, 15 the
registry doesn't know (e.g. `grok-4.7`, `gpt-6-luna`, `qwen3.5-plus`,
`mimo-v2.6-pro`).

## Transport for ids the registry lacks

The list has no endpoint info. chatCore picks the transport from the model's
`supportedFormats`/`targetFormat`; an unknown id had neither, so a Claude or
Responses client would hit an endpoint the model can't serve.
`inferOpencodeGoModel` (open-sse/providers/models/helpers.js) fills them by
vendor prefix from the endpoint table at <https://opencode.ai/docs/go/>:

| Prefix                      | Endpoints                        |
| --------------------------- | -------------------------------- |
| `grok`, `gpt`, `muse-spark` | `/responses` only                |
| `minimax`, `qwen`           | `/chat/completions`, `/messages` |
| anything else               | `/chat/completions`              |

Used by `getModelTargetFormat` / `getModelSupportedFormats` (opencode-go only;
registry entries always win) and by the executor's `/responses` routing.

## Changes

1. `src/lib/providerModels/apiKeyModels.js`: `parseOpencodeGoModels` + `resolveOpencodeGo`.
2. `liveResolvers.js`: register `opencode-go`.
3. Registry: `features.liveModels: true`.
4. `open-sse/config/providerModels.js`, `open-sse/executors/opencode-go.js`: inferred transport.
5. Tests: registry lists; new `tests/unit/opencode-go-live-models.test.js`.

## Not done

- YAN-190 (OpenCode Free): noAuth, no connection row, so the connection-keyed
  live plumbing doesn't reach it. Deferred; comment on the issue.
