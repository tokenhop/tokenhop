# YAN-336 — tokenhop brand keys in all 34 locales

Target: v1.0.0 (trunk `master`, no backport). Trunk landing: behind the brand
switch. Branch `rebrand/yan-336-i18n-literals`. GitHub #206.

## Invariant

Default brand unchanged: every existing key and value in
`public/i18n/literals/*.json` stays byte-identical. Only new keys are added.

## Input

`docs/rebrand/i18n-changes.json` (untracked, from YAN-335): 44 `from → to`
pairs. Cross-checked: `NEXT_PUBLIC_BRAND=tokenhop node scripts/i18n-literals.mjs
--json` extracts exactly the 44 `to` literals the default brand doesn't, and
every `to` is `from` with `9router` (any case) → `tokenhop`.

## Design

1. **Values.** For each locale and pair, the new value is the `from` value with
   `9Router`/`9router` → `tokenhop` (never translated, always lowercase), then
   brand-adjacent grammar fixed by hand where the old form inflected:
   - fi/hu/cs: case endings attach to the stem (`9Routerin` → `tokenhopin`,
     `9Router-t` → `tokenhopot`, `9Routeru` → `tokenhopu`).
   - ko: particles follow the final consonant (`tokenhop` ends in ㅂ:
     를→을, 가→이, 는→은, 로→으로).
   - da/no/sv/nl/de compounds keep the hyphen (`tokenhop-hub`).
   - Articles/gender (es, fr, it, pt, ro, pl, ru, uk, el): adjust only if the
     old article agreed with "router" and reads wrong for a product name.
     Code tokens (`[model.tokenhop]`, `/model tokenhop`, `sk_…`) match the English
     key exactly. Placeholders are unchanged.
2. **Writing.** Keys inserted with the repo's locale-file format
   (`sortByKey` + 2-space JSON + trailing newline, `scripts/lib/i18n-json.mjs`).
   No MT APIs; the transform runs once, outside the repo.
3. **Keep the keys alive.** `scripts/i18n-prune-orphans.mjs` extracts with the
   active brand only, so it would class every tokenhop key as dead. It now
   treats literals extracted under every brand in `BRAND_IDS` as live.
4. **RTL** (ar, fa, he, ur): `tokenhop` is plain Latin like `9Router` was; check
   rendering in the browser, add bidi isolation only if it looks wrong.

## Verification

- `NEXT_PUBLIC_BRAND=tokenhop node scripts/i18n-literals.mjs`: missing count
  equals the default brand's (no tokenhop gap), 0 placeholder mismatches.
- One-off stdlib check (not committed; `i18n-literals.mjs` is the repo's
  equivalent): all 44 `to` keys in 34 locales, none of their values contain
  `9router`, `from` keys and values unchanged (`git diff` shows additions only).
- `i18n-prune-orphans.mjs` dry run: tokenhop keys not in the dead list.
- `npm run lint`, `npm test`, `npm run build` (both brands), `npm run lint:brand`.
- Browser, tokenhop build: en, ar, zh-CN, pt-BR, ru — sidebar, Home, CLI tools.
  Screenshots to `docs/rebrand/screenshots/YAN-336/` (main checkout, untracked).

## Out of scope

- Removing the 9router keys and the "no locale contains 9router" check
  (release window, with YAN-343).
- README translations, docs site.
