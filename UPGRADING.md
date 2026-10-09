# Upgrading from 9router

This guide explains what happens when an existing 9router install upgrades to
**tokenhop v1.0.0**. tokenhop is this project's new name — same code, same data,
new name everywhere a user sees it. Everything below describes v1.0.0 behavior.

## 1. TL;DR

**There is nothing you need to do.** Upgrade by swapping the binary, npm package
or container image; your data, API keys, tool configs, SSO, MITM trust and
autostart keep working.

What changes automatically on the first v1.0.0 start:

- The dashboard, login, landing page, tray and CLI say **tokenhop**.
- If your data lives in the legacy `~/.9router` directory it is used as-is, with
  one log line pointing at the optional `tokenhop data migrate` command.
- Legacy `NINEROUTER_*` / `NINE_ROUTER_*` environment variables keep working and
  log one deprecation line per process.
- A legacy autostart entry is replaced by the tokenhop one the first time the
  tray starts.
- A still-running 9router launcher is stopped when tokenhop starts.
- Tool configs written by 9router are detected and migrated in place the next
  time you Apply from **Dashboard → CLI tools**.
- Backups download as `tokenhop-backup-<stamp>.json`; old `9router-backup-*.json`
  files import unchanged.

Everything legacy that still works in v1.x is listed in
[§13 Removed in v2.0.0](#13-removed-in-v200).

## 2. Data directory

The default data directory moves from `~/.9router` (macOS/Linux) and
`%APPDATA%\9router` (Windows) to `~/.tokenhop` / `%APPDATA%\tokenhop`.

Resolution order when `DATA_DIR` is unset:

| State                         | Used          | Notice                                            |
| ----------------------------- | ------------- | ------------------------------------------------- |
| Only `~/.tokenhop`            | `~/.tokenhop` | —                                                 |
| Only `~/.9router`             | `~/.9router`  | One `[DATA_DIR]` log line with the hint           |
| Both                          | `~/.tokenhop` | One "legacy ignored" log line + dashboard callout |
| Neither                       | `~/.tokenhop` | —                                                 |
| `DATA_DIR` set (incl. Docker) | `DATA_DIR`    | Defaults not checked                              |

The two directories are never merged, and nothing is deleted automatically.

**Optional move.** With tokenhop stopped:

```bash
tokenhop data migrate --dry-run   # print the plan, change nothing
tokenhop data migrate             # perform the move
```

The command refuses to run while the server may be running (a live PID recorded
in either directory, or something listening on the port), when `DATA_DIR` is
set, or when the target is not empty. On the same filesystem it is a single
rename. Across filesystems it copies, verifies every file and runs
`PRAGMA integrity_check` on the database, then keeps the original as
`~/.9router.migrated-<timestamp>` — delete it yourself once you are satisfied.
It is idempotent (a second run prints `already migrated`), and it only ever
removes its own failed partial copies.

**Docker is unaffected:** the image always sets `DATA_DIR=/app/data`, so the
defaults above never apply inside a container.

### Automatic backups and recovery

Before a schema migration the server copies every database table, including
the users and teams tables, into `DATA_DIR/db/backups/`. The only exclusion is the
`requestDetails` request log. The newest three ordinary backups are kept.

- Once credential encryption is active, backups contain credential ciphertext
  and wrapped per-workspace data keys. They never contain the master key
  (`TOKENHOP_MASTER_KEY` or `DATA_DIR/keys/master`); decrypting credentials
  requires the matching key. Preserve that key separately and protect it.
  Before encryption is active, and in activation backups, credentials may be
  plaintext: protect these copies at least as carefully as the live database.
- A backup also holds user, identity, password-hash and session-version data.
  Treat the backup directory as sensitive: restrict access and never share it.
- There is no automated restore. Stop tokenhop completely, then preserve the
  current `DATA_DIR/db/data.sqlite` and any `data.sqlite-wal` and
  `data.sqlite-shm` files together in a separate recovery directory. Copy the
  backup's `data.sqlite` into `DATA_DIR/db/`, with no old WAL or SHM files left
  there. Provide the matching master key if encryption was active, then start
  tokenhop. Keep the preserved files until recovery is verified.

### Workspace export and import

With Users & teams enabled, an active workspace owner can transfer that
workspace from Settings. Each operation requires the acting user's password;
SSO-only accounts without a local password cannot use this workflow.
A backup passphrase is required. Keep it separately: credentials are encrypted
and bound to their source rows; the instance master key and API keys are not exported.
Only import trusted files: credential leaves are authenticated, but nonsecret
names, model configuration and preferences are not tamper-authenticated.
Imports create fresh IDs and remap node references. Resource, name and KV conflicts
reject the whole import. Preferences merge with incoming values winning while
preserving destination-only entries. Full-instance JSON backups include telemetry
and request details; automatic database backups exclude `requestDetails`.

## 3. Environment variables

Product variables are renamed to `TOKENHOP_*`. The legacy names keep working
through v1.x; when both spellings are set, the new one wins. The four runtime
variables at the top of the table log one deprecation line per process naming
their replacement. The last three rows are not read as process variables: they
are skill instructions and a jcode config entry, so they log nothing. All legacy
names are removed in v2.0.0.

| Legacy (removed in v2.0.0)              | New                                   |
| --------------------------------------- | ------------------------------------- |
| `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE` | `TOKENHOP_PROXY_CLIENT_MAX_BODY_SIZE` |
| `NINE_ROUTER_API_KEY`                   | `TOKENHOP_API_KEY`                    |
| `NINE_ROUTER_DISABLE_MITM`              | `TOKENHOP_DISABLE_MITM`               |
| `NINEROUTER_CLI_APP_DIR`                | `TOKENHOP_CLI_APP_DIR`                |
| `NINEROUTER_URL` (agent skills)         | `TOKENHOP_URL`                        |
| `NINEROUTER_KEY` (agent skills)         | `TOKENHOP_KEY`                        |
| `JCODE_9ROUTER_API_KEY` (jcode config)  | `JCODE_TOKENHOP_API_KEY`              |

A few internal names are plain renames with no alias because users could never
set them (`NINEROUTER_PEER_TOKEN` → `TOKENHOP_PEER_TOKEN`, rewritten at every
boot, and the `NINE_ROUTER_PROXY_*` in-process bookkeeping). Variables such as
`JWT_SECRET` and `DATA_DIR` never had a brand name and are
unchanged.

## 4. CLI

The CLI is now the npm package **`tokenhop`** with a `tokenhop` binary:

```bash
npm i -g tokenhop      # install
tokenhop               # start
npx tokenhop           # without installing
```

There is **no `9router` alias**: `9router` on npm belongs to the upstream
project ([decolua/9router](https://github.com/decolua/9router)) and this project
never publishes it. Installing `tokenhop` does not remove an older CLI installed
under the `9router` name — run `npm rm -g 9router` yourself once you have moved
over.

**Autostart migrates by itself.** The first time the tokenhop tray starts, it
replaces the legacy login item with the new one, keeping your port and host:

| OS      | Legacy                                | New                                    |
| ------- | ------------------------------------- | -------------------------------------- |
| macOS   | `com.9router.autostart`               | `dev.tokenhop.autostart`               |
| Linux   | `~/.config/autostart/9router.desktop` | `~/.config/autostart/tokenhop.desktop` |
| Windows | Startup folder `9router.vbs`          | Startup folder `tokenhop.vbs`          |

On macOS the old launchd agent keeps running until logout (the migration never
touches `launchctl`, so it cannot start a second launcher or kill the current
one); the new plist loads at the next login. Enable/disable always affects both
names. A 9router launcher still running when tokenhop starts is detected through
its `9router.pid` record and stopped.

**Beta users:** if you tried a `v1.0.0-beta.N` tokenhop build and went back to a
9router (v0.6.x) build, that build also detects and removes a leftover
`tokenhop.*` autostart entry when it manages autostart, so you get no hidden
login item and no double launch.

## 5. Tool integrations

**Dashboard → CLI tools** detects configs written by 9router automatically (the
status shows configured), and the next **Apply** migrates the legacy entry in
place to the tokenhop one. Models, extra fields, defaults and unrelated config
are kept. **Reset** removes both names, so resetting with tokenhop still cleans
up configs 9router wrote. Configs you never re-apply keep working unchanged.

| Tool                  | Config file(s)                                                 | What the next Apply migrates                                                                                                                         |
| --------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex                 | `~/.codex/config.toml`, `~/.codex/auth.json`                   | `[model_providers.9router]` → `[model_providers.tokenhop]`; `model_provider` and profiles repointed; extra fields and headers kept                   |
| jcode                 | `~/.jcode/config.toml`, `~/.config/jcode/provider-9router.env` | `[providers.9router]` → `[providers.tokenhop]`; `default_provider` repointed; env file becomes `provider-tokenhop.env` with `JCODE_TOKENHOP_API_KEY` |
| Grok Build            | `~/.grok/config.toml`                                          | `[model.9router*]` slots, `9router-prev-*` markers, the `__9router_unset__` sentinel and defaults renamed                                            |
| DeepSeek TUI          | `~/.deepseek/config.toml`                                      | No brand name stored; Apply rewrites the whole file pointing at tokenhop                                                                             |
| Hermes                | `~/.hermes/config.yaml`, `~/.hermes/.env`                      | No brand name stored; Apply rewrites the `model:` block and `OPENAI_API_KEY`                                                                         |
| OpenCode              | `~/.config/opencode/opencode.json`                             | `provider["9router"]` → `provider["tokenhop"]`; `model` and `agent.*.model` refs repointed; models/options merged                                    |
| OpenClaw              | `~/.openclaw/openclaw.json`, per-agent `models.json`           | `models.providers["9router"]` → `["tokenhop"]`; primary/fallbacks/allowlist refs repointed                                                           |
| Kilo                  | `~/.local/share/kilo/auth.json` + VS Code settings             | Legacy-named auth entries dropped, superseded by the `openai-compatible` provider                                                                    |
| Droid                 | `~/.factory/` config                                           | Custom model ids `custom:9Router-N` → `custom:tokenhop-N`                                                                                            |
| Copilot               | Copilot extension config                                       | Entry `9Router` → `tokenhop` in place                                                                                                                |
| Cline                 | `~/.cline/data/globalState.json`, `secrets.json`               | No brand key stored; a base URL naming either brand still counts as ours; the third-party "9Router for GitHub Copilot" extension is untouched        |
| Claude, Cowork, Devin | Brand-neutral configs                                          | Nothing to migrate                                                                                                                                   |

## 6. API-key hashed storage (YAN-363)

Turn the users & teams switch on (env `TOKENHOP_MULTI_USER=on` or the stored
instance setting), then restart the server. **Activation is restart-only by
approved operator decision**: the hash migration runs during startup, before
the process accepts requests. There is no runtime drain or in-process switch.

Startup order: exclusive `DATA_DIR` writer lock → DB open/migrate → switch
resolution → strict owner/Default bootstrap → activation. Startup fails closed:
any rejection is sticky and the process serves nothing until a successful
restart.

- **Root key**: `TOKENHOP_MASTER_KEY` (canonical base64 of exactly 32 bytes) or
  `DATA_DIR/keys/master` (32 raw bytes, created `0600` in a `0700` directory).
  Set at most one source. The root travels separately from any export — a
  database export contains hashes, never the root or raw keys. Deploy a trusted
  root by provisioning the env var or private file on the host yourself; there
  is no web upload. Never auto-regenerated: after activation, a corrupt or
  missing root fails startup until you restore the matching root; a wrong root
  is rejected before any mutation (kid check), leaving DB and root untouched.
  Legacy installs with the switch off create no root and write nothing.
- **Switch-off after activation** keeps hashed storage durable
  (`hashed-compat`): hash validation, key management, routing and transfer
  continue; switch-off controls rollout, not established security.
- **Backups**: the mandatory pre-migration backup lives under
  `DATA_DIR/backups/gateway-key-activation-*` (`0600`/`0700`) and is exempt
  from auto-prune. Backup dirs and raw historical backups are preserved, not
  forensically erased. The v2 instance backup file contains identity/password
  hashes and provider credentials — protect it like the root itself.
- **Single writer**: one process owns `DATA_DIR` (`db-writer.lock`). Before
  recovery or any manual lock handling, **stop the old process first**. Startup
  removes a stale lock only when its owner PID is verifiably dead; an
  unverifiable lock fails with `DATA_DIR_UNVERIFIABLE_LOCK` /
  `DB_WRITER_LOCK_HELD`. Remove a lock or `*.guard` directory only after you
  have positively verified no tokenhop process is running — never `rm` blindly.
- **Remote MITM credential**: set exactly one of
  `TOKENHOP_MITM_REMOTE_API_KEY` or `TOKENHOP_MITM_REMOTE_API_KEY_FILE`
  (mutually exclusive) at parent startup; it stays in parent memory for child
  restarts and is never persisted, exported, or returned by status endpoints.
  A manual start may instead hand the credential in the start request; that
  binding is memory-only and tied to the router URL. The local MITM credential
  is separate, fresh every spawn; only its hash is stored.
- **Rollback**: restoring the pre-activation backup plus the previous raw-key
  schema is a manual recovery operation using the protected backup; hashes
  cannot be reversed. Stopping use of hashed mode does not restore raw display.

Rollout remains opt-in through the users & teams switch and restart-only.
Already-activated installs retain hashed storage when the switch is off.

## 7. Default key and headers

- **Default local key placeholder.** Configs Apply writes now use `sk_tokenhop`
  where they used `sk_9router`. Both are placeholders: gateway auth is a
  database key lookup, so configs still holding `sk_9router` keep working and
  the placeholder is never stored.
- **Token-saver opt-out.** Send `x-tokenhop-token-saver: off`. The legacy
  `x-9router-token-saver` header is still honored through v1.x with one
  deprecation warning.
- **Video connection pinning.** `POST /v1/videos/*` responses carry
  `x-tokenhop-connection-id`, and the legacy `x-9router-connection-id` header is
  emitted alongside it until v2.0.0. Clients poll with the brand-neutral
  `x-connection-id` header, which is accepted as before.

## 8. SAML

Existing SSO setups keep their issuer. An upgrade migration pins
`urn:9router:sp` on every existing settings row that never stored an issuer, and
a stored issuer is never touched — so the IdP trust survives the upgrade with no
action. New installs default to `urn:tokenhop:sp`.

To switch an existing install on purpose, update the SP issuer in
**Settings → Single sign-on** **and** update the entity ID at your IdP in the
same step. Changing only one side breaks login.

## 9. MITM CA

Your existing root CA is kept: same key, same certificate, same
`9Router MITM Root CA` name, and it stays trusted in every store — install,
uninstall and trust checks recognize both CA names. Nothing to do.

To re-issue it under the new name on purpose:

1. Turn MITM off and uninstall the certificate from the dashboard.
2. Delete `rootCA.key` and `rootCA.crt` under `<data dir>/mitm/`.
3. Turn MITM on again — a fresh `tokenhop MITM Root CA` is generated, and
   installing its trust needs admin rights once, exactly as on first install.

## 10. Docker

The image moved:

| Old (no new images)       | New                         |
| ------------------------- | --------------------------- |
| `ghcr.io/yandy-r/9router` | `ghcr.io/tokenhop/tokenhop` |

The old package stays available but receives no new builds; every tag from the
repo transfer onward publishes to the new path, including `1.0.0` and `latest`.

- **Compose users:** nothing to do. `compose.yml` keeps the named volume
  `9router-data` — renaming it would make Compose create a new, empty volume,
  which looks like data loss. Your data keeps working under the new image.
- **`docker run` users:** nothing to do. The image sets `DATA_DIR=/app/data`, so
  keep mounting your data at `/app/data` (`-v "$HOME/.9router:/app/data"` keeps
  working; the host path is yours to name). The image's `/root/.9router` and
  `/root/.tokenhop` links point at a separate in-container home, not at your
  data.

Optional move to a `tokenhop-data` volume (stop the container first):

```bash
docker volume create tokenhop-data
docker run --rm -v 9router-data:/from -v tokenhop-data:/to alpine cp -a /from/. /to/
# verify the copy, then change the volume's name: in compose.yml to tokenhop-data
# and only then remove the old volume: docker volume rm 9router-data
```

Developers using `compose.dev.yml` get fresh `tokenhop-dev-*` volumes; old
`9router-dev-*` volumes can be removed with `docker volume rm`.

## 11. Skills

Agent skills are renamed to `skills/tokenhop*`:

- Gateway URLs: `<base>/skills/tokenhop/SKILL.md`, `<base>/skills/tokenhop-chat/SKILL.md`, …
- Repo: <https://github.com/tokenhop/tokenhop/tree/master/skills/tokenhop>
- Environment: `TOKENHOP_URL` / `TOKENHOP_KEY`, with documented fallback to
  `NINEROUTER_URL` / `NINEROUTER_KEY` when those are the only ones set.

Old links keep working: a gateway serves the tokenhop skill under the old
`/skills/9router*/SKILL.md` URLs, and the old raw repo paths are pointer stubs
that send agents to the tokenhop skills.

## 12. Upstream-facing identifiers

A handful of identifiers this gateway sends to **third-party** APIs keep their
`9router` values on purpose — this is about what providers receive from us, not
about what you see. The full list lives in `UPSTREAM_CLIENT_IDS` in
`src/shared/brand/` and includes: the Kimi `X-Msh-Platform` header, the Cline
`User-Agent` product and `X-CLIENT-TYPE`, the Devin/Cowork/GLM MCP
`clientInfo.name`, Cursor's MCP provider identifier, the xAI OAuth `User-Agent`,
the Xiaomi MiMo OAuth `key_name` prefix, the GitHub/proxy test `User-Agent`, and
the Deno Deploy relay label.

They are kept because renaming an identifier an upstream might check (client
attribution, rate-limit buckets, allowlists) can break real users, and a rename
requires evidence the upstream ignores the value plus a live provider smoke
test. Some also label existing server-side state (Deno relays, Xiaomi keys)
that must not split by brand. There is nothing for you to do.

## 13. Removed in v2.0.0

Legacy support below is guaranteed through v1.x only. Every such branch is
marked `// legacy(9router): remove in v2` in the source. Plan to be off these
before v2.0.0:

- `NINEROUTER_*` / `NINE_ROUTER_*` environment variable aliases, including the
  `NINEROUTER_URL` / `NINEROUTER_KEY` skill fallbacks and `JCODE_9ROUTER_API_KEY`.
- The `~/.9router` / `%APPDATA%\9router` fallback data directory (run
  `tokenhop data migrate`).
- The `x-9router-token-saver` request header and the duplicate
  `x-9router-connection-id` response header.
- Legacy tool-config keys (`9router`, `9Router`, `custom:9Router-N`): detection,
  in-place migration and Reset support. Re-apply your tools before v2 so their
  entries carry the tokenhop name; configs still holding legacy keys stop
  working in v2.0.0.
- Legacy autostart entries (`com.9router.autostart`, `9router.desktop`,
  `9router.vbs`) and the `9router.pid` launcher record.
- The `/skills/9router*` gateway URLs and the `skills/9router*` pointer stubs.
- Legacy SAML issuer pinning (existing installs already carry their issuer).
- Recognition of `9Router MITM Root CA` in OS trust stores (re-issue the CA, §9).
- The `9router.` browser storage keys (dashboard endpoint/API-key presets are
  copied forward automatically).
- The `9router-data` volume-name pin in `compose.yml` (move the volume, §10).
