# YAN-365 — UX research: envelope encryption operator experience

> Feature-research lane: UX design. Issue: GH #233 / Linear YAN-365.
> Grounding: issue #233, `docs/users/README.md` (handbook), `docs/users/spec.md` decision 8,
> `docs/users/adr/0008-encryption-at-rest.md`, and the current worktree state
> (`src/lib/db/startupReadiness.js`, `src/app/(dashboard)/dashboard/settings/sections/DataSection.js`,
> `cli/cli.js` subcommand pattern, `src/shared/components/Modal.js` `ConfirmDialog`).
> Parent session owns validation. This document proposes; it changes no application code.

---

## Executive Summary

Envelope encryption (YAN-365) turns one SQLite file into **file + key**: from the moment the
multi-user switch is on, a lost `DATA_DIR/keys/master` (or unset `TOKENHOP_MASTER_KEY`) means
every stored provider credential is unreadable forever. ADR-0008 accepts that trade-off. The UX
job is to make sure no operator ever discovers it at failure time.

This document designs the operator experience for the eight moments where encryption becomes
human-visible:

1. **First enable** — the one-time master-key backup warning (CLI + logs + dashboard).
2. **`tokenhop keys rotate`** — CLI command UX (plan → confirm → rewrap → verify).
3. **Admin rotation API** — `POST /api/keys/rotate`, owner-only, no key material over HTTP.
4. **Per-workspace DEK rotation** — progress, safety during in-flight token refresh.
5. **Missing/wrong key at startup** — fail closed, with a precise, actionable error.
6. **Recovery** — what "recovery" honestly means when there is no key escrow (re-provision).
7. **Ciphertext backups** — export/restore warnings ("a backup without its key is not a restore
   path"), continuing the copy already shipped in `DataSection.js`.
8. **Irreversible workspace destruction** — crypto-shredding confirmation semantics.

Core positions:

- **No new dashboard surface.** Issue scope is CLI + admin API + startup behavior; the only
  UI touch-points are the existing Settings → Data & backup section (warnings already partially
  shipped) and existing destructive-flows where a confirm dialog lives today. A dedicated
  "Keys" admin page is deferred (see Open Questions).
- **Show-once, confirm-by-typing.** Master-key backup borrows the 1Password Emergency Kit /
  BitLocker recovery-key pattern: display once at generation, require an explicit
  acknowledgment (typed phrase or download) before the irreversible encryption migration runs.
- **Confirmation semantics per destructive tier.** Rotate = two-step y/N with plan summary
  (recoverable: old key retained one rotation). DEK rotation = typed workspace name only if the
  workspace has live credentials. Workspace deletion (destroys DEK) = typed workspace name,
  always, with the irreversibility stated in plain words.
- **Never leak secrets anywhere.** No KEK, DEK, ciphertext, or token ever appears in CLI
  output, API responses, logs, audit rows, or progress messages. Key ids (`kid`), counts, and
  durations are safe and useful; everything else stays out.
- **Fail closed, but say exactly what to do.** A missing key stops the gateway from serving
  and the dashboard from writing; the error names the file path (or env var), the last-known
  good state, and the two possible exits (restore the key / accept loss and re-link).

Copy tone: short declarative sentences, ~grade-8 reading level, no crypto jargon in operator
copy ("credentials are stored locked — the key unlocks them; if the key is lost, they must be
re-linked"). Terms like KEK/DEK/AAD stay in docs and logs for engineers, never in prompts.

---

## User Workflows

### 2.1 First enable — the one-time key-backup warning

**Actor:** owner enabling multi-user (switch on). **Where:** CLI startup logs + dashboard banner.

Sequence (moment the KEK is first generated):

```
┌─ tokenhop ─────────────────────────────────────────────────────────────┐
│ Master key created                                                     │
│                                                                        │
│ Provider credentials in this instance are now stored encrypted.        │
│ The encryption key is a single file:                                   │
│                                                                        │
│   /home/ops/.tokenhop/keys/master                                      │
│                                                                        │
│ Back it up now, separately from the database. If this file is lost,    │
│ every stored connection must be re-linked manually. There is no       │
│ recovery.                                                              │
│                                                                        │
│ Existing credentials will be encrypted on next start, after an        │
│ automatic database backup.                                             │
└────────────────────────────────────────────────────────────────────────┘
```

Rules:

- Shown **once per key materialization** (generation or env-first-detect), then on demand via
  `tokenhop keys status`. Never repeated on every boot (banner fatigue hides real warnings).
- Dashboard equivalent: a dismissible **warn** `Callout` on Settings → Data & backup with the
  same words, shown until dismissed (dismissal recorded in `settings` as
  `masterKeyBackupAcknowledgedAt`). The dismissal is per-instance, not per-session — the
  warning protects the data, not the viewer.
- The words "There is no recovery" must survive translation (repo uses English-literal-keyed
  i18n; strings added as literals in `public/i18n/literals/*.json`).
- The pre-migration backup runs before any irreversible encryption (handbook §5, YAN-352);
  copy states this so operators know a plaintext fallback exists **at this moment only**.

Acknowledgment gate: the encrypt-existing-credentials migration is irreversible, so the
**dashboard** path requires the acknowledgment callout to be actioned ("I've saved the key")
before the restart that runs the migration is counted as expected. The **CLI/headless** path
cannot be gated interactively at runtime (unattended installs); instead the first-enable log
block above is emitted and `keys status` reports `backupAcknowledged: false` until the
operator runs `tokenhop keys status --ack-backup`. Lazy, explicit, no new state machine.

### 2.2 `tokenhop keys rotate` (CLI)

Follows the existing subcommand pattern in `cli/cli.js` (`xai video`, `auth setup-token`,
`data migrate`), implemented as `src/cli/commands/keysRotate.js`. Rewraps DEKs only — O(workspaces),
seconds, field ciphertext untouched (ADR-0008).

Transcript (proposed, exact):

```
$ tokenhop keys rotate

Key rotation plan
  Key source:        file (/home/ops/.tokenhop/keys/master)
  Workspaces:        4 (14 connections, 2 instance secrets)
  Current key id:    k_9f2ab41c
  Rotation rewraps the per-workspace keys only.
  Connection data is not rewritten. Expected duration: seconds.

  The previous key file is kept as:
    /home/ops/.tokenhop/keys/master.old-k_9f2ab41c-2026-10-06

Rotate now? [y/N]:
```

On confirm:

```
Rotating…
  ✓ new key generated (k_5d81e03a)
  ✓ Default          rewrapped (4 connections verified)
  ✓ acme-team        rewrapped (7 connections verified)
  ✓ personal/jane    rewrapped (2 connections verified)
  ✓ personal/sam     rewrapped (1 connection verified)
  ✓ instance secrets rewrapped (oidc, saml, mitm-sudo)

Rotation complete in 1.8s. 4 workspaces rewrapped, 14 connections verified.

Back up the new key file the same way as before:
  /home/ops/.tokenhop/keys/master
```

Rules:

- **Verification, not just completion:** after rewrap, decrypt-probe one encrypted row per
  workspace and report "verified". A rotation that rewraps but cannot verify is a failure with
  a `k_…`-level error and non-zero exit (see Error Handling).
- Default answer `N`; Enter alone aborts. `--yes` skips the prompt for scripted use; `--json`
  emits machine-readable output; `--dry-run` prints the plan block and exits 0.
- **Env-sourced KEK:** if the key comes from `TOKENHOP_MASTER_KEY`, the server cannot rewrite
  the operator's environment. Refuse with instructions unless `--stdout-new-key` is passed:

  ```
  The master key comes from the environment (TOKENHOP_MASTER_KEY).
  tokenhop cannot update your environment for you.

  To rotate:
    1. Run again with --stdout-new-key. The new key is printed once.
    2. Put it into TOKENHOP_MASTER_KEY where the old value lives.
    3. Restart tokenhop.
  ```

  With `--stdout-new-key`, the new base64 key is printed exactly once to the TTY, never piped
  to `--json` output, never logged.

- Concurrency: refuses to run while the gateway holds the writer lock / is mid-startup
  (same `processLock` discipline as `data migrate`), or offers `--offline` mode documented as
  "stop the server first".
- Old key retention: keep exactly one generation (`master.old-<kid>-<date>`) as the safety net;
  a second rotate overwrites the oldest. Copy tells the operator the old file's path so
  "recoverable" is concrete, not implied.

### 2.3 Admin API — rotation over HTTP

Owner-only (capability `keys:rotate`, per ADR-0002 role model; the YAN-357 route → capability
table gains the mapping). Two endpoints, no secrets:

**`GET /api/keys`** (status; already partially exists for gateway API keys — extend or add
`GET /api/keys/master`):

```json
{
  "source": "file",
  "path": "/home/ops/.tokenhop/keys/master",
  "kid": "k_5d81e03a",
  "createdAt": "2026-10-06T09:14:00Z",
  "rotatedAt": "2026-10-06T11:02:31Z",
  "workspaces": 4,
  "encryptedConnections": 14,
  "backupAcknowledged": true
}
```

No key bytes, no wrapped DEK bytes, no ciphertext. `path` is operator-host metadata the owner
already owns. When `source` is `"env"`, `path` is `null` and the response adds
`"note": "Key comes from TOKENHOP_MASTER_KEY; rotation needs the CLI."` — the API **cannot**
rotate an env-sourced key (it has nowhere to write it), which keeps one rotation path honest.

**`POST /api/keys/rotate`** — synchronous (seconds for realistic workspace counts):

```json
// 200 OK
{
  "ok": true,
  "oldKid": "k_9f2ab41c",
  "newKid": "k_5d81e03a",
  "workspacesRewrapped": 4,
  "connectionsVerified": 14,
  "durationMs": 1830
}
```

Rules:

- Audit event (`auditEvents`, YAN-367): action `keys.rotate`, actor, old/new kid, counts,
  result. Never any key material (handbook §8: no token material in audit rows).
- POST body is empty; no parameters means nothing to phish. Response codes: 200 done, 409 if
  another rotation/startup holds the lock, 403 non-owner, 503 if the key state is unhealthy
  (missing/failed verification) — with the same `error.code` vocabulary as the CLI.
- Rate-limit: one rotation per N minutes is not enforced server-side (owner-only action,
  cheap operation); the confirm-once semantics carry the safety.

### 2.4 Per-workspace DEK rotation

**Actor:** owner/admin. **Surfaces:** admin API + (deferred) workspace settings. Re-encrypts
that workspace's fields under a fresh DEK — O(rows in workspace).

`POST /api/workspaces/{id}/rotate-dek`

```json
{
  "ok": true,
  "workspaceId": "ws_7c31",
  "workspaceName": "acme-team",
  "connectionsReEncrypted": 7,
  "durationMs": 412,
  "dekKid": "d_03cc82" // DEK key id, not secret
}
```

Safety rules (from the issue: "Refresh-token rotation stays inside the existing transaction"):

- Runs under the workspace write path's existing transaction discipline: DEK swap + row
  re-encryption commit atomically with any in-flight `updateProviderConnection` refresh —
  a refresh that lands mid-rotation either commits under the old DEK (and is re-encrypted) or
  waits; never a half-state. The bounded decrypt cache is invalidated for that workspace on
  commit.
- Long workspaces (hundreds of rows): API returns 202 + job id with a `GET …/rotate-dek/{job}`
  progress shape `{ "done": 812, "total": 1204, "phase": "re-encrypting" }` — counts only,
  no row names, no user data. Realistically tokenhop workspaces are tens of rows; 202 exists
  as the ceiling, not the default.
- Copy: "Re-encrypting acme-team's stored credentials with a fresh key. Connections keep
  working; nothing is re-linked."

### 2.5 Missing / wrong key at startup — fail closed

The worktree's `startupReadiness.js` is already a sticky rejection: "this process must serve
nothing and start no background writers." Keep that. The UX contract:

**Missing key (file absent, env unset), switch on, DB already encrypted:**

```
ERROR: The master key is missing.

Provider credentials in the database are encrypted, but the key that
unlocks them was not found:

  expected file: /home/ops/.tokenhop/keys/master
  or env:        TOKENHOP_MASTER_KEY

The server is NOT starting because starting without the key would
leave every stored connection unreadable.

Fix one of two ways:
  1. Restore the key file from your backup, then start again.
  2. Accept the loss: delete DATA_DIR/keys and re-link every provider
     connection afterwards.

Exit code 78 (EX_CONFIG). Nothing was changed.
```

**Key present but wrong (unwrap of every DEK fails — AAD/kid mismatch):**

```
ERROR: The master key does not match this database.

The key was found (/home/ops/.tokenhop/keys/master) but it cannot unlock
the stored credentials. This usually means the key file belongs to a
different instance, or the database was restored from a backup made
under another key.

Last known key id for this database: k_5d81e03a
Key tried:                         k_9f2ab41c

The server is NOT starting. Restore the matching key, or restore a
backup that matches this key.

Exit code 78 (EX_CONFIG). Nothing was changed.
```

- `k_9f2ab41c` (the kid) is stored alongside the wrapped DEK precisely so this message can be
  honest; kid is an identifier, not secret material.
- **Degraded mode is rejected**: a dashboard that boots with unreadable credentials invites
  well-meaning "fixes" (re-link over encrypted data). Fail closed matches the sticky
  readiness contract already shipped. Dashboard shows the same error text on its 503 page
  (static, no DB reads).
- "Nothing was changed" is load-bearing: both errors are pre-mutation, so no repair path
  destroys data silently.
- Switch **off**: no encryption exists, none of this fires (handbook §5 — byte-identical
  single-user behavior).

### 2.6 Recovery

There is no cryptographic recovery (ADR-0008 threat model: lost KEK = data loss by design).
"Recovery" is two honest paths, and copy must not imply a third:

1. **Key restored** — operator finds the backup of `keys/master` (or the recorded
   `TOKENHOP_MASTER_KEY` value), puts it back, restarts. Everything works. The UX duty:
   the startup error above names the exact path, and `tokenhop keys status` prints a
   "backup checklist" (where the file is, kid, last rotation date) so operators can verify a
   found key is the right one _before_ a crisis.
2. **Loss accepted** — delete `DATA_DIR/keys`, start, re-link each provider connection.
   `keys status` then shows `encryptedConnections: 0` again. Copy for this path, shown once
   when the operator confirms it:

   ```
   Stored credentials cannot be recovered without the key.
   Connections will be listed but marked "locked — re-link required".
   Users, keys, settings and usage history are not affected.
   ```

   Connections in this state render with a lock badge and a "Re-link" action replacing any
   credential-dependent action; list pages still show them (metadata stays plaintext,
   ADR-0008), so operators see the checklist of what to re-link. No secrets, just names.

Optional helper (nice-tier): `tokenhop keys verify --file <path>` — offline check that a
candidate key file matches the DB's wrapped DEKs, printing `match: k_5d81e03a` or
`no match (tried k_9f2ab41c)`. Cheap, prevents the classic "restore the wrong backup twice"
incident.

### 2.7 Ciphertext backups (export / restore)

Continues the copy already shipped in `DataSection.js` (format-v2 restore warning, master-key
bullet). Consolidated rules:

- **Export** (`/api/settings/database` download) — after download, status line states:
  "Backup downloaded. It contains credentials in locked form plus the per-workspace wrapped
  keys — the master key is **not** in the file. Keep your key backup and this file in
  different places."
- **Restore pre-check** — a missing or mismatched master key fails the pre-restore check with
  nothing changed (already shipped copy); the mismatch variant names kids like §2.5.
- **Rotation ordering warning** — restoring an old backup after rotating keys requires the
  **old** key that backup was made under. Copy (one line in the restore dialog):
  "Backups made before a key rotation need the key that was current when they were taken."
- Rolling DB backups (`backup.js`) inherit the same story; docs (YAN-379) carry the canonical
  sentence: **"A backup without its key is not a restore path."**

### 2.8 Irreversible workspace destruction (DEK crypto-shredding)

Deleting a workspace deletes its `workspaceKeys` row → the DEK is gone → any ciphertext left
in stray backups is unrecoverable even with the master key (ADR-0008). Confirmation tier:
**typed name**, the strongest the product uses.

Dialog (ConfirmDialog, `variant="danger"`, `role="alertdialog"` semantics — see §3):

> **Delete workspace "acme-team"?**
>
> This permanently deletes:
>
> - 7 provider connections and their stored credentials
> - 3 workspace API keys (clients using them stop working)
> - combos, aliases and preferences
>
> Deletion destroys acme-team's encryption key. Credentials in old backups
> of this database become unreadable — that cannot be undone, even by us.
>
> Usage history and audit logs are kept.
>
> Type the workspace name to confirm: `[ acme-team ]`
>
> [ Cancel ] [ Delete workspace ]

Rules:

- Confirm button stays disabled until the typed name matches exactly (trimmed, case-insensitive
  match is acceptable if the name is long; exact-match recommended).
- Initial focus lands on **Cancel**, never the destructive button; Enter on the text field
  does not submit — submit requires tab-to-button or an explicit "Delete workspace" click.
  (GitHub's repo-delete pattern; NN/g destructive-action guidance.)
- The audit row records the actor, workspace id/name, connection count, and result — never
  credential material.
- DEK-rotation (§2.4) and workspace deletion share the same write lock, so a workspace can't
  be shredded while its keys are being rotated.

---

## UI/UX Best Practices

Grounded in WCAG 2.1, NN/g, and the component library already in the repo
(`Modal`/`ConfirmDialog` with focus trap, `role="alert"`, `aria-live`; `Callout` variants
info/warn/ok/err; `SectionCard`/`SettingRow` layout).

**Confirmation semantics — three tiers, matched to consequence (WCAG SC 3.3.4: legal,
financial or data-loss consequences are reversible, checked, or confirmed):**

| Tier | Action class                   | Pattern                                                  | Example                                     |
| ---- | ------------------------------ | -------------------------------------------------------- | ------------------------------------------- |
| 1    | Recoverable (old key retained) | y/N prompt with plan, default **No**; plain dialog       | `keys rotate`, KEK rewrap                   |
| 2    | Data-affecting, scoped         | confirm dialog + consequence list                        | DEK rotation, DB restore (existing pattern) |
| 3    | Irreversible destruction       | typed-name confirmation, danger styling, focus on Cancel | workspace deletion (shreds DEK)             |

**Accessibility specifics:**

- Destructive dialogs use `role="alertdialog"` with `aria-describedby` pointing at the
  consequence list; the existing `Modal` supports `aria-label`/labelledby — extend
  `ConfirmDialog` with an optional `role` prop rather than a new component (smallest diff).
- Async outcomes inside dialogs: existing `aria-live="polite"` region + `role="alert"` for
  errors is correct; keep it.
- Typed-confirmation input gets `aria-label="Type the workspace name to confirm"`; the
  disabled confirm button must expose _why_ it's disabled via the description text, not
  `aria-disabled` alone.
- Color never carries meaning alone: danger is border + icon + words (`border-err/40`,
  warn icon), consistent with today's `DangerSection`.
- Keyboard-only path for every flow above (dialog trap already ships); test at 1440/1024/390
  per handbook §7.

**Plain copy rules (operator-facing strings):**

- One idea per sentence; verbs first ("Back it up now", "Type the workspace name").
- Banned in operator copy: KEK, DEK, AAD, GCM, envelope, rewrap, crypto-shred. Allowed:
  "master key", "per-workspace key", "stored locked", "re-link". Engineer terms live in docs.
- Numbers over adjectives: "14 connections verified" beats "all connections verified";
  "There is no recovery" beats "recovery may be difficult".
- The word "permanently" appears exactly once per destructive dialog — where the deletion
  list starts — not scattered.
- i18n: strings ship as English literals in `public/i18n/literals/*.json` (existing
  mechanism); keep sentences short enough to translate (the existing restore-warning literals
  are the precedent).

**Anti-patterns explicitly avoided:**

- No countdown timers or hold-to-delete gimmicks (NN/g: adds rage, not safety; typed
  confirmation is the evidence-based pattern).
- No "are you sure?" stacking (double dialogs train Escape-Enter muscle memory).
- No secret display as a "verification" step — kids and counts verify rotations; keys never
  render.
- No repeated boot warnings after acknowledgment; warnings that never go away are warnings
  nobody reads.

---

## Error Handling

One vocabulary across CLI (exit codes + `error.code`), API (HTTP + `error.code`), and logs.
No stack traces in operator surfaces; full details to logs with a correlation id. Nothing
below ever includes key bytes, wrapped DEKs, or ciphertext.

| #   | Trigger                                                                         | Surface   | Code / Exit                          | Exact operator copy                                                                                                                                                                            | Next step it tells                      |
| --- | ------------------------------------------------------------------------------- | --------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| E1  | Switch on, DB encrypted, no key file, no env                                    | startup   | exit 78 `KEY_MISSING`                | §2.5 block 1                                                                                                                                                                                   | Restore key file, or accept loss        |
| E2  | Key present, all DEK unwraps fail                                               | startup   | exit 78 `KEY_MISMATCH`               | §2.5 block 2 (names kids)                                                                                                                                                                      | Restore matching key or matching backup |
| E3  | Some DEKs unwrap, one fails (partial corruption)                                | startup   | exit 78 `KEY_MISMATCH_PARTIAL`       | "1 of 4 workspace keys can't be unlocked by this master key (acme-team, kid d_03cc82). The rest are fine. Restore the key that matches that workspace, or restore a backup taken when it did." | Restore or backup-path                  |
| E4  | Rotation rewrap succeeds, verify-probe fails                                    | CLI / API | exit 1 / 503 `ROTATE_VERIFY_FAILED`  | "Rewrap finished but verification failed for acme-team (kid d_03cc82). Nothing was changed — the old key still works. Run rotate again or check the log (ref 7f3a)."                           | Retry; old key retained                 |
| E5  | Rotate while lock held (startup or another rotate)                              | CLI / API | exit 75 / 409 `LOCKED`               | "Another key operation or startup is in progress. Wait for it to finish, or stop the server and run with --offline."                                                                           | Wait or offline                         |
| E6  | Env-sourced KEK, no `--stdout-new-key`                                          | CLI       | exit 64 `ENV_KEY_NEEDS_FLAG`         | §2.2 env block                                                                                                                                                                                 | Re-run with flag, update env, restart   |
| E7  | Restore backup, key missing/mismatched                                          | dashboard | 4xx pre-check `RESTORE_KEY_MISMATCH` | "This backup's credentials need a different master key (backup key id k_9f2ab41c, this instance has k_5d81e03a). Nothing was changed."                                                         | Provision matching key first            |
| E8  | Connection decrypt fails at request time (stray ciphertext after key loss path) | gateway   | per-request `CREDENTIAL_LOCKED`      | "Connection <name> is locked — its key was destroyed or lost. Re-link the provider." (5xx upstream-shaped error; badge in list)                                                                | Re-link                                 |
| E9  | DEK rotation conflict with in-flight refresh                                    | API       | 409 `WRITE_CONFLICT`, auto-retried   | "A credential refresh was writing at the same moment. The rotation restarted and finished cleanly." (informational; self-healing)                                                              | None                                    |
| E10 | Workspace delete fails after rows deleted but before DEK row dropped            | API       | 500 `SHRED_INCOMPLETE`               | "acme-team's data was deleted but its key couldn't be dropped. Run delete again — it finishes the job." (idempotent completion)                                                                | Re-run delete                           |
| E11 | Non-owner calls rotation endpoints                                              | API       | 403                                  | Existing RBAC copy ("You don't have permission to do that.") — no new text needed                                                                                                              | Contact owner                           |
| E12 | `keys status` when switch off                                                   | CLI       | exit 0, informational                | "Multi-user mode is off. Credentials are stored unencrypted; no master key exists yet."                                                                                                        | None (correct state)                    |

Rules: E1–E3 are **pre-mutation** and say so ("Nothing was changed"); E4, E10 name the
recovery that exists; no error ever suggests deleting data as a first resort.

---

## Performance UX

- **Lists never decrypt.** Non-secret metadata stays plaintext (ADR-0008 field split), so
  connection/key/workspace list pages need zero crypto on render. This is the single biggest
  perceived-performance decision; keep query-time cost at zero.
- **Bounded decrypt cache**: first use of a workspace after restart pays one unwrap; then
  cached until invalidation (rotation, delete). Cache is keyed by workspace + kid and cleared
  on workspace deletion (issue scope). Operator-visible effect: nothing — cache behavior
  never surfaces in copy except as absence of latency.
- **KEK rotation is O(workspaces), not O(rows)** — always seconds. The CLI prints per-
  workspace progress lines (§2.2) so even a slow disk shows movement, not a frozen spinner.
- **DEK rotation is O(rows)** — for realistic tokenhop workspaces (< 200 connections) it's
  sub-second; the API returns synchronously with counts. The 202/job shape (§2.4) exists as
  the ceiling; do not ship a progress UI for a sub-second operation (progress theater).
- **Export size**: envelopes add roughly fixed overhead per secret field (`{v,kid,iv,ct,tag}`
  ≈ +90 bytes + ciphertext). No operator copy needed; the download status line stays as-is.
- **Startup**: fail-closed checks (E1–E3) run before serving (existing sticky readiness) and
  cost one unwrap attempt — milliseconds. No new startup latency story.
- **Perceived safety over perceived speed**: every crypto operation ends with a verification
  count ("14 connections verified"). Verification is itself fast (one probe per workspace for
  rotate; all rows for DEK rotation) and is what operators actually want to know.

---

## Competitive Analysis

| System                                                                                                                                                                                                                                                                    | Behavior we studied                                                                                                      | Take for YAN-365                                                                                                           | Avoid                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **LiteLLM Proxy** ([security/encryption FAQ](https://docs.litellm.ai/docs/proxy/security_encryption_faq))                                                                                                                                                                 | Credentials encrypted with a master key; `LITELLM_SALT_KEY` historically non-rotatable; docs stress env-var secrecy      | Loud, one-time backup warning; key status introspection                                                                    | Non-rotatable key material — YAN-365 ships `keys rotate` precisely to avoid this trap             |
| **HashiCorp Vault** ([operator init](https://developer.hashicorp.com/vault/docs/concepts/operator), [seal/unseal + rotate](https://developer.hashicorp.com/vault/docs/concepts/seal))                                                                                     | Init prints keys **once**; unseal required after restart; `operator rotate` starts a new key term without rewriting data | Show-once key ceremony; rotation = rewrap-not-rewrite (same O(1) insight); explicit "key id changed" reporting             | Unseal-on-every-boot friction — tokenhop needs unattended refresh (ADR-0008 context)              |
| **AWS KMS** ([envelope encryption](https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html#enveloping), [automatic rotation](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html))                                                         | Envelope model: KMS key wraps DEKs; rotation rewraps; old ciphertext stays decryptable via key versions                  | Terminology precedent for kid/versioned envelopes; "old backups still readable under rotated KEK" nuance → §2.7 copy       | Managed-HSM recovery escrow tokenhop explicitly does not offer                                    |
| **1Password** ([Secret Key + Emergency Kit](https://support.1password.com/secret-key-security/))                                                                                                                                                                          | 32-char Secret Key shown once, downloadable "Emergency Kit" PDF, typed/documented acknowledgment                         | The show-once + explicit-save acknowledgment for first enable (§2.1); "keep it somewhere different from the data" phrasing | App-enforced re-entry of the key (tokenhop runs headless)                                         |
| **BitLocker / LUKS** ([recovery key guidance](https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/recovery-keys-plan/) )                                                                                               | "Print your recovery key" at enable; key-loss = volume loss, stated up front                                             | Naming loss honestly at enable time, not at failure time; recovery-key as a first-class artifact to back up                | Recovery-key printout being the _only_ path — tokenhop adds `keys verify` instead                 |
| **GitHub** ([delete a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/deleting-a-repository), [secret rotation guidance](https://docs.github.com/en/code-security/secret-scanning/managing-secret-scanning/about-secret-scanning)) | Destructive deletes require typing the exact name; secrets, once leaked, are "rotate, don't investigate"                 | Typed-name confirmation for workspace deletion (§2.8); rotate-first framing in recovery copy (§2.6)                        | Countdown/hold gimmicks GitHub avoids                                                             |
| **Stripe / Vercel API keys** ([Stripe roll](https://docs.stripe.com/keys#roll-keys), [Vercel](https://vercel.com/docs/accounts/create-and-manage-accounts/managing-members/managing-and-rotating-tokens))                                                                 | Key rotation with overlap: old key works briefly; value shown once at creation                                           | Old-key retention for one rotation (`master.old-…`) mirrors overlap; show-once for `--stdout-new-key`                      | Overlap _windows_ for the master key would break fail-closed verification; retention file instead |
| **Signal** ([PIN + registration lock](https://support.signal.org/hc/en-us/articles/360007059792))                                                                                                                                                                         | Documents the recovery trade-off plainly: forgotten PIN after grace = account reset                                      | The two-path honesty of §2.6 (restore vs. accept loss), no fake middle                                                     | Grace period that softens data loss — incompatible with fail-closed                               |
| **Cloudflare AI Gateway BYOK** ([docs](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/))                                                                                                                                                  | Account-scoped keys usable by any token with "Run"                                                                       | (Handbook §2 already cites) reinforces per-workspace DEK blast-radius as the right boundary                                | Coarse account-level scoping                                                                      |

Cross-cutting lesson: every mature system front-loads the loss warning at key creation and
verifies at rotation; none of them offer a secret-recovery middle path, and the honest ones
say so in the first screen the operator sees.

---

## Recommendations

**Must (ship with YAN-365 / YAN-377):**

1. Show-once first-enable warning with exact key path, "back it up separately", and "there is
   no recovery" (§2.1) — CLI block + dashboard `Callout` with recorded acknowledgment.
2. `tokenhop keys rotate` transcript per §2.2: plan → y/N default-No → per-workspace progress →
   verification counts → new-key backup reminder; `--dry-run`, `--yes`, `--json`;
   env-sourced refusal without `--stdout-new-key`.
3. Owner-only `POST /api/keys/rotate` + status read with kids/counts only (§2.3); audit events
   without any key material.
4. Fail-closed startup errors E1/E2 with exact copy, exit 78, "nothing was changed", and the
   two recovery paths (§2.5, §2.6) on both CLI and the dashboard 503 page.
5. Typed-name confirmation for workspace deletion stating DEK destruction irreversibility
   (§2.8); focus on Cancel; audit row.
6. Export/restore copy: "the master key is not in the file" + pre-check mismatch kids (§2.7),
   extending the shipped `DataSection.js` warning.
7. Error table §4 codes implemented once, shared by CLI and API.

**Should:**

1. `tokenhop keys status` command with backup checklist (path, kid, rotatedAt, counts,
   `--ack-backup`) as the always-available warning surface.
2. Old key retained one generation (`master.old-<kid>-<date>`), path printed in rotation
   output; second rotate replaces it.
3. `POST /api/workspaces/{id}/rotate-dek` with counts-only response and transactional safety
   vs. token refresh (§2.4); E9 self-healing copy.
4. "Locked — re-link required" state for connections after accepted key loss (§2.6): badge +
   re-link action on existing list pages, no new page.
5. `tokenhop keys verify --file <path>` offline match check (§2.6).
6. i18n literals for every new string (existing mechanism).

**Nice:**

1. 202/job progress shape for very large DEK rotations (ceiling only — §5).
2. `GET /api/keys/master` status endpoint for a future admin UI (defer the UI itself).
3. A "print this checklist" plain-text output of `keys status` for runbooks.
4. Optional: rotation reminder if `rotatedAt` is older than N months — a note in `keys
status`, never a dashboard nag.

---

## Open Questions

1. **Degraded boot vs. hard exit on E1/E2.** ADR-0008's test-impact text says "instance
   starts, connections report unreadable"; the shipped `startupReadiness.js` contract is
   serve-nothing. This doc recommends fail-closed (§2.5) as the safer operator experience —
   parent validation should confirm the ADR wording refers to the connection-state tests, not
   a served dashboard.
2. **Dashboard exposure.** Issue scope names CLI + admin API only. Is a minimal key-status
   row inside Settings → Data & backup (path, kid, last rotation — no actions) wanted for
   v1.1.0, or fully deferred? Recommendation: defer actions, ship the read-only row with the
   existing backup callout.
3. **Env-sourced rotation UX.** Is printing the new key once to the TTY (`--stdout-new-key`)
   acceptable, or should env-sourced instances require a file cutover (write `master.next`,
   operator moves it) with no stdout key ever? TTY-once matches Stripe/Vercel reveal-once;
   file-cutover is stricter.
4. **Typed-name confirmation strictness.** Exact match vs. case-insensitive/trimmed for long
   workspace names — recommend exact match; confirm with maintainer.
5. **Backup acknowledgment persistence.** `settings.masterKeyBackupAcknowledgedAt` is instance
   state; after a key rotation, should acknowledgment reset (new key material = new backup
   duty)? Recommendation: yes — rotation output already carries the reminder; resetting the
   flag re-arms the dashboard callout once.
6. **`master.old-…` retention and exports.** Do rolling DB backups taken pre-rotation plus the
   retained old key file cover the restore window, or should `keys status` warn while an old
   key file exists that no backup verification has been run? (Overlaps YAN-375/YAN-379.)
7. **Personal-workspace deletion.** Handbook ADR-0001 gives every user a personal workspace;
   this doc assumes deletion flows (and thus shredding) apply to shared workspaces only in
   v1.1.0. Confirm with YAN-361 lane.
