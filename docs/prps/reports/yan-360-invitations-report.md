# YAN-360 Invitations and user lifecycle report

## Delivered

Server-side user lifecycle, workspace membership, invitation, acceptance, and ownership-transfer APIs. Feature routes are multi-user-switch gated; no UI or email delivery added. Invitation token is returned once to operator for out-of-band relay.

## Adversarial fixes

- Blocked live inviter and pending-user unauthorized operations.
- Enforced streamed request byte cap.
- Made ownership transfer require `currentPassword`; SSO-only owner transfer fails closed.
- Encrypted SSO invitation state cookie, cleaned it early, and required verified SAML email where email binding applies.
- Counted pending managers in lifecycle checks.
- Bound SSO-only invitation acceptance to verified callback identity.

Broad reviewer runs failed; targeted reviews and parent adversarial checks found and fixed issues. Do not treat these as broad reviewer approval.

## Validation evidence

- `npm run lint`: passed.
- `npm run lint:brand`: passed.
- `npm run build`: passed.
- Full `npm test` with multi-user mode off: passed.
- Full `npm test` with `TOKENHOP_MULTI_USER=on` (isolated run): passed, exit 0, no regression. An earlier full run on the same suite hit an unrelated `usage-dispatch` 5000 ms timeout during a concurrent build; three focused retries passed, and the final isolated run confirms the full suite with the switch on passes.

Both switch states pass the full suite.

## Artifacts

- [Archived plan](../plans/completed/yan-360-invitations.plan.md)
- [Feature guide](../../features/users-lifecycle.doc.md)

## Scope

Documentation finalization, plan archive, and this report are included in the single feature commit on `users/yan-360-invitations`. No push or pull request was made from this run.
