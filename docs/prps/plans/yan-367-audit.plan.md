# YAN-367 — feat(audit): audit log of security and administrative events

Branch: `users/yan-367-audit-log` · PR → `master` · target v1.1.0 · Closes #235 / YAN-367
Binding: handbook §5/§7/§8, spec.md, ADR-0001/0002/0003/0004/0006/0007. ADR-0002 read-capability matrix WINS over the issue's broader read scoping.

## Contracts (fixed — all lanes implement against these)

### Table `auditEvents` (Lane A)

Columns: `id` (convention per existing tables), `ts` (now, indexed), `actorUserId` NULL, `actorApiKeyId` NULL, `via` NULL ("session"|"apiKey"|"cli"|"local"|"system"), `ip` NULL, `workspaceId` NULL, `action` NOT NULL, `targetType` NULL, `targetId` NULL, `before` NULL (JSON string), `after` NULL (JSON string), `result` NULL ("success"|"failure"|"denied").
Indexes: `(workspaceId, ts)`, `(actorUserId, ts)`. Migration `010-audit-events.js`, idempotent, additive; registered in migrations/index.js; TABLES entry must match chain; TABLE_CLASSES entry must pass tenancy-guard test.

### Repo (Lane A)

```js
auditRepo.insert(event) -> row            // event = full row minus id/ts (ts defaults now)
auditRepo.list({ page, pageSize, workspaceId, actorUserId, action, targetType, targetId, fromTs, toTs })
  -> { events, pagination: { page, pageSize, totalItems, totalPages } }   // mirror requestDetailsRepo
auditRepo.pruneOlderThan(days) -> count
```

Export via `src/lib/db/index.js` barrel.

### Helper (Lane B) — `src/lib/users/audit.js`

```js
audit(ctx, action, target, { before, after, result });
// ctx: { principal?: { userId, apiKeyId, via } | null, ip?: string, request?: Request, workspaceId?: string|null }
// action: "resource.verb" camelCase. target: { type, id }. result default "success".
```

Redaction DENY-BY-DEFAULT allow-list: only explicitly permitted keys persist in before/after (id, ids, name, email, provider, role, status, workspaceId, userId, keyId, keyPrefix, allowedModels, enabled, login, reason, days, from, to, count, method, path, capability, keyNames, masked values). Secret-shaped keys (token, password, secret, key material, cookie, session, apiKey, refreshToken, accessToken, oidcClientSecret, saml*, mitmSudo…) never persist. 4KB truncate per field. NEVER throws (console.warn on failure). Recording is NOT switch-gated; with the switch off principal is null → actor fields null.

### Action taxonomy

`auth.login`, `auth.loginFailed`, `auth.denied`, `auth.ssoLink`, `auth.passwordChange`,
`user.passwordChange`, `instance.bootstrap`, `instance.ownership.transfer`,
`membership.add|roleChange|remove`, `key.create|update|revoke`,
`connection.create|delete`, `settings.update`, `db.export|import`, `config.export|import`,
`hostOps.shutdown|tunnel|mitm|pxpipe`.

## Lanes (no file overlaps)

- **A DB core**: migrations/010 + index registration, schema.js, tenancy.js, repos/auditRepo.js, db/index.js barrel; tests audit-repo + existing db tests green.
- **B auth/user wiring**: users/audit.js, login route, oidc/callback, saml/acs, users/bootstrap.js (resolveSsoUser), dashboardGuard.js checkApiPolicy (403/401 denials), session.js authorize() denial, usersRepo (transferOwnership, bootstrapOwnerUnscoped), membershipsRepo; tests redaction + auth-events.
- **C management wiring**: apiKeyManagement, connectionsRepo (ctx fns only), settings/route.js PATCH (keyNames diff, secrets name-only; owner password change → user.passwordChange), settings/database, settings/config/{export,import}, shutdown, version/shutdown, tunnel enable/disable + tailscale-*, cli-tools/antigravity-mitm, pxpipe; tests management-events.
- **D read API + retention**: routePolicy.js row (GET /api/audit, cap instance.audit.read, alwaysProtected), src/app/api/audit/route.js (requireMultiUser 404 gate; owner/admin only per ADR-0002; filters+pagination mirror usage/request-details), settingsRepo default `auditRetentionDays: 365` (+settingsConfigDoc if declared there), initializeApp daily sweep (setInterval 24h .unref() + deferred first sweep) + boot hostOps.mitm/tunnel events (via "system", actor null); tests read-api (admin ok, user B denied, off-switch 404, prune).

## DoD gate (orchestrator, sequential)

lint · `npm test` both `TOKENHOP_MULTI_USER=off/on` · `npm run build` · brand guard · ≤500 lines/file · no new deps · cross-workspace negatives · single-user regression · route-policy + tenancy-guard tests green.

## Deliberate deviations (→ PR Decisions)

1. Read API owner/admin only (ADR-0002 fixed matrix; issue's ws/user self-read scoping needs an ADR-0002 amendment — flagged, not implemented).
2. `key.rotate`, `connectionGrant.*`, budget events, invitations, KEK rotation: call sites don't exist yet (YAN-360/363-rotate/369/372/365) — taxonomy and helper ready; those issues wire emissions.
3. Boot-time host ops emitted with `via:"system"`, actor null.
