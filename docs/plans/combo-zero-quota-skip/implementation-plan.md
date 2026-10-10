# YAN-384 implementation plan

## Decision

Fix at shared account selector (`getProviderCredentials`), not at each combo strategy: every member, nested combo, fusion panel/judge and capacity adapter calls this before upstream. A known exhausted connection is ineligible under every strategy; a missing snapshot remains eligible. Preserve existing 503 `allRateLimited` response and `Retry-After` to avoid changing client contracts. Poll all eligible combo providers without changing `isWeightedProvider` semantics. Extend usage-window normalization for common unrecognized quota rows where safe; model-specific unknown rows remain fail-open. Exclude only known 0, not below-floor or manual weight 0.

## Batch A (parallel)

1. **Snapshot decision** — `open-sse/services/quotaSnapshot.js` and focused `tests/unit/quota-snapshot.test.js`. Add pure `getExhaustedUntil(snapshot, model, nowMs)` for live applicable exhausted windows. Reuse model matching and window expiry; bound re-probe (short on no reset, 30 min on distant reset), preserve `getHeadroom`/weight output shapes. Validate targeted test.
2. **Poller coverage** — `src/shared/services/weightedTargets.js`, `src/shared/services/quotaSnapshotPoller.js`, `src/shared/services/initializeApp.js`, `src/app/api/settings/route.js`, `src/app/api/combos/route.js`, `src/app/api/combos/[id]/route.js`, focused poller tests. Target any combo provider; preserve weighted-specific tier checks. Start/stop on combo CRUD. Validate targeted tests.
3. **Usage mapping** — `src/sse/services/quotaSnapshotSync.js` and focused `tests/unit/quota-snapshot-poller.test.js` (coordinate with task 2: no same-file edits; use separate test if needed). Extend known global quota names for providers whose usage API shows 0 but snapshot mapper currently ignores them (Kimi, GLM, MiniMax, iFlow, OpenCode Go, Grok CLI, etc.); never guess unknown model-specific names. Validate targeted tests.

## Batch B

1. **Selector** — `src/sse/services/auth.js` and `tests/unit/weighted-account-selection.test.js`. Exclude connection when snapshot.provider matches and `getExhaustedUntil` returns future time, ahead of preferred or weighted pick. Collect earliest expiry across locks, quota, Antigravity cache; no upstream when all blocked, set clear `lastError`. Verify fill-first, round-robin, weighted, model scope, unknown/stale, all exhausted; preserve Antigravity tests.

## Batch C

1. Review code (`code-reviewer`), fix findings, run focused tests, lint, build, full `npm test` baseline gate because app code changed. Check git diff and issue linkage. Commit conventional, push branch, PR to master with `Closes #250`, review PR and fix issues; watch CI green, squash merge, cleanup branch/worktree, mark YAN-384 Done.

## Risks

Some providers expose no usable quota API or header; remain fail-open and still rely on 429 locks. A zero reading might be stale or provider-specific; bounded reprobe limits false suppression. Real secrets are never copied to tests or commits. UI's 0% display may use quota names that cannot safely map to global/model windows; document gaps rather than assume scope.
