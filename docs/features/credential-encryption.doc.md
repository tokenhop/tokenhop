# Credential encryption at rest

YAN-365 encrypts selected credential fields in the database with AES-256-GCM envelopes. Each workspace has its own data-encryption key (DEK); the instance master key wraps workspace DEKs and the API-key hash key. The master key is never stored in the database.

## Coverage

Encrypted fields:

- Provider connection `accessToken`, `refreshToken`, `idToken`, and `apiKey`.
- Covered `providerSpecificData` secrets: `clientSecret`, `copilotToken`, `idToken`, `firebaseIdToken`, `mimoPassToken`, `cookie`, `apiKey`, and `secretAccessKey`.
- Provider-node secrets: `apiKey`, `accessToken`, `refreshToken`, `idToken`, and `authHeader`.
- Instance settings: `oidcClientSecret`, `samlPrivateKey`, `samlDecryptionKey`, `samlSigningKey`, and `mitmSudoEncrypted`.

Not encrypted by this feature: proxy-pool data (including credential-bearing URLs), password hashes, API-key hashes, the JWT secret file, environment secrets, and usage/request tables. See [YAN-365 decisions, D10](../plans/yan-365-envelope-encryption/decisions.md#d10--coverage-minimum-proxy-pools-flagged).

## Activation and startup

Activation runs at startup only when `TOKENHOP_MULTI_USER=on`. An install that has never activated encryption and starts with the switch off remains unchanged: no master key, DEKs, activation backup, or encryption marker are created. The durable marker latches encryption; after activation, storage remains encrypted even if the switch is later turned off.

On every encrypted startup, recovery proves the master key, unwraps and verifies the API-key hash key, and proves every workspace DEK. It does not decrypt every credential row. A corrupt row fails with a typed decryption error when that credential is used; it does not prevent dashboard startup or metadata listing. See `recover()` in `src/lib/db/activateCredentialEncryption.js`.

Missing or wrong master key blocks startup. The server does not regenerate a key or fall back to plaintext. Back up the key separately from the database: losing it makes encrypted data unavailable.

## Master key

Set `TOKENHOP_MASTER_KEY` to canonical base64 encoding of exactly 32 bytes, or let the server create `DATA_DIR/keys/master` containing 32 raw bytes. The file is mode `0600` inside a `keys/` directory mode `0700` (on platforms with Unix permission bits). The key is not stored in the DB. Back it up securely and keep it separate from database backups.

## Rotation

Run rotation against the running server as the instance owner:

```sh
tokenhop keys rotate [--workspace <id>] [--port <port>] [--yes]
```

Without `--workspace`, this rotates the KEK and rewraps all DEKs and the preserved API-key hash key. With `--workspace`, it rotates only that workspace's DEK and re-encrypts its covered rows. The default port is `20128`; without `--yes`, the CLI asks for confirmation.

Owner-only HTTP alternatives:

- `POST /api/settings/keys/rotate` rotates the instance KEK.
- `POST /api/workspaces/[id]/keys/rotate` rotates one workspace DEK.

Both routes return 404 when `TOKENHOP_MULTI_USER` is off. KEK rotation with `TOKENHOP_MASTER_KEY` set is refused with HTTP 409 and code `KEK_ENV_MANAGED`; workspace DEK rotation remains available. To move to file management, stop the server, put the **same current 32 raw key bytes** in `DATA_DIR/keys/master` with mode `0600` inside mode `0700` `keys/`, remove `TOKENHOP_MASTER_KEY`, restart, and verify the stored key ID and gateway authentication before rotating. Do not generate a different key for this conversion.

KEK rotation replaces the live file-managed key; it does not retain the old key. Backups made before rotation require the previous key. Keep that key offline if those backups must remain restorable.

## Backups, exports, and workspace deletion

First activation makes a verified, protected pre-encryption backup with prefix `credential-encryption-activation-`. That backup, older rolling/pre-import backups, older backups, and earlier exports may contain plaintext credentials. Activation cleans old plaintext pages from the live database, not from historical copies.

Encrypted-instance exports use format v3. They include ciphertext, wrapped keys, and encryption state, never the master key. Restore requires the same master key and proves the data before creating a backup or wiping existing data. Plaintext and older export formats are rejected for encrypted instances. Portable configuration export never includes secrets.

Deleting a workspace removes its DEK from the live database and evicts its cached key; this does not destroy wrapped keys in historical backups. The Default workspace cannot be deleted.

## Security boundary

Encryption protects against database, backup, and export disclosure without the master key. It does not protect against the instance administrator or a compromised running process, which can access credentials after decryption.

## References

- [YAN-365 decisions](../plans/yan-365-envelope-encryption/decisions.md)
