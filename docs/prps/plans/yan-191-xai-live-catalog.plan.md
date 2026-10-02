# Plan: YAN-191 live model catalog for xAI (API key + OAuth)

Target: v1.1.0, PR into `master`, no backport. GitHub #693. Part of YAN-135.

## Upstream (docs.x.ai REST reference)

| Endpoint                          | Shape            | Kind    | Required                       |
| --------------------------------- | ---------------- | ------- | ------------------------------ |
| `GET /v1/language-models`         | `{ models: [] }` | `llm`   | yes (failure = warning)        |
| `GET /v1/image-generation-models` | `{ models: [] }` | `image` | no (failure keeps static ones) |
| `GET /v1/video-generation-models` | `{ models: [] }` | `video` | no (failure keeps static ones) |

Entries carry `id`, `aliases[]`, modalities, prices. No context/max-output fields.
Auth: `Authorization: Bearer <api key | OAuth access token>` (OAuth scope has `api:access`).

## Changes

1. `src/lib/providerModels/xaiModels.js` (new): `parseXaiModels(body, kind)`,
   `reconcileXaiAliases(live, static)` (a static id that is a live alias keeps the
   static id, so curated entries and routing ids survive), `resolveXai(connection)`.
   OAuth (`accessToken`) uses `buildOAuthResolver` with `refreshTokenByProvider("xai")`
   on 401/403; API key uses the same fetch without refresh.
2. `liveResolvers.js`: register `xai`.
3. `open-sse/providers/registry/xai.js`: `features: { liveModels: true }`.
4. `src/app/api/providers/[id]/models/route.js`: drop shadowed `xai` config entry.
5. Tests: registry lists in `live-model-resolvers` / `live-models-utils`; new
   `tests/unit/xai-live-models.test.js` (parse + aliases, optional-kind fallback,
   OAuth refresh on 401).

## Not done

- No context length (endpoint lacks it); add a `/v1/models` call when limits are needed.
- OAuth acceptance on `api.x.ai` is unverified (no OAuth token available); a
  rejection surfaces as the static list plus a warning. Grok CLI fallback only if
  a real token shows rejection.

No switch needed: every failure keeps the static catalog.
