# Security, Keys and Backups

How tokenhop protects stored credentials when users & teams is on, what it does not protect against, and how to back up, rotate and restore safely.

> This page applies once users & teams is on (Settings → Instance, or `TOKENHOP_MULTI_USER=on`). It is available from v1.1.0 and off by default.

Read [Concepts](/en/users/concepts) first for the vocabulary (workspaces, roles, keys). Sign-in setup is in [SSO](/en/users/sso); workspace administration is in [Teams](/en/users/teams).

---

## Encryption at Rest

Once users & teams is on (`TOKENHOP_MULTI_USER=on`) and the instance has started, tokenhop encrypts stored credentials with AES-256-GCM envelope encryption:

```
master key (KEK)
  └─ wraps one data key (DEK) per workspace
        └─ encrypts that workspace's credential fields
```

- The **master key** is never stored in the database. It is either the `TOKENHOP_MASTER_KEY` environment variable or the file `DATA_DIR/keys/master`.
- Every workspace has its **own data key**. A ciphertext copied from one connection or workspace to another fails authentication instead of decrypting.
- The master key also protects the key used to hash gateway API keys.

### What is encrypted

- Provider connection tokens and API keys: `accessToken`, `refreshToken`, `idToken`, `apiKey`.
- Secrets inside provider-specific data, such as `clientSecret`, `copilotToken`, `cookie` and `secretAccessKey`.
- Custom provider node secrets, such as `apiKey` and `authHeader`.
- Instance SSO and MITM secrets: `oidcClientSecret`, `samlPrivateKey`, `samlDecryptionKey`, `samlSigningKey`, `mitmSudoEncrypted`.

### What is not encrypted

- Proxy pool data, including proxy URLs that contain credentials.
- Password hashes and API-key hashes (these are already one-way hashes).
- The dashboard JWT secret file, environment secrets, and usage and request tables.
- Non-secret metadata such as connection names and plan tiers.

### When it turns on

