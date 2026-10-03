# Plan: YAN-145 Kiro, YAN-146 Grok CLI, YAN-147 Qoder, YAN-148 Cline, YAN-149 ClinePass, YAN-150 Kimchi

Target: v1.1.0, PR into `master`, no backport. GitHub #728–#733. Part of YAN-135. No
switch needed: every failure keeps the static catalog plus a warning.

## Research: what #21 (YAN-136) already shipped

All six providers already have `features.liveModels: true`, a resolver in
`src/lib/providerModels/liveResolvers.js` shared by `GET /api/providers/[id]/models`
and `/v1/models`, the `useLiveCatalog` dashboard list, the generic `FetchModelsButton`,
and the filter bar for catalogs over 30 models (applies to Cline). The bespoke
`handleImportQoderModels` / `handleImportClineModels` handlers are gone; the `qoder/`
prefix is a per-provider normalizer (`LIVE_ID_NORMALIZERS`) and `/v1/models` strips it
too (`stripProviderPrefix`), with a test guarding `qoder/qoder/`.

| Issue                                              | Gap left                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| YAN-145 Kiro                                       | Rows show no context window; no test that a refresh during the live fetch is persisted |
| YAN-146 Grok CLI                                   | No test that the shared resolver passes the connection proxy and keeps the warning     |
| YAN-147 Qoder                                      | Dashboard route drops hidden (`enable:false`) models instead of marking them           |
| YAN-148 Cline / YAN-149 ClinePass / YAN-150 Kimchi | No resolver-level fallback test (empty/failed upstream gives `[]` + warning)           |

## Design

- **Model row meta (all providers):** `ModelRow` shows `200k ctx` from `contextLength`.
  Static entries already carry it, so every provider gains it; nothing else changes.
- **Kiro multiplier:** live names already end in `(1.3x credit)` when the multiplier
  isn't 1 (`formatDisplayName` in `kiroModels.js`), and the row shows the name, so no
  separate chip.
- **Qoder hidden:** the dashboard route still drops hidden entries by default (model
  picker, Basic Chat, test-models unchanged), but `?hidden=1` keeps them with
  `hidden: true`. The provider page asks for it and the row shows a "Hidden" tag ("Not
  offered in the provider's own model picker; still routable"). Fetch Models never
  imports hidden ids. Codex `visibility: hide` entries get the same treatment.

## Changes

1. `src/app/api/providers/[id]/models/route.js`: `?hidden=1` opt-in.
2. `useLiveCatalog.js`: request `hidden=1`. `liveModels.js`: `selectModelsToImport`
   skips hidden.
3. `src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js`: context and hidden chips.
4. Tests: update the Qoder hidden test and import selection; new
   `tests/unit/live-catalog-provider-resolvers.test.js` (Kiro refresh persisted, Grok CLI
   proxy + warning, Cline/ClinePass/Kimchi fallback).

## Not done

- Collapsing the three `qoder/` prefix strips into one helper: they live on both sides of
  the client/server split and are covered by tests; not worth the churn.
