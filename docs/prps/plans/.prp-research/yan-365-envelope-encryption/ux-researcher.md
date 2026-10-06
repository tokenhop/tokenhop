# UX Discovery: YAN-365 — envelope encryption operator experience (PRP lane)

Sources: GH #233 (YAN-365), `docs/plans/yan-365-envelope-encryption/feature-spec.md` (spec), `decisions.md` D1–D11 (binding, accepted 2026-10-06), `docs/users/README.md` handbook §4/§5/§8, ADR-0008 (as amended), `docs/plans/yan-365-envelope-encryption/research-ux.md` (prior UX lane), worktree code (`startupReadiness.js` sticky contract, `DataSection.js` shipped restore warnings, `ConfirmDialog` focus/ARIA, `cli/cli.js` subcommand pattern). Parent validation owner. Discovery only — no application changes, no skills, no delegation.

Standing rules (apply to every row below): no KEK/DEK bytes, wrapped material, ciphertext, or token ever appears in any prompt, response, log, audit row, or progress line — kids, counts, durations only. No new dashboard page; the only UI touches are existing Settings → Data & backup (`DataSection.js`) and existing destructive-dialog surfaces. All strings ship as English literals (`public/i18n/literals/`). Operator copy is plain: "master key", "stored locked", "re-link" — never KEK/DEK/AAD/GCM.

## T1 — UX Design: Before / After / Interaction Changes