- Encryption activates at startup, only when the switch is on. First activation is restart-only: turn on **Users & teams** in **Settings → Instance**, or set `TOKENHOP_MULTI_USER=on`, then restart. After that, the dashboard toggle switches users & teams on and off without a restart, and credentials stay encrypted either way.
- Before the first activation, tokenhop writes a verified, private backup of the database (see [Backups made at activation](#backups-made-at-activation)).
- After activation storage stays encrypted, even if the switch is later turned off.
- An install that has never activated and keeps the switch off is unchanged: no master key, no data keys, nothing encrypted.

### What it does not protect against

Encryption protects against a stolen database file, backup or export read **without the master key**. It does **not** protect against:

- The instance administrator or anyone with shell access to the running host.
- A compromised running tokenhop process, a memory dump, or root on the host.

tokenhop needs the master key in memory to refresh OAuth tokens unattended, so the running instance can always decrypt. Treat the host as the trust boundary.

---

## Back Up Your Master Key

> **Losing the master key means losing every encrypted credential.** There is no recovery and tokenhop never regenerates or replaces a missing key.

Back up the key with the same care as the database, **but keep it separate from database backups**. A database backup without its key is not a restore path.

### Where the key lives

| Source                                  | Format                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `TOKENHOP_MASTER_KEY` environment value | Canonical base64 encoding of exactly 32 bytes                                              |
| `DATA_DIR/keys/master` file             | 32 raw bytes, mode `0600` inside a `keys/` directory of mode `0700` (Unix permission bits) |

Set at most one source. If both are present, the environment variable silently wins, so remove one to keep the active key unambiguous. If neither is set, the first activation creates the `keys/master` file for you.

To see which one your instance uses (no network, the value is never printed):

```bash
tokenhop keys backup-hint
```

### What happens if the key is lost or wrong

- A missing or corrupt key blocks startup until you restore the matching key. The server does not fall back to plaintext and does not generate a new key.
- A wrong key is rejected at startup before anything is changed.
- Credentials encrypted under the lost key cannot be recovered. You would need to re-link your providers.

### Docker and containers

Persist `DATA_DIR/keys/master` (it lives under the data volume) or provide `TOKENHOP_MASTER_KEY`. Recreating a container without either loses access to encrypted credentials.

### Do not

- Commit the key or put it in a shared `.env` file.
- Store it in the same place as your database backups.
- Upload it anywhere through the dashboard. There is no web upload; provision the env value or the private file on the host yourself.

---

## Rotating the Master Key

Rotation runs against the **running** server on the same machine, as the instance owner. It needs users & teams on (otherwise it answers "not available").

```bash
tokenhop keys rotate [--workspace <id>] [--port <port>] [--yes]
```

| Command                                 | What it does                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `tokenhop keys rotate`                  | Rotates the master key (KEK) and re-wraps every workspace data key and the API-key hash key |
| `tokenhop keys rotate --workspace <id>` | Rotates only that workspace's data key and re-encrypts its credential rows                  |
| `--port <port>` / `-p`                  | Server port (default `20128`); pass it to match the port tokenhop listens on                |
| `--yes` / `-y`                          | Skip the confirmation prompt                                                                |

Without `--yes` the command asks for confirmation (default is No) and sends nothing until you confirm. It prints key ids and counts only, never key material.

### Master key rotation notes

- Master key rotation only re-wraps data keys, so it is fast regardless of how many credentials you have.
- It **replaces** the live key and does **not** keep the old one. **Back up the new key immediately.**
- Backups made before the rotation can only be restored with the previous key. Keep that key offline if those backups must stay restorable.
- Owner-only HTTP equivalents exist: `POST /api/settings/keys/rotate` (master key) and `POST /api/workspaces/{id}/keys/rotate` (one workspace). Both answer 404 while users & teams is off.

### If `TOKENHOP_MASTER_KEY` is set

Master key rotation is refused with HTTP 409 and code `KEK_ENV_MANAGED`, because tokenhop cannot rewrite an environment variable. Workspace data key rotation still works. To move to a file-managed key so you can rotate:

1. Stop the server.
2. Put the **same current 32 raw key bytes** in `DATA_DIR/keys/master`, mode `0600`, inside a `keys/` directory of mode `0700`.
3. Remove `TOKENHOP_MASTER_KEY` and start the server.
4. Check that startup and gateway authentication still work, then rotate.

Do not generate a different key for this conversion.

---

## Backups Made at Activation

Turning users & teams on, and rotating the master key, write backups under `DATA_DIR/db/backups/` before they change your data:

| Prefix                              | Written before                    |
| ----------------------------------- | --------------------------------- |
| `gateway-key-activation-`           | Gateway API keys are hashed       |
| `credential-encryption-activation-` | Credentials are first encrypted   |
| `pre-import-`                       | Every instance restore            |
| `users-bootstrap-`                  | The owner is created at bootstrap |

The first three are protected and exempt from automatic pruning. `users-bootstrap-` is a plain backup and **can be pruned** automatically. `credential-encryption-activation-` backups are also written at each master key rotation; those hold already-encrypted data, not plaintext.

Because activation backups are taken **before** the change, they can contain plaintext credentials and raw gateway keys. Older rolling backups and earlier exports can too.

- Protect them like the master key, or delete them once you are confident in the upgrade.
- Activation cleans plaintext out of the live database, not out of historical copies.
- Restoring an activation backup is a manual recovery step. Hashes cannot be reversed, so stopping users & teams does not bring raw key display back.

Upgrading from tokenhop v1.0.x? The restart-only activation procedure, the data directory lock and rollback notes are in [UPGRADING.md §6](https://github.com/tokenhop/tokenhop/blob/master/UPGRADING.md).

---

## Export and Import

tokenhop has two kinds of backup file. They are separate features with different scope and permissions.

|               | Workspace export          | Instance export                   |
| ------------- | ------------------------- | --------------------------------- |
| Who           | Workspace owner           | Instance owner or admin           |
| Scope         | One workspace's resources | The whole instance                |
| Passphrase    | Required                  | Optional                          |
| Restores into | A workspace you own       | This instance, replacing its data |

Both need **re-authentication** every time. See [Re-authentication](#re-authentication).

### Workspace export and import

Moves one workspace's configuration to another workspace, possibly on another instance.

**Included:** provider connections, custom provider nodes, combos, model aliases, custom models, disabled models, and the workspace's setting overrides.

**Never included:** users, memberships, grants, budgets, usage, audit records or other workspaces.

How it works:

- Credentials are **decrypted with the source workspace's data key and re-sealed** under a fresh random key that is protected only by your passphrase. The file never contains the master key or any raw key material.
- A passphrase is required to export and to import. Choose a strong one and store it separately from the file. tokenhop cannot recover a lost passphrase.
- Import checks every credential in the file **before changing anything**, then creates new ids and re-encrypts under the destination workspace's data key.
- Import is all-or-nothing. If a name or key collides with something already in the destination, the whole import is refused (HTTP 409 `TRANSFER_CONFLICT`) with a short list of conflicts.
- You must be the **owner** of the workspace you export from or import into. Other members get 403; non-members get 404.
- Available in the dashboard under **Settings → Data & backup → Workspace backup** (for workspaces you own; needs the workspace owner role) and over the API at `POST /api/workspaces/{id}/export` and `/import`.

### Instance export and import

A full backup of the instance, from **Dashboard → Settings → Data & backup** (or `GET` / `POST /api/settings/database`).

**Included:** settings, users and identities, workspaces and memberships, connections, combos, grants, budgets, hashed API keys, invitations, audit events and usage history. It carries **ciphertext and wrapped keys, never the master key.**

> Treat the file as sensitive: it contains password hashes and provider credentials.

Two flavors, depending on the passphrase:

- **No passphrase.** The file keeps credentials encrypted under this instance's master key. To restore, the destination must be started with **the same master key**. Restoring with a different key is refused (`TRANSFER_ROOT_MISMATCH`) before anything is changed.
- **With a passphrase** (users & teams on, credentials encrypted). The file also contains the key graph sealed by your passphrase, so you can restore onto an instance with a **different master key** by supplying the passphrase and the destination's own key. Importing a passphrase-protected file without the passphrase is refused (`TRANSFER_PASSPHRASE_REQUIRED`). Repeated wrong passphrases are rate-limited per IP.

Restore behavior:

- It **replaces** the instance's data. tokenhop first proves the master key and checks the file, then takes a protected `pre-import-` backup, then replaces tables. A failure before that point changes nothing.
- If the backup's users differ from the current instance, the restore is refused with 409 `IMPORT_USER_MISMATCH` and a metadata-only diff. Only the **instance owner** can override this by forcing the restore, which replaces the differing users.
- The `multiUserEnabled` setting inside a backup is ignored, so a restore never flips the users & teams switch.
- Encrypted instances accept only format v3 exports. The one exception is an older, pre-encryption backup restored while users & teams is on, which is imported into the Default workspace. Other plaintext and older formats are rejected. Portable configuration export (settings only) never includes secrets.
- Large restores stream. The accepted body size is the smaller of `TOKENHOP_INSTANCE_IMPORT_MAX_BODY_SIZE` and `TOKENHOP_PROXY_CLIENT_MAX_BODY_SIZE` (default `128mb`).

Deleting a workspace removes its data key from the live database. That does not remove copies of the wrapped key inside older backups. The Default workspace cannot be deleted.

### Re-authentication

Every export and import proves **who is acting**, with exactly one of these:

- **Password.** Their own current password, checked in the same request. Failures count against the login rate limit. Being logged in or holding the CLI token is not enough once users & teams is on.
- **One-time SSO proof**, for accounts that sign in only with SSO and have no password. In the dashboard, start a fresh sign-in at your identity provider for that exact action. When it completes you get a single-use proof, valid for about **5 minutes**, bound to that action, that user and (for workspace actions) that workspace. It works for browser sessions only, not CLI tokens, and does not create a login session.

Without a usable proof the request is refused (`reauth_required`, or `reauth_unsupported` for an SSO-only account that tries a password).

---

## Locked Out

Two host-local commands recover access. Both talk to the running server on the same machine and need users & teams on.

### Setup token: link the owner's SSO account

Mints a single-use owner setup token, valid for 60 minutes:

```bash
tokenhop auth setup-token [--port <port>]
```

Open `/api/auth/oidc/start?setupToken=<token>` (or `/api/auth/saml/start?setupToken=<token>`) on your instance and sign in with the owner's SSO account. This is the same path used on a fresh SSO install, and linking is permanent. Open the link in a private window and don't share it; the token is single-use and expires after 60 minutes. Setting `TOKENHOP_OWNER_EMAIL` is the alternative: the first SSO login whose verified email matches is linked to the owner, once. See [SSO](/en/users/sso).

### Reset mode: return to password login

If SSO-only sign-in locks you out (for example the identity provider is down):

```bash
tokenhop auth reset-mode password [--port <port>]
```

This restores password login for the owner. If the owner has no local password, the command prompts twice (hidden) for a new one. It only works from the same machine, as the owner, and the CLI token is never printed.

---

## Quick Checklist

- [ ] Master key is backed up, separate from database backups
- [ ] Docker or container deployments persist `DATA_DIR/keys/master` or set `TOKENHOP_MASTER_KEY`
- [ ] You know where the activation backups are and have protected or removed them
- [ ] Instance exports use a passphrase if you may restore with a different master key
- [ ] After rotating the master key, the new key is backed up and the old one is kept offline if old backups matter
- [ ] Nobody expects encryption to protect against the host administrator

---

## Next Steps

- [Concepts](/en/users/concepts): users, workspaces, roles and keys
- [SSO](/en/users/sso): OIDC and SAML sign-in and owner linking
- [Teams](/en/users/teams): invitations, members and workspace administration
