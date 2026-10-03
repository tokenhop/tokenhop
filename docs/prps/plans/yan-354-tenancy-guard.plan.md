# YAN-354 — tenancy classification guard and cross-workspace test harness

Target: v1.1.0 (trunk `master`, no backport). Trunk landing: ships anytime —
tests and a registry module nothing imports at runtime; inert with the switch
off (handbook §5). Sources: `docs/users/README.md` §4/§7/§8, spec row 1,
ADR-0001 classification table.

## Design

1. **Registry** `src/lib/db/tenancy.js` (pure data + one pure function):
   - `TABLE_CLASSES`: every `TABLES` entry →
     `{ class, scopeColumn?, issue?, note? }`. Classes:
     `scoped` (has `scopeColumn`), `instance` (admin-only), `system`,
     `usage-attribution` (usage rows, scoped views in YAN-370), `pending-scope`
     (owned today, scoped by the named issue; must reach zero by M3).
     - scoped: `identities` (`userId`), `memberships` (`workspaceId`),
       `workspaces` (`id`, membership join).
     - instance: `users` (admin-managed; self reads via `getUser(ctx)`),
       `proxyPools`.
     - system: `_meta`.
     - attribution: `usageHistory`, `usageDaily`, `requestDetails` (YAN-370).
     - pending-scope: `providerConnections`, `providerNodes` (YAN-361),
       `combos` (YAN-364), `apiKeys` (YAN-363), `settings` (split, YAN-362),
       `kv` (classified per scope below).
   - `KV_SCOPE_CLASSES`: `modelAliases`, `customModels`, `mitmAlias`,
     `disabledModels`, `cliToolSettings`, `cliToolPresets` → pending-scope
     (YAN-364 / YAN-374, `ws:<id>/` prefix); `pricing` → instance;
     `gemini_thought_signatures` → system (opaque upstream signature cache).
   - `findUnclassified({ tables, kvScopes })` → `{ tables: [], kvScopes: [] }`.
2. **Guard test** `tests/unit/tenancy-guard.test.js`:
   - Live schema: tables from `sqlite_master` of the app's migrated DB (minus
     `sqlite_%`) → `findUnclassified` is empty.
   - kv scopes from a static scan of `src/` + `open-sse/` (`makeKv("x")`,
     `scope = 'x'`, `SCOPE = "x"`) → all classified. A floor assert keeps the
     scan from silently matching nothing.
   - Negative fixture: `CREATE TABLE rogue` in a throwaway sql.js DB and an
     unknown kv scope → both reported.
   - Repo lint over `src/lib/db/repos/*.js`: each exported function's SQL
     tables (`FROM|JOIN|INTO|UPDATE <t>`), kv scopes (literal scope or a
     `makeKv` binding), resolved through same-file function calls; any that
     touches a `scoped` table/kv scope must take `ctx` first or end in
     `Unscoped`. Allowlist with reasons: `membershipRole`,
     `assertNotLastManager` (sync in-transaction helpers; callers scope).
     Negative fixture: a source string with an unscoped reader → flagged.
3. **Harness** `tests/setup/tenancyHarness.js`:
   - `seedTenancy()` clears the tenancy tables, then seeds owner A, user B,
     their personal workspaces, a shared workspace (A owner, B member) and
     returns `{ a, b, shared }`; each user `{ user, ctx, personal }`.
   - `callRoute(handler, path, { as, method, body, params })`: `as` is a
     seeded user (session cookie `auth_token` with ADR-0004 claims `sub`,
     `sv`, `wid`) or `{ apiKey }` (Bearer). Builds a `NextRequest`.
   - `denied(promiseOrFn)`: true when the result is null/false/empty or a
     `TenancyError` `NOT_FOUND`/`FORBIDDEN`.
4. **Sample negative tests** `tests/unit/tenancy-isolation.test.js`: B can't
   get, list, rename, delete A's personal workspace or list its members; B
   sees the shared one; `callRoute` sends the right principal.
5. **Docs**: `tests/README.md` section (guard, harness usage, isolation matrix
   template for PR bodies).
6. `npm test` already runs `tests/unit/**` under the baseline gate (empty
   known-fails), so both files are must-pass. No new script or CI job.

## Validation

`npm run lint`, `npm test` with `TOKENHOP_MULTI_USER=off` and `=on`,
`npm run build`, `npm run lint:brand`.