| #   | Touchpoint                                | Before (today)                            | After (YAN-365)                                                                                                                                    | Interaction change                                                                                                               |
| --- | ----------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| U1  | First enable (switch on)                  | No encryption exists; no key duty         | Startup log names key path/kid and states the backup warning (spec UX workflow); optional warn `Callout` on Data & backup with same words          | Show once per key materialization, never every boot; dashboard Callout is the only UI addition and is optional                   |
| U2  | Key backup acknowledgment                 | none                                      | **Proposed, not in spec/decisions (drop if parent rejects):** Callout "I've saved the key" action records ack; no `keys status` command is assumed | Ack never gates activation (unattended installs can't be interrupted); without it, the log block + docs (YAN-379) carry the duty |
| U3  | `tokenhop keys rotate`                    | command doesn't exist                     | Plan → y/N (default No) → staged rewrap → verify counts → new-kid receipt                                                                          | Spec flags: `--workspace <id>`, `--port`; proposed extras: `--dry-run`, `--yes`, `--json`, old-key retention path                |
| U4  | Env-managed KEK rotate                    | n/a                                       | Refused `409 KEK_ENV_MANAGED`, zero mutation, guidance to convert to file management with the SAME key bytes                                       | No key ever printed; conversion is a documented stop-server procedure; `--workspace` DEK rotation still allowed                  |
| U5  | Per-workspace DEK rotation                | n/a                                       | `tokenhop keys rotate --workspace <id>` / `POST /api/workspaces/[id]/keys/rotate`, owner-only, synchronous, counts-only response                   | Default workspace's DEK rotation re-encrypts instance SSO/MITM secrets in same transaction; no progress UI (sub-second)          |
| U6  | Missing key at startup                    | n/a (plaintext DB starts)                 | Fail closed: sticky readiness rejection, exit 78, serve nothing, "Nothing was changed"                                                             | Never auto-generate, never plaintext fallback (D3); dashboard shows same text as static 503                                      |
| U7  | Wrong/corrupt key at startup              | n/a                                       | Fail closed `KEY_MISMATCH`, names expected vs tried kid                                                                                            | Same two-path recovery copy as U6                                                                                                |
| U8  | Locked connection after accepted key loss | connection renders normally               | Badge "Locked — re-link required" + Re-link action replaces credential-dependent actions                                                           | Metadata lists never decrypt, so lists stay fast and complete; per-row decrypt failure = typed error on use only (D3)            |
| U9  | Export backup                             | plaintext JSON downloaded, generic status | Status line after download: credentials are locked in the file; master key NOT in the file; keep file and key apart                                | No new dialog; extends shipped `DataSection.js` copy                                                                             |
| U10 | Restore (import)                          | format-facts warning shipped (v2)         | Preflight proves root + wraps before any wipe; mismatch/missing key → zero mutation; plaintext legacy payload into encrypted instance rejected     | Extend shipped restore dialog with encrypted-backup facts; confirm button stays disabled until password + facts acknowledged     |
| U11 | Old backups (pre-activation)              | treated as ordinary backups               | Restore dialog + docs warn: backups made before encryption hold credentials in readable form                                                       | Deletion of data later does not clean those copies (D7)                                                                          |
| U12 | Workspace deletion                        | plain confirm (if any)                    | Typed-name confirmation; states live-key destruction and its limits                                                                                | Default workspace undeletable: `409 DEFAULT_WORKSPACE_PROTECTED`, zero mutation, dialog shows "protected" instead                |
| U13 | Rotation vs old backups                   | n/a                                       | Rotation receipt reminds: backups taken before rotation need the key current when they were taken                                                  | One line, printed once at rotation success                                                                                       |
| U14 | Gateway credential use after key loss     | provider auth error (opaque)              | Typed upstream-shaped error naming locked connection                                                                                               | Same tier as any provider auth failure; no new client contract                                                                   |
| U15 | MITM sudo legacy re-key at activation     | silent                                    | On undecryptable legacy value: typed error + guidance to re-enter or clear sudo password                                                           | Never silently null (D11)                                                                                                        |

## T2 — CLI: `tokenhop keys rotate` exact semantics

| Aspect          | Value                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invocations     | `tokenhop keys rotate [--dry-run] [--yes] [--json] [--port <port>]` (KEK); add `--workspace <id>` for DEK rotation                                                                                                                   |
| Transport       | Loopback to running server, CLI owner principal (D8); no offline mode — the CLI is a client of the rotation service (spec: "CLI calls these routes over loopback")                                                                   |
| Confirm         | `Rotate now? [y/N]` — default No; `--yes` for scripts; `--dry-run` prints plan, exit 0, no mutation                                                                                                                                  |
| Plan block      | key source (file path or `env: TOKENHOP_MASTER_KEY`), workspace count, connection count, current kid, retained-old-key path (proposed: spec stages the old key during rotation; retention after finalize is an Open item for parent) |
| Success receipt | new kid, counts, `verified: true`, duration, backup reminder (U13)                                                                                                                                                                   |
| Failure         | typed code + one-line cause + `ref` log id; exit non-zero; pre-mutation failures print "Nothing was changed"                                                                                                                         |
| Secret surface  | none — no key bytes ever printed, including env-managed refusal (U4)                                                                                                                                                                 |

Copy blocks (each ≤5 lines):

```
$ tokenhop keys rotate --dry-run
Key rotation plan
  Key source:     file (/home/ops/.tokenhop/keys/master)
  Workspaces:     4 (14 connections)
  Current key id: 9f2ab41c0d3e7a56
  Rewraps per-workspace keys only; connection data is not rewritten.
  Previous key kept as: /home/ops/.tokenhop/keys/master.old-9f2ab41c0d3e7a56
```

```
Rotated in 1.8s. New key id: 5d81e03a7b9c2f14. 4 workspaces rewrapped, 14 connections verified.
Back up the new key the same way as before.
Backups made before this rotation still need the key that was current then.
```

```
✗ KEK_ENV_MANAGED: the master key comes from TOKENHOP_MASTER_KEY and cannot be
  rotated in place. Nothing was changed. To move it to a file: stop the server,
  write the SAME current key to DATA_DIR/keys/master (0600), unset the env var,
  restart. Never create a different key for this. Docs: key backup and recovery.
```

Same steps are in the API `guidance` field (T3); CLI prints the API response text.

## T3 — Admin API: exact responses, errors, semantics

| Endpoint / case                                 | Status | Body (exact fields, no secrets)                                          |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| `POST /api/settings/keys/rotate` success        | 200    | `{ "kekKid": "<new>", "workspacesRewrapped": <n>, "verified": true }`    |
| `POST /api/workspaces/[id]/keys/rotate` success | 200    | `{ "workspaceId": "<id>", "dekKid": "<new>", "fieldsReencrypted": <n> }` |
| unauthenticated                                 | 401    | `{ "error": { "code": "UNAUTHORIZED" } }`                                |
| non-owner                                       | 403    | `{ "error": { "code": "FORBIDDEN" } }`                                   |
| switch off (any new route)                      | 404    | `{ "error": "Not found" }` — indistinguishable from unknown route        |
| env-managed KEK, KEK rotate                     | 409    | `{ "error": { "code": "KEK_ENV_MANAGED" } }` + guidance body (below)     |
| rotation/startup lock held                      | 409    | `{ "error": { "code": "LOCKED" } }`                                      |
| delete Default workspace                        | 409    | `{ "error": { "code": "DEFAULT_WORKSPACE_PROTECTED" } }`, zero mutation  |
| key missing/mismatch/integrity                  | 503    | `{ "error": { "code": "KEY_UNAVAILABLE" } }`                             |
| unknown workspace (DEK rotate)                  | 404    | `Not found`                                                              |

`KEK_ENV_MANAGED` guidance body (fields, not prose blob):

```
{ "error": { "code": "KEK_ENV_MANAGED",
  "guidance": {
    "step1": "Back up the database and the current TOKENHOP_MASTER_KEY value separately.",
    "step2": "Stop the server. Write the SAME current key as 32 raw bytes to DATA_DIR/keys/master (0600, inside 0700 keys/).",
    "step3": "Remove TOKENHOP_MASTER_KEY from deployment configuration. Restart.",
    "step4": "Verify the stored KEK kid and that gateway keys still authenticate. Then rotate.",
    "warning": "Never generate a different key for this conversion or overwrite an existing key file without proving identity." } } }
```

Semantics: owner-only capability (`keys.rotate` in YAN-357 route → capability map); empty POST body; audit row records actor, old/new kid, counts, result — never key material; per-workspace DEK rotation stays available under env KEK (U4).

## T4 — Backup and destructive-confirmation semantics

| Moment                               | Confirmation / warning (exact duty)                                                                                                                                                           | Constraint                                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| First enable (U1)                    | Key path + "Back it up now, separately from the database. If this file is lost, every stored connection must be re-linked manually. There is no recovery."                                    | Once per key materialization; pre-activation backup stated as the one-time plaintext fallback                           |
| Export download (U9)                 | "Backup downloaded. Credentials inside it are locked. The master key is not in the file — keep the key and this file in different places."                                                    | Status line, no dialog                                                                                                  |
| Restore, encrypted backup (U10)      | Extend shipped dialog: preflight must pass before wipe; on `KEY_UNAVAILABLE`/mismatch show expected vs backup kid, "Nothing was changed"                                                      | Confirm disabled until password entered + facts read; preflight precedes any mutation (D8)                              |
| Restore, pre-encryption backup (U11) | "This backup was made before encryption: it holds credentials in readable form. Deleting data later does not clean this file."                                                                | Plaintext payload into encrypted instance is rejected, zero mutation (D8)                                               |
| Workspace delete (U12)               | Typed exact workspace name; copy: "This destroys the workspace's key in the live database. Credentials in this database can no longer be read. Copies inside older backups are not affected." | Focus on Cancel; confirm disabled until match; Default shows protected 409 dialog; DEK-rotate and delete share one lock |
| Rotation success (U13)               | "Backups made before this rotation still need the key that was current then."                                                                                                                 | Printed once in receipt                                                                                                 |
| Accepted key loss (U8)               | "Stored credentials cannot be recovered without the key. Connections will be listed but marked locked — re-link required. Users, keys, settings and usage history are not affected."          | Shown once at loss confirmation                                                                                         |
| Startup fail-closed (U6/U7)          | `KEY_MISSING`/`KEY_MISMATCH` block: expected file or env, kids compared, "The server is not starting", two exits (restore key / accept loss), "Nothing was changed", exit 78                  | Dashboard renders same text statically (503), no DB reads                                                               |

## T5 — Requirements mapping (UX row → spec rule / decision / criterion)

| UX row | Feature-spec anchor                                                                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------- |
| U1, U2 | BR1 off-unchanged, BR2 latch; activation after verified backup (spec Phasing); D4                                    |
| U3     | BR7 gateway keys survive rotation; D6 (kid split — receipt prints new KEK kid, never hash kid), D8 rotation in scope |
| U4     | BR8; D9 (refusal, same-bytes conversion, DEK rotate allowed)                                                         |
| U5     | BR9 owner-only; D5 (Default re-encrypts instance secrets same transaction)                                           |
| U6, U7 | BR3 fail closed; D3 (sticky readiness, never regenerate/plaintext); C4                                               |
| U8     | D3 per-row typed errors, metadata listing unaffected; BR10 honest shredding                                          |
| U9     | D8 ciphertext snapshots; C9 same-KEK export/import recovers                                                          |
| U10    | EC "wrong or missing key rejected before wipe"; C4; D8 preflight proof                                               |
| U11    | D7 old copies documented (pre-activation backups stay plaintext)                                                     |
| U12    | D5 Default protected; D7 shredding limited to live state; C7 delete/cache                                            |
| U13    | D8 transfer versioning; D6 wrapped hash key in snapshot                                                              |
| U14    | EC per-row integrity failure → typed error on use (D3)                                                               |
| U15    | D11 MITM re-key typed error + re-enter/clear guidance                                                                |
| all    | BR9 nothing secret crosses HTTP; audit kid/counts only (spec advisories); C10 off-unchanged (404 new routes)         |

## Full Backstop

- Every feature-spec Business Rule 1–10 has ≥1 UX row; every decision D1–D11 that is operator-visible (D3–D9, D11) has exact copy or a table row; success criteria C1–C10 inherit UX surfaces only via U3/U5 (C5, C6), U10 (C4, C9), U12 (C7), U6 (C10 latch side).
- Coverage gaps intentionally deferred (not YAN-365 UX): dedicated dashboard Keys page (read-only status row only if parent asks — U1/U2 Callout is the shipped surface); passphrase-wrapped export (hardening issue); two-key env rotation protocol (D9 deferred — never hint at it as available).
- No-secret rule asserted per row: kids (`credentialsKekKid` 16-hex, DEK `dk_<16 hex>`) are public identifiers; counts, paths, durations are operator-owned facts; nothing else crosses any surface.
- Fail-closed wording is uniform: every pre-mutation failure says "Nothing was changed"; no error suggests deleting data as first resort.
- Parent-validated overrides honored here over the earlier `research-ux.md`: env rotate = 409 + same-bytes conversion guidance (replaces `--stdout-new-key`); startup fail-closed is settled (former Open Question 1 resolved by D3); shredding claims carry D7 limits.

## Final Tables (canonical)

T1–T5 above are canonical; this is the final UX Design table (condensed, same rows) after the backstop. Proposed-not-in-spec items are marked P.

| #       | Before                                        | After                                                                                      | Interaction change                                                 |
| ------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| U1      | No key duty                                   | Startup log: key path/kid + backup warning; optional Data & backup Callout (P)             | Once per key materialization                                       |
| U2      | none                                          | P: "I've saved the key" ack                                                                | Never gates activation                                             |
| U3      | no command                                    | `keys rotate`: plan, y/N default No, verify counts, new-kid receipt                        | `--workspace`, `--port`; P: `--dry-run/--yes/--json`, old-key path |
| U4      | n/a                                           | `409 KEK_ENV_MANAGED`, zero mutation, same-bytes file conversion guidance                  | No key printed; DEK rotate allowed                                 |
| U5      | n/a                                           | DEK rotate owner-only, counts-only response                                                | Default DEK re-encrypts SSO/MITM secrets                           |
| U6/U7   | plaintext starts                              | Fail closed `KEY_MISSING`/`KEY_MISMATCH`, exit 78, "Nothing was changed"                   | No regenerate, no plaintext fallback                               |
| U8      | n/a                                           | "Locked — re-link required" badge                                                          | Lists never decrypt                                                |
| U9/U10  | plaintext export; format-only restore warning | Locked-credentials export note; restore preflight, zero mutation on wrong/missing key      | Plaintext payload rejected on encrypted instance                   |
| U11     | ordinary backups                              | Pre-encryption and older backups warned as readable; deletion does not clean them          | D7 limits stated                                                   |
| U12     | plain confirm                                 | Typed workspace name; live-key destruction only; Default `409 DEFAULT_WORKSPACE_PROTECTED` | Focus Cancel                                                       |
| U13–U15 | n/a                                           | Old-backup key reminder; typed per-use lock error; MITM re-key typed error                 | One-time or per-use, never silent                                  |
