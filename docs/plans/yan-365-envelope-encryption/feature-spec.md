# Feature Spec: YAN-365 Envelope Encryption of Credentials at Rest

## Executive Summary

YAN-365 encrypts stored provider, node, SSO and MITM secrets so leaked DB files, backups and exports stop exposing credentials. Node `crypto` AES-256-GCM per-workspace DEKs, wrapped by the YAN-363 master KEK, protect field envelopes bound to table, row, workspace and field. Activation runs only after switch-on behind verified backup, then stays permanent regardless of switch. Integration touches repositories, gateway raw reads, settings, MITM, startup, transfer, rotation APIs and CLI. Main risks: missed writers, rotation breaking gateway hashes, crash-unsafe key publication, and plaintext surviving older copies.

## External Dependencies

### APIs and Services

#### Node.js `crypto` (runtime built-in)

- **Documentation**: [Node crypto API](https://nodejs.org/docs/latest-v24.x/api/crypto.html)
- **Authentication**: none (in-process library)
- **Key Endpoints**:
  - `createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 })` / `createDecipheriv`: field and DEK encryption
  - `setAAD` (before `update`), `getAuthTag` / `setAuthTag` (before `final`): integrity binding
  - `randomBytes`, `hkdfSync`: keys, IVs, hash-key derivation
- **Rate Limits**: none; NIST caps random-IV GCM at 2^32 encryptions per key, unreachable per workspace
- **Pricing**: free

#### SQLite via existing adapter chain

- **Documentation**: [SQLite WAL](https://www.sqlite.org/wal.html), [VACUUM](https://www.sqlite.org/lang_vacuum.html)
- **Authentication**: file permissions under `DATA_DIR`
- **Key Endpoints**:
  - `PRAGMA wal_checkpoint(TRUNCATE)`, `VACUUM`: post-activation plaintext page cleanup
  - `PRAGMA synchronous = FULL`, sql.js `flushSync`: durable commit before key publication
- **Rate Limits**: single writer process (`processLock.js`)
- **Pricing**: free

### Libraries and SDKs

| Library                                                                            | Version                      | Purpose                              | Installation                      |
| ---------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------ | --------------------------------- |
| `node:crypto`                                                                      | Node per `.nvmrc`            | AES-256-GCM, HKDF, randomness        | built-in, no install              |
| existing SQLite adapters (`bun:sqlite`, `better-sqlite3`, `node:sqlite`, `sql.js`) | current lockfile             | storage, transactions, backup verify | already installed (`npm install`) |
| `vitest` (tests package)                                                           | current `tests/package.json` | verification                         | `cd tests && npm install`         |

No new dependencies (handbook §8).

### External Documentation

- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html): envelope design, KEK separate from data
- [OWASP Key Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html): rewrap-on-KEK-retirement, backups need retained keys, erasure limits
- [Google Cloud KMS AAD](https://cloud.google.com/kms/docs/additional-authenticated-data): AAD as anti-confused-deputy binding
- [NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final): GCM IV and usage limits

## Business Requirements

### User Stories

**Primary User: Instance owner**

- As an owner enabling multi-user, I want existing credentials encrypted after a verified backup so that a stolen DB or backup leaks no tokens.
- As an owner, I want CLI and admin-API KEK rotation so that a suspected root exposure is remediated without breaking gateway API keys.
- As an owner restoring a backup, I want a wrong or missing key rejected before anything is wiped so that a bad restore never destroys live data.

**Secondary User: Workspace members and single-user operators**

- As a workspace member, I want my provider credentials usable only through my workspace so that other workspaces cannot read, swap or reuse them.
- As a single-user operator who never enables multi-user, I want an upgrade to change nothing so that no key backup duty appears unexpectedly.

### Business Rules

1. **Never-enabled off is unchanged**: switch off and no marker means no master, DEKs, backups, envelopes or new routes.
   - Validation: byte-identical fixture comparison; 404 on new routes.
   - Exception: additive empty schema may ship.
2. **Established encryption is permanent**: durable marker governs storage regardless of `TOKENHOP_MULTI_USER` ([decisions D4](decisions.md)).
3. **Fail closed on keys**: missing/wrong/corrupt KEK blocks readiness; no regeneration, no plaintext fallback (D3).
4. **AAD binding**: `v1|table|rowId|workspaceId|field`, delimiter/control characters rejected, exact vectors (D1).
5. **Ownership preserved**: rows encrypt under their own workspace DEK; only ownerless rows adopt Default.
6. **Default undeletable unconditionally**: 409 with zero mutation (D5).
7. **Gateway keys survive KEK rotation**: derived hash key wrapped under KEK; hash kid decoupled from KEK kid (D6).
8. **Env-managed KEK**: automatic KEK rotation refused with guidance; DEK rotation allowed (D9).
9. **Owner-only key operations**: KEK and DEK rotation require instance owner; nothing secret crosses HTTP.
10. **Honest shredding**: live DEK deletion only; older copies documented (D7).

### Edge Cases

| Scenario                                            | Expected Behavior                                       | Notes                               |
| --------------------------------------------------- | ------------------------------------------------------- | ----------------------------------- |
| Switch turned off after activation                  | Reads decrypt, writes encrypt, missing key fails closed | D4 latch                            |
| Crash mid-activation                                | DB unchanged plus backup; rerun idempotent              | single sync transaction             |
| Crash after commit, before VACUUM                   | Restart finishes cleanup before readiness               | cleanup-pending marker              |
| Crash between DB rewrap and key rename              | Restart recovery promotes staged matching key           | never infer from staging file alone |
| Legacy MITM value undecryptable                     | Activation aborts with re-entry guidance                | D11                                 |
| Plaintext export imported into encrypted instance   | Rejected, zero mutation                                 | D8                                  |
| Delete workspace while refresh in flight            | Serialized; no key resurrection from cache              | live-row check on cache hit         |
| Env `TOKENHOP_MASTER_KEY` set, KEK rotate requested | 409 `KEK_ENV_MANAGED`, guidance                         | D9                                  |
| Proxy pool URL containing password                  | Remains plaintext; flagged in PR                        | D10 discovery                       |

### Success Criteria

- [ ] No covered sentinel in live DB, WAL or post-activation backup/export (C1)
- [ ] Every tamper, AAD component and field/row/table swap fails (C2)
- [ ] Idempotent migration preserving ownership (C3)
- [ ] Wrong/missing KEK rejects before destructive import (C4)
- [ ] KEK rotation + restart: existing gateway keys authenticate (C5)
- [ ] Default DEK rotation re-encrypts instance secrets (C6)
- [ ] Cache eviction, workspace delete, Default protected (C7)
- [ ] Real refresh merges encrypted row atomically (C8)
- [ ] Same-KEK ciphertext export/import recovers (C9)
- [ ] Never-enabled off unchanged; established stays protected off (C10)
- [ ] Full gate: lint, `npm test` off/on, build, `lint:brand`; see [verification.md](verification.md)

## Technical Specifications

### Architecture Overview

```text
startupReadiness ──▶ masterKey.js (env | DATA_DIR/keys/master)
      │                     │
      ▼                     ▼
activateCredentialEncryption ──▶ envelope codec + bounded DEK cache
      │                                   ▲
      ▼                                   │
SQLite (rows, workspaceKeys, _meta) ◀── repos: connections / nodes / settings
      ▲                                   ▲
      │                                   │
transfer (export/import)          gatewayResources raw reads, refresh, MITM
      ▲
rotation service ◀── POST /api/settings/keys/rotate, /api/workspaces/[id]/keys/rotate, tokenhop keys rotate
```

### Data Models

#### workspaceKeys

| Field       | Type | Constraints                               | Description             |
| ----------- | ---- | ----------------------------------------- | ----------------------- |
| workspaceId | TEXT | PK, FK `workspaces(id)` ON DELETE CASCADE | owning workspace        |
| kid         | TEXT | NOT NULL                                  | random DEK id           |
| wrappedDek  | TEXT | NOT NULL                                  | envelope JSON under KEK |
| createdAt   | TEXT | NOT NULL                                  | ISO timestamp           |

**Indexes:**

- primary key on `workspaceId`: one active DEK per workspace

**Relationships:**

- cascade-deleted with workspace; classified `scoped` in `src/lib/db/tenancy.js`

#### `_meta` encryption state

| Field                       | Type | Constraints | Description                  |
| --------------------------- | ---- | ----------- | ---------------------------- |
| credentialsEncryptedVersion | TEXT | `"1"`       | latch                        |
| credentialsKekKid           | TEXT | 16 hex      | current KEK identity         |
| apiKeyHashKeyWrapped        | TEXT | envelope    | derived hash key under KEK   |
| credentialsCleanupPending   | TEXT | optional    | physical cleanup unfinished  |
| apiKeysHashKid              | TEXT | frozen      | hash-key identity (existing) |

Envelope shape:

```json
{
  "v": 1,
  "kid": "dk_0123456789abcdef",
  "iv": "base64 12 bytes",
  "ct": "base64",
  "tag": "base64 16 bytes"
}
```

### API Design

#### `POST /api/settings/keys/rotate`

**Purpose**: rotate KEK; rewrap all DEKs and the API-key hash key.
**Authentication**: required; instance owner session or loopback CLI owner token; `multiUserOnly`, `alwaysProtected`.

**Request:**

```json
{}
```

**Response (200):**

```json
{ "kekKid": "string - new public key id", "workspacesRewrapped": "number", "verified": "boolean" }
```

**Errors:**

| Status | Condition                                    | Response                                                 |
| ------ | -------------------------------------------- | -------------------------------------------------------- |
| 401    | unauthenticated                              | `{ "error": { "code": "UNAUTHORIZED" } }`                |
| 403    | non-owner                                    | `{ "error": { "code": "FORBIDDEN" } }`                   |
| 404    | rollout switch off (all new rotation routes) | `{ "error": "Not found" }`                               |
| 409    | env-managed KEK or operation in progress     | `{ "error": { "code": "KEK_ENV_MANAGED" or "LOCKED" } }` |
| 503    | key missing/mismatch/integrity               | `{ "error": { "code": "KEY_UNAVAILABLE" } }`             |

#### `POST /api/workspaces/[id]/keys/rotate`

**Purpose**: new DEK for one workspace; re-encrypt its fields (Default includes instance settings).
**Authentication**: instance owner.

**Response (200):**

```json
{ "workspaceId": "string", "dekKid": "string", "fieldsReencrypted": "number" }
```

**Errors:**

| Status | Condition                          | Response    |
| ------ | ---------------------------------- | ----------- |
| 403    | non-owner                          | `FORBIDDEN` |
| 404    | unknown workspace or switch hidden | `Not found` |
| 409    | maintenance lock held              | `LOCKED`    |

CLI: `tokenhop keys rotate [--workspace <id>] [--port <port>]` calls these routes over loopback.

### System Integration

#### Files to Create

- `src/lib/security/envelope.js`: codec, AAD builder, wrap/unwrap, bounded DEK cache
- `src/lib/db/credentialEncryptionState.js`: strict marker read/validate
- `src/lib/db/activateCredentialEncryption.js`: backup-gated activation + cleanup
- `src/lib/security/keyRotation.js`: KEK staged rotation, DEK rotation, restart recovery
- `src/lib/db/migrations/013-workspace-keys.js`: schema
- `src/app/api/settings/keys/rotate/route.js`, `src/app/api/workspaces/[id]/keys/rotate/route.js`
- `cli/src/cli/commands/keysRotate.js`

#### Files to Modify

- `src/lib/db/repos/connectionsRepo.js`, `nodesRepo.js`, `settingsRepo.js`: encrypt/decrypt seams
- `src/lib/auth/gatewayResources.js`: decrypt raw gateway reads
- `src/sse/services/tokenRefresh.js`, `src/app/api/providers/[id]/test/testUtils.js`: atomic persistence, minted `apiKey`
- `src/mitm/manager.js`: legacy re-key, explicit errors
- `src/lib/db/repos/workspacesRepo.js`, `usersRepo.js`: Default guard, cache purge
- `src/lib/db/index.js`, `helpers/gatewayKeyTransfer.js`, `backup.js`: ciphertext snapshot, preflight, protected prefixes
- `src/lib/security/masterKey.js`, `activateGatewayKeys.js`, six hash-key callers: hash-key getter (D6)
- `src/lib/db/startupReadiness.js`, `src/lib/users/featureSwitch.js`: activation wiring, raw switch read
- `src/lib/db/schema.js`, `migrations/index.js`, `tenancy.js`, `routePolicy.js`, `cli/cli.js`

#### Configuration

- `TOKENHOP_MASTER_KEY`: optional base64 32-byte KEK (env-managed; KEK rotation refused)
- `DATA_DIR/keys/master`: file KEK, 0600, in 0700 dir
- `TOKENHOP_MULTI_USER`: rollout switch; first activation only

## UX Considerations

### User Workflows

#### Primary Workflow: First enable

1. **Enable multi-user**
   - User: sets switch on and restarts
   - System: logs key path/kid and backup warning; takes protected backup
2. **Activation**
   - User: none
   - System: encrypts, cleans WAL/free pages, verifies counts
3. **Success State**
   - Ready log with counts ("14 connections verified"); key backup reminder

#### Primary Workflow: KEK rotation

1. **Run** `tokenhop keys rotate`
   - System: shows plan (workspaces, kid), asks confirmation
2. **Rotate**
   - System: stages key, rewraps, publishes, verifies
3. **Success State**
   - New kid printed; reminder that pre-rotation backups need the old key

#### Error Recovery Workflow

1. **Error Occurs**: key missing or mismatched at startup
2. **User Sees**: `KEY_MISSING` / `KEY_MISMATCH` with file path or env var, "Nothing was changed"
3. **Recovery**: restore matching key or matching backup; else accept loss and re-link providers

### UI Patterns

| Component         | Pattern                 | Notes                                                        |
| ----------------- | ----------------------- | ------------------------------------------------------------ |
| Workspace delete  | typed-name confirmation | states irreversible key destruction; Default shows protected |
| Restore backup    | pre-check confirm       | "master key is not in the file" (extend `DataSection.js`)    |
| Locked connection | badge + re-link         | metadata lists never decrypt                                 |

### Accessibility Requirements

- WCAG 2.2 focus management: destructive dialogs focus Cancel; keyboard-only operable
- Plain-language copy without crypto jargon; all strings through i18n literals

### Performance UX

- **Loading States**: KEK rotation O(workspaces) prints per-workspace progress; DEK rotation synchronous with counts
- **Optimistic Updates**: none for key operations
- **Error Feedback**: immediate typed codes; pre-mutation errors say "Nothing was changed"

## Recommendations

### Implementation Approach

**Recommended Strategy**: mirror YAN-363 activation: additive schema, one sync codec, backup-gated switch-on activation latched by durable marker, encryption at repository and raw-read chokepoints.

**Phasing:**

1. **Phase 1 - Foundation**: codec, AAD vectors, schema, state marker, tenancy classification
2. **Phase 2 - Core Features**: repo/gateway/settings/MITM seams, activation, cleanup, delete/cache, transfer
3. **Phase 3 - Polish**: hash-key continuity, rotation service, APIs, CLI, copy, docs handoff

### Technology Decisions

| Decision               | Recommendation                               | Rationale                          |
| ---------------------- | -------------------------------------------- | ---------------------------------- |
| Encryption granularity | secret leaves inside JSON                    | metadata, dedup, routing unchanged |
| Cache                  | DEKs only, bounded, live-row checked         | shredding and memory bounds        |
| KEK publication        | staged file + durable DB + rename + recovery | crash safety without KEK in DB     |
| Hash continuity        | wrapped derived hash key                     | gateway keys survive rotation (D6) |
| Restore                | opaque envelopes, preflight proof            | AAD identities preserved           |

### Quick Wins

- AAD vector tests and the codec land first; they unblock every lane
- Default delete guard is small and independent

### Future Enhancements

- Manual two-key env KEK rotation protocol (D9 deferred)
- Passphrase-wrapped export (hardening issue)
- Proxy pool credential encryption if D10 discovery confirms stored secrets

## Risk Assessment

### Technical Risks

| Risk                               | Likelihood      | Impact | Mitigation                                  |
| ---------------------------------- | --------------- | ------ | ------------------------------------------- |
| Writer bypasses codec              | Med             | High   | central codec, grep review, sentinel scans  |
| KEK rotation breaks gateway hashes | High without D6 | High   | wrapped hash key, restart test              |
| Crash during key publication       | Low             | High   | staged protocol, child-process crash matrix |
| Async inside transaction           | Med             | High   | sync codec; no awaits in callbacks          |
| Plaintext in WAL/freelist          | High            | Med    | checkpoint + VACUUM, raw byte scan          |

### Integration Challenges

- `gatewayKeyTransfer` root proof assumes hashKid equals master kid: update with D6 snapshot version
- `featureSwitch` reads settings: add narrow raw read to avoid decrypt cycle
- MITM is CommonJS with side effects: inject adapter, extract legacy crypto only

### Security Considerations

#### Critical — Hard Stops

| Finding                               | Risk                        | Required Mitigation          |
| ------------------------------------- | --------------------------- | ---------------------------- |
| Plaintext fallback on key error       | key loss becomes leak       | fail closed (D3)             |
| Missed secret writer                  | plaintext in "encrypted" DB | single codec, scans          |
| Destructive import without root proof | data loss                   | preflight before backup/wipe |
| Weak AAD                              | field swap reuse            | D1 binding and vectors       |

#### Warnings — Must Address

| Finding                            | Risk                 | Mitigation                 | Alternatives                           |
| ---------------------------------- | -------------------- | -------------------------- | -------------------------------------- |
| Old backups keep plaintext/DEKs    | overstated shredding | document D7                | historical-key revocation design later |
| Decrypted settings exposed via API | secret leak          | redact at serialization    | strip at repo                          |
| Refresh persistence swallowed      | token loss           | propagate integrity errors | none                                   |

#### Advisories — Best Practices

- Zero DEK buffers on eviction: best effort (deferral justification: V8 cannot guarantee erasure)
- Audit kid/counts only: never key bytes (deferral justification: none, required)

## Task Breakdown Preview

### Phase 1: Crypto foundation

**Focus**: codec, state, schema
**Tasks**:

- envelope codec + AAD builder + vectors + DEK cache
- migration 013, schema, tenancy classification, marker helper
  **Parallelization**: codec and schema in parallel

### Phase 2: Storage integration

**Focus**: encrypt everywhere, activate safely
**Dependencies**: Phase 1
**Tasks**:

- connections/nodes/gateway/refresh seams
- settings/SSO/MITM re-key
- activation + cleanup + startup wiring
- delete guard/cache purge; ciphertext transfer

### Phase 3: Rotation and operations

**Focus**: key lifecycle
**Tasks**:

- hash-key getter and caller migration
- KEK staged rotation + recovery; DEK rotation incl. Default settings
- owner APIs, CLI, route policy, copy

## Decisions Needed

Parent accepted D1–D11 in [decisions.md](decisions.md). Remaining:

1. **Proxy pool credentials**
   - Options: encrypt in YAN-365, follow-up issue, leave documented plaintext
   - Impact: schema has no `workspaceId`; AAD needs instance slot
   - Recommendation: discovery only now; follow-up if credentials confirmed
2. **Manual env two-key protocol**
   - Options: design later, never support
   - Impact: env-managed operators cannot rotate KEK in-process
3. **ADR copy into main checkout**
   - Options: maintainer copies D1–D11 into ADR-0001/0005/0008
   - Impact: keeps canonical ADRs aligned

## Research References

For detailed findings, see:

- [research-external.md](research-external.md): Node crypto, OWASP, AAD analysis
- [research-business.md](research-business.md): acceptance rules, workflows
- [research-technical.md](research-technical.md): architecture, data model, rotation protocol
- [research-ux.md](research-ux.md): operator workflows, error copy
- [research-security.md](research-security.md): severity findings
- [research-practices.md](research-practices.md): reuse, modularity, KISS
- [research-recommendations.md](research-recommendations.md): phases and risks
- [Accepted decisions [D]](decisions.md): accepted decisions and ADR amendments
- [verification.md](verification.md): evidence path
