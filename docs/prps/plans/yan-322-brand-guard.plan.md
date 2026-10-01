# YAN-322 — brand-literal guard with a shrinking allowlist

Target: v1.0.0 (trunk `master`, no backport). Trunk landing: ships anytime.

## Design

- `scripts/brand-guard.mjs`, stdlib only. `git grep -z -n -I -i -E` via
  `execFileSync` (no shell) over tracked files; per-match occurrence count per
  file.
- Path allowlist = git `:(glob,exclude)` pathspecs, each with a reason. Line
  allowlist = lines containing `legacy(9router)` or the upstream `decolua`
  credit.
- Ratchet: `scripts/brand-guard.baseline.json` holds per-file counts. A new
  file or a higher count fails with a diff; lower counts pass with a hint.
  `--update` rewrites the baseline only when nothing went up.
- Output: `brand-guard: N occurrences in M files remaining (baseline X). OK|FAIL`.
- Wiring: `npm run lint:brand`, plus a `Brand guard` job in `lint.yml` (PRs and
  pushes to `master`; no `npm ci`, stdlib only).

## Decisions

- The whole brand module (`src/shared/brand/**`) is allowlisted, not just the
  `LEGACY` block: handbook §3.3/§8 name the module as the one place legacy
  literals live.
- Upstream credit is matched by line (`decolua`) anywhere, not only in READMEs,
  so references to upstream issues stay legal.
- The guard's own files (script, baseline, test) are allowlisted: they must
  contain the pattern.
- Legacy fixtures folder: `tests/fixtures/legacy/**`. Docs-site copy of the
  upgrade guide: `gitbook/content/**/upgrading*`.

## Tasks

1. `tests/unit/brand-guard.test.js` against a `git init` fixture repo in a temp
   dir: new file fails, increase fails, decrease passes, allowlisted lines and
   paths pass, `--update` refuses increases, `.gitignore`d files ignored.
2. `scripts/brand-guard.mjs`.
3. Generate the baseline from `origin/master`.
4. `lint:brand` script and the CI job.

## Validation

`npm run lint`, `npm run lint:brand`, `npx vitest run unit/brand-guard.test.js`,
`npm test` (baseline gate). No app code changes, so no build or tokenhop-brand
run is needed beyond CI.
