# YAN-363 next batch contracts

Status: **implementation underway**. P0 crypto is **under safety repair, not accepted**. No lane may activate migration or claim acceptance. Parent integrates lane outputs and owns validation across integrated changes. Research reports remain unchanged.

## Settled decisions and constraints

- Preserve existing key capability map: members create own user keys; managers list/manage keys and may manage service keys; viewers do not list keys. Hashed creation remains explicit; no silent provisioning.
- D2: ambiguous presets stop migration without mutation, preserving data. Report record identities/names, never raw values.
- Require full functional parity for authorized operations. No blanket refusal of a supported operation as an implementation substitute.
- Remote MITM credential comes from operator-managed environment/file/secret injected at parent startup; keep it in parent memory for child restart. Local internal key is fresh for every spawn.
- Restore original master separately. Mismatch fails during preflight before mutation; do not replace master or mutate live data.
- Old video jobs: unrestricted keys may poll through an authorized workspace connection. Restricted keys require recorded or owner-confirmed model. Map every new job. No global fallback.
- Q1 remains explicit information-limit exception: hashing makes old full raw values irrecoverable; expose prefix only afterward.
- No whole sibling issue prerequisite, no implied sibling Done; implement only bounded compatibility overlaps.

## Exact ownership lanes

Every listed path is the lane's entire write set. Paths are under `src/lib` unless path explicitly starts `tests/`. Tests live under `tests/unit`. No additional edits or incidental formatting. Parent handles integration and cross-lane validation.

| Lane                 | Exact write set                                                                                                                                                                                                                                  | Contract                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage              | `src/lib/db/apiKeyState.js`; existing `src/lib/db/schema.js`; existing `src/lib/db/repos/apiKeysRepo.js`; existing `src/lib/db/repos/usersRepo.js`; existing `src/lib/db/repos/membershipsRepo.js`; new `tests/unit/gateway-key-storage.test.js` | Define isolated storage/state and repository contracts using current adapter/schema/repo patterns. Preserve user/service distinction, durable state semantics, and lifecycle safety. No schema migration activation.                                                       |
| Usage identity       | New `src/lib/db/helpers/usageKeyIdentity.js`; new `tests/unit/gateway-key-usage-identity.test.js`                                                                                                                                                | Pure identity normalization for usage compatibility: retain key IDs where known, pseudonymize deleted/unknown bearer identity without persisting raw bearer. No usage-repo/sink edits in this lane.                                                                        |
| MITM credentials     | New `src/lib/mitm/runtimeCredentials.js`; existing `src/mitm/handlers/base.js`; new `tests/unit/mitm-runtime-credentials.test.js`                                                                                                                | Runtime handoff contract: local internal credential fresh each spawn; remote credential supplied through trusted startup environment/file/secret source and held only in parent memory for child restart. Do not persist/read back secret or forward local token remotely. |
| Crypto safety repair | Existing `src/lib/security/masterKey.js` only; new `tests/unit/gateway-key-crypto.test.js`                                                                                                                                                       | Repair P0 safety findings solely in crypto module and its test. No other path changes. P0 remains unaccepted until parent review and evidence.                                                                                                                             |

## Explicitly out of batch

No migration activation, registration, barrel, startup, UI, tracker, commit, or research-report changes. No scope expansion beyond manifests above. No implicit ownership of adjacent files. Parent integrates lane outputs, resolves conflicts, and performs batch-level validation.

## Verification ownership

Each lane adds focused isolated tests for its contract. Parent integrates and validates using the repository test configuration (`npx vitest run -c tests/vitest.config.js ...` or `npm test`); do not run tests without isolated config. Documentation lane validates only consistency of this contract against feature spec and plan. No implementation, test, review, or acceptance claim is made here.
