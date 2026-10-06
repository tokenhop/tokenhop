# YAN-365 Envelope Encryption of Credentials at Rest report

## Delivered

Encrypted covered connection, provider-node and instance-setting secrets at rest with per-workspace DEKs wrapped by the instance master key. Delivered backup-gated activation and live plaintext cleanup, fail-closed startup recovery, refresh-safe credential persistence, workspace deletion key purge, KEK and per-workspace DEK rotation, owner-only CLI/API operations, and encrypted v3 export/import with preflight proof. Never-enabled switch-off installs remain unchanged; established encryption stays active independent of switch state.

## Adversarial fixes

- **B1:** Removed stray markers from codec/state/storage implementation.
- **B2:** Fixed import boundaries, stale PSD/OIDC catch behavior and settings envelope return path.
- **B3:** Established encrypted recovery loads master with `create: false`; it cannot regenerate missing key.
- **B4:** Reject symlinked `keys/` directory.
- **B5:** Require strict durable flush and purge MITM plaintext during activation cleanup.
- **Pre-PR CRITICAL:** Blocked plaintext restore bypass via `credentialEncryption: {}`; encrypted instances require exact v3 format before any destructive import work.
- **Pre-PR HIGH:** Closed rotate-during-import race through maintenance admission and state revalidation.
- Fixed CLI error handling and timeout behavior.

## Validation evidence

- `npm run lint`: passed.
- `npm run lint:brand`: passed.
- `npm run build`: passed.
- Dependency changes: none.
- **Full suite:** `npm test` passed with `TOKENHOP_MULTI_USER=off` and `=on`: "No regression (now fails=0, baseline known=0)" in both. Earlier full runs under heavy host load (load average 77-135 on 40 cores) hit timeout-only failures; every affected file passed in isolation, and the final low-load run was clean.

## Known residuals

- Older backups and exports contain plaintext; activation backup also deliberately preserves pre-encryption state.
- Untyped refresh errors return `false`.
- `better-sqlite3` is not included in the crash matrix on Node 24.
- Proxy pools remain plaintext; follow-up discovery is still needed for `proxyPools.data` and credential-bearing URLs.
- Pre-existing `usage/[connectionId]` full-object response on master flagged for follow-up.
- ADR-0005 and ADR-0008 amendments in `docs/plans/yan-365-envelope-encryption/decisions.md` must be copied into the main-checkout ADRs.

## Artifacts

- [Archived plan](../plans/completed/yan-365-envelope-encryption.plan.md)
- [Operator feature guide](../../features/credential-encryption.doc.md)
- [YAN-365 design decisions and planning artifacts](../../plans/yan-365-envelope-encryption/)
