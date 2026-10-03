# PR Review #753 — feat(db): workspace ownership of provider connections and provider nodes

**Reviewed**: 2026-10-03
**Mode**: PR
**Author**: yandy-r
**Branch**: users/yan-361-connection-ownership → master
**Decision**: APPROVE (after fixes)

## Summary

The scoping design is sound: membership-joined lookups, per-workspace dedup and priority, an idempotent migration and adoption. With the switch on, the review found more routes that still read connections globally. Those are fixed in this PR. The two duplication nits are left open.

## Findings

### HIGH

- **[F001]** `src/app/api/media-providers/tts/{deepgram,elevenlabs,inworld,minimax}/voices/route.js:15` — Voice routes used the first active key on the instance. With the switch on, user B could spend workspace A's API key.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Select through `scopedConnections(request, "workspace.connections.use", …)`. Rows marked `scoped`.
- **[F002]** `src/app/api/models/availability/route.js:60` — `clearCooldown` updated every workspace's connections for a provider. GET listed other workspaces' locks.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Scope GET (`metadata.read`) and POST (`use`) to the selected workspace, and write through `updateConnection(ctx, …)`. Negative test added.
- **[F003]** `src/app/api/usage/[connectionId]/route.js:141` — A non-forced OAuth GET also refreshes and persists tokens, yet only needed `usage.read` (viewer). The comment was inaccurate.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Require `workspace.connections.use` and correct the comment.

### MEDIUM

- **[F004]** `src/app/api/providers/route.js:97`, `src/app/api/providers/[id]/route.js:140` — `providerSpecificData` secrets (`copilotToken`, `mimoPassToken`, `clientSecret`) were returned on `metadata.read` responses.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: `redactConnection(scope, c)` strips them when scoped. Switch off keeps today's shape. Covered by a test.
- **[F005]** `src/app/api/home/quota/route.js:18` — The quota watch listed every workspace's accounts.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Use `scopedConnections(request, "workspace.usage.read")`. Row marked `scoped`.
- **[F006]** `src/app/api/providers/route.js:129`, `src/app/api/providers/validate/route.js:29` — Node-selector logic is duplicated with different pinning.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Add a shared `nodeInWorkspace` helper when YAN-368 reworks node resolution.
- **[F007]** `src/lib/db/repos/ownership.js:44`, `connectionsRepo.js MEMBER_ROW`, `nodesRepo.js MEMBER_ROW` — The membership predicate is written in three places.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Export a join builder from `ownership.js`.

### LOW

- **[F008]** `src/app/api/providers/[id]/test-models/route.js:24` — Dead `!connection` branch after `loadScoped`.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Delete it.
- **[F009]** `src/lib/db/repos/connectionsRepo.js:231` — Leftover bare block and temp variable in `createInTx`.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Flatten it and return directly.
- **[F010]** `src/lib/users/session.js:184` — Stale "until YAN-361+" comment.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Reword to the remaining unscoped resources.
- **[F011]** `src/app/api/providers/[id]/test/route.js:20` — Scoped load followed by an unscoped re-read in `testSingleConnection`.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Comment that this is safe only while ownership is immutable (YAN-701 must pass the row).

## Validation Results

| Check      | Result                                                 |
| ---------- | ------------------------------------------------------ |
| Type check | Skipped (plain JS)                                     |
| Lint       | Pass                                                   |
| Tests      | Pass (baseline gate, `TOKENHOP_MULTI_USER` off and on) |
| Build      | Pass                                                   |

## Files Reviewed

- `src/lib/db/migrations/005-connection-ownership.js` (Added)
- `src/lib/db/repos/ownership.js` (Added)
- `src/lib/users/workspaceScope.js` (Added)
- `tests/unit/connection-ownership.test.js` (Added)
- `src/lib/db/repos/{connectionsRepo,nodesRepo,usersRepo}.js`, `src/lib/db/{index,schema,tenancy}.js` (Modified)
- `src/lib/users/{session,bootstrap,errors}.js`, `src/lib/auth/routePolicy.js`, `src/dashboardGuard.js` (Modified)
- `src/app/api/{providers,provider-nodes,usage/[connectionId],media-providers/tts/*,models/availability,home/quota}/**` (Modified)
- About 100 files: mechanical `*Unscoped` rename (Modified)
