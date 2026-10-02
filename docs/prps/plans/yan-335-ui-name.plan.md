# YAN-335 — product name in the UI (dashboard, login, landing, API messages)

Target: v1.0.0 (trunk `master`, no backport). Trunk landing: behind the brand
switch. Branch `rebrand/yan-335-ui-name`.

## Invariant

With the default brand the UI is byte-identical: every rendered English string,
and so every i18n key in `public/i18n/literals/*.json`, stays the same. Checked
by diffing `node scripts/i18n-literals.mjs --json` before/after (default brand:
identical literal set).

## Design

- Every user-visible product name reads the brand module. Original `9Router`
  spelling → `ACTIVE.name`, original `9router` spelling → `ACTIVE.slug` (both
  `tokenhop` under the tokenhop brand). Keeps default keys identical.
- Strings stay one text node: `{`Install ${ACTIVE.name}, …`}`, never
  `Install {ACTIVE.name}, …` (the runtime translates whole text nodes).
- `scripts/i18n-literals.mjs` resolves template literals whose every expression
  is a string member of `ACTIVE`/`BRAND`/`LEGACY` (values from the brand
  module, so `NEXT_PUBLIC_BRAND=tokenhop` extracts the tokenhop strings for
  YAN-336). Templates without a brand expression are still skipped. Applies to
  JSX children, translatable attributes/props, label-key object values and
  `translate()` args.
- Logos: login, landing `Navigation`/`Footer` use `BrandLockup`; `HubNode`
  renders `BrandMark` in its SVG variant (`x`/`y` props → `<g>` legacy tile or
  nested `<svg>` tokenhop mark). Brand chosen inside the brand components only.
- Data path readout: `GET /api/settings/environment` adds `databaseFile`
  (`DATA_FILE`); `DataSection` shows it instead of the hardcoded path.
- Footer (tokenhop brand only): npm link and "Based on 9Router by decolua"
  credit linking upstream. Default footer unchanged.

## Out of scope / kept

- Third-party names: the "9Router for GitHub Copilot" VS Code extension, its
  marketplace URL and its "9Router: Configure Server" command.
- Upstream-facing identifiers (`9router-combo-probe` UA), the MITM password
  salt (changing it breaks stored data), `9router-pxpipe-host` (on-disk id).
- Code comments (final sweep YAN-343), translations (YAN-336), docs.
- `npx tokenhop` on the landing: the CLI isn't on npm until YAN-341; the
  landing keeps the GHCR `docker run` command.

## Tasks

1. Extractor brand-template resolution + unit test.
2. Logos (login, Navigation, Footer, HubNode) + test that fails on legacy
   tile/wordmark markup outside `BrandMark`/`BrandLockup`.
3. Dashboard + shared copy (`src/app/(dashboard)`, `src/shared`).
4. Landing copy, metadata/manifest, API/server messages, data-path readout +
   route test.
5. Tests pinned to default strings read the brand (copy-tone allowlist,
   combo builder); brand-guard baseline lowered; `docs/rebrand/i18n-changes.json`
   (untracked) from default vs tokenhop extraction.

## Validation

`npm run lint`, `npm run lint:brand`, `npm test` and `npm run build` under both
brands, extraction diff, browser check per handbook §7 step 6.
