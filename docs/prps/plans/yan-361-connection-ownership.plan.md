# YAN-361: workspace ownership of provider connections and provider nodes

Trunk landing: **behind the switch** (`TOKENHOP_MULTI_USER`). Switch off = today.

## Design

1. **Migration 005 `connection-ownership`** (additive, ships anytime): nullable
   `workspaceId`, `createdByUserId` on `providerConnections` and `providerNodes`;
   indexes leading with `workspaceId` (`idx_pc_ws_provider`, `idx_pn_ws_type`).
2. **Backfill at switch-on, not in the migration**: Default exists only after the
   YAN-356 bootstrap. `bootstrapOwnerUnscoped` adopts ownerless rows into
   Default + owner in its transaction; `ensureOwnerBootstrap` re-runs the
   idempotent adoption once per process for installs bootstrapped earlier.
   Unscoped writers (OAuth flows, imports) stamp `_meta.defaultWorkspaceId`, so
   NULL only exists before bootstrap.
3. **NOT NULL rebuild deferred**: a DDL `NOT NULL` can't hold while switch-off
   installs (no Default) keep writing rows. The scoped repo always stamps the
   workspace; the rebuild moves to the switch flip (YAN-380).
4. **Repos**: system callers renamed `*Unscoped` (tenancy guard). New `ctx` API:
   `listConnections / getConnection / createConnection / updateConnection /
deleteConnection`, `listNodes / getNode / createNode / updateNode / deleteNode`.
   Every lookup joins `memberships` on `ctx.userId` (IDOR-safe); a passed
   `workspaceId` is a selector re-verified by SQL.
5. **Dedup + priority partition by workspace** (`workspaceId IS ?`).
6. **Node prefixes** unique per workspace (scoped create/update, 409). Gateway
   resolution stays global until YAN-368 (no gateway principal before YAN-363).
7. **Routes** `api/providers/*`, `api/provider-nodes/*`: route rows get
   `scoped: true` (guard: capability held in some workspace); handlers check the
   capability on the row's workspace. Selector `?workspaceId=`, default Default
   when a member, else the active workspace. Secret stripping unchanged.
8. Tenancy guard: both tables `scoped` (`workspaceId`). Usage views
   (`getUsageStats`, `getRecentLogs`) allow-listed until YAN-370.

## Tests (critical only)

`tests/unit/connection-ownership.test.js`: migration fixture + adoption,
cross-workspace negatives (list/get/update/delete/test), same-email dedup split,
per-workspace priority, node prefix + node IDOR, no secrets to a non-creator,
switch-off regression.
