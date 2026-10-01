# 9Router (yandy-r)

A self-hosted AI routing gateway: one OpenAI-compatible endpoint (`/v1/*`) in front of
40+ upstream providers, with format translation, model-combo fallback, multi-account
rotation, OAuth credential management and usage tracking, plus a Next.js dashboard.

> This is a personal copy of [9Router](https://github.com/decolua/9router) by
> [decolua](https://github.com/decolua) and contributors, used under the MIT License.

## Dashboard

The Next.js dashboard defaults to dark for new installs, groups its sidebar into
**Route** (Home, Providers, Combos, Endpoint & keys), **Watch** (Usage, Quota, Console
log) and **Tune** (Token saver, CLI tools, Media providers, Proxy pools, Skills,
Settings), plus a **Debug** group with the Translator when it is enabled, and shows live
gateway status. Home is a command center for the endpoint and API keys, usage stats, live
routes, recent requests, quota, combos and provider health.

**Settings** (`/dashboard/settings`) is one page, grouped into Account, Traffic, Models &
usage and System tabs (the old `/dashboard/profile` and `/dashboard/settings/pricing` URLs
redirect there): General (theme, language, start page, density), Security & access,
Single sign-on, Routing, **Reliability** (retry/cooldown/backoff/stream-timeout policy —
previously hardcoded), Network, Token saver, Providers & models, Observability & logs,
Pricing, **Data & backup** (database location, backup download/restore, and a
config export/import for settings, combos and pricing overrides — secrets and provider
accounts are never included), Environment (read-only `.env` readout) and Danger zone.

### Screenshots

| Dark (default)                                             | Light                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| ![Dashboard, dark theme](images/signal-dashboard-dark.png) | ![Dashboard, light theme](images/signal-dashboard-light.png) |

## What's different here

- **Claude Code client fingerprint is configurable.** The identity sent on `claude`
  (OAuth) traffic defaults to Claude Code 2.1.280 — captured from a real client — and
  can be bumped with env vars instead of a code change (see [Configuration](#configuration)).
- **No OAuth client credentials in source.** The Gemini / Gemini CLI and Antigravity
  OAuth clients are read from env; history was rewritten to remove the committed values.
- **Images are built from `v*` tags**, plus a rolling `:dev` image from every
  push to `master` that changes application code, and published to GHCR (see [Releases and images](#releases-and-images)).

## Quick start (Docker)

```bash
docker run -d --name 9router \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e INITIAL_PASSWORD="change-me" \
  ghcr.io/tokenhop/tokenhop:latest
```

- Dashboard: <http://localhost:20128/dashboard> (log in with `INITIAL_PASSWORD`)
- OpenAI-compatible API: `http://localhost:20128/v1`

Or with Compose, pinned to a version:

```yaml
services:
  9router:
    image: ghcr.io/tokenhop/tokenhop:1.0.0 # or :latest
    restart: unless-stopped
    ports:
      - "20128:20128"
    volumes:
      - 9router-data:/app/data
    env_file: .env

volumes:
  9router-data:
```

State (SQLite at `/app/data/db/data.sqlite`) lives in the mounted volume.

## Using it

1. In the dashboard, connect providers (**Providers**) and create an API key (**Endpoint**).
2. Point your client at the gateway:
   - **OpenAI-compatible tools** (Codex, Cursor, Cline, Continue, …): base URL
     `http://localhost:20128/v1`, API key from the dashboard.
   - **Claude Code** and other supported CLIs: **Dashboard → CLI Tools** writes their
     settings for you.
3. Address models as `<provider-alias>/<model>` (e.g. `cc/claude-sonnet-5`) or by a
   combo name. Combos (**Combos**) chain models so requests fall through to the next
   one when a provider is rate-limited, out of quota or failing.

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer $NINEROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "cc/claude-sonnet-5", "messages": [{"role": "user", "content": "hi"}]}'
```

`GET /v1/models` lists every model and combo available to the key.

## Configuration

The full env contract is in [`.env.example`](.env.example). `.env` is not baked into the
image; pass it with `--env-file` / `env_file`.

| Variable                                             | Default                     | Notes                                                           |
| ---------------------------------------------------- | --------------------------- | --------------------------------------------------------------- |
| `JWT_SECRET`                                         | generated                   | Dashboard session signing secret. Set it explicitly.            |
| `INITIAL_PASSWORD`                                   | `123456`                    | First dashboard login. **Override it.**                         |
| `DATA_DIR`                                           | `/app/data` (image)         | SQLite database and backups.                                    |
| `PORT` / `HOSTNAME`                                  | `20128` / `0.0.0.0` (image) | Listen address.                                                 |
| `REQUIRE_API_KEY`                                    | `false`                     | Enforce an API key on `/v1/*`. Enable for any non-local deploy. |
| `AUTH_COOKIE_SECURE`                                 | `false`                     | Set `true` behind an HTTPS reverse proxy.                       |
| `API_KEY_SECRET`, `MACHINE_ID_SALT`                  | built-in                    | Secrets for generated API keys / machine IDs.                   |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` | —                           | Outbound proxy for upstream calls.                              |

**Claude Code fingerprint** — these ship together in each Claude Code release; bump them
as a set. A malformed value fails startup rather than sending an impossible fingerprint.

| Variable                     | Default                                       | Sent as                                               |
| ---------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| `CLAUDE_CLI_VERSION`         | `2.1.280`                                     | `User-Agent: claude-cli/<v>` and billing `cc_version` |
| `CLAUDE_CLI_SDK_VERSION`     | `0.112.1`                                     | `X-Stainless-Package-Version`                         |
| `CLAUDE_CLI_RUNTIME_VERSION` | `v26.3.0`                                     | `X-Stainless-Runtime-Version`                         |
| `CLAUDE_CLI_BETA_FLAGS`      | see `open-sse/config/claudeCliFingerprint.js` | `Anthropic-Beta` base list (comma-separated)          |

**Zed client version** — Zed Cloud gates clients by version. Bump this if Zed reports a
minimum required version. A malformed value fails startup.

| Variable             | Default  | Sent as                                                                               |
| -------------------- | -------- | ------------------------------------------------------------------------------------- |
| `ZED_CLIENT_VERSION` | `1.20.2` | `User-Agent: Zed/<v> (<os>; <arch>)` on all Zed calls, `x-zed-version` on completions |

**Codex CLI version** — OpenAI hides Codex models newer than the reported client, so the
live model list can silently miss new models. Bump this with your Codex CLI
(`codex --version`). A malformed value fails startup.

| Variable            | Default   | Sent as                                                                  |
| ------------------- | --------- | ------------------------------------------------------------------------ |
| `CODEX_CLI_VERSION` | `0.155.1` | `User-Agent: codex_cli_rs/<v>` and `client_version` on the model catalog |

**Grok CLI version** — xAI rejects Grok CLI clients older than its minimum with HTTP 426,
so a stale version breaks every `grok-cli` request. Bump this with your Grok CLI
(`grok --version`). A malformed value fails startup.

| Variable           | Default  | Sent as                                                  |
| ------------------ | -------- | -------------------------------------------------------- |
| `GROK_CLI_VERSION` | `1.0.44` | `x-grok-client-version` and `User-Agent: grok-shell/<v>` |

**Google OAuth clients** — required only for OAuth login and token refresh on these
providers. Official Docker images and the npm package ship these built in, so login
just works. Set the env vars only to override the built-in pair, or when running from
source (`npm run build`/`npm start`, a local `docker build`). Both are
installed-application clients that ship inside the product itself.
[Google does not treat that client secret as a secret](https://developers.google.com/identity/protocols/oauth2#installed);
this repo still does not commit the values. Put them in `.env`. Override is per pair:
setting either var of a pair drops the built-in pair for that provider, so set both.
Without a value from either source, login fails with an error naming the missing
variables.

| Variables                                                        | Providers              |
| ---------------------------------------------------------------- | ---------------------- |
| `GEMINI_OAUTH_CLIENT_ID`, `GEMINI_OAUTH_CLIENT_SECRET`           | `gemini`, `gemini-cli` |
| `ANTIGRAVITY_OAUTH_CLIENT_ID`, `ANTIGRAVITY_OAUTH_CLIENT_SECRET` | `antigravity`          |

**Gemini CLI** (one pair for both `gemini` and `gemini-cli`). In the
[Gemini CLI](https://github.com/google-gemini/gemini-cli) tree, open
[`packages/core/src/code_assist/oauth2.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/oauth2.ts)
from the version you run. Copy `OAUTH_CLIENT_ID` to `GEMINI_OAUTH_CLIENT_ID` and
`OAUTH_CLIENT_SECRET` to `GEMINI_OAUTH_CLIENT_SECRET`.

**Antigravity.** The IDE embeds the client in its language server. Search that binary
for a client id ending in `.apps.googleusercontent.com` and a secret starting with
`GOCSPX-`.

- Linux: `<install>/resources/app/extensions/antigravity/bin/language_server_linux_*`
  (`/opt/antigravity`, `/opt/antigravity-ide`, or `~/.antigravity-server/bin/<version>/`)
- macOS: `Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm`
  (also `_x64` and `language_server_macos`)
- Windows: `%LOCALAPPDATA%\Programs\Antigravity\resources\app\extensions\antigravity\bin\language_server_windows_x64.exe`

```bash
grep -a -o -E '[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com|GOCSPX-[A-Za-z0-9_-]+' \
  /path/to/language_server_linux_x64
```

Copy the client id to `ANTIGRAVITY_OAUTH_CLIENT_ID` and the `GOCSPX-` value to
`ANTIGRAVITY_OAUTH_CLIENT_SECRET`. If the binary prints several of each and the counts
match, Antigravity 2 lists the secrets first: use the last `GOCSPX-` value with the
first client id. Prefer this binary over `resources/app/out/main.js`, which can still
hold an older pair.

## Releases and images

Pushing a `v*` tag, or pushing application code to `master`, runs
[`docker-publish.yml`](.github/workflows/docker-publish.yml), which builds
`linux/amd64` + `linux/arm64` and pushes to `ghcr.io/tokenhop/tokenhop`. Other branch
pushes run nothing, and nothing is published to npm.

| Tag                | When                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:1.2.3`, `:1.2`   | From the git tag `v1.2.3`                                                                                                                                                                      |
| `:latest`          | Only when the tag is the highest stable `vX.Y.Z` in the repo — prerelease tags (`v1.3.0-rc.1`) and older-version backports don't move it                                                       |
| `:dev`, `:develop` | Every push to `master` that changes application code (docs, tests and tooling don't build) — the latest unreleased build, ahead of the betas and unsupported. No git tag or release is created |
| `:sha-<commit>`    | Every build                                                                                                                                                                                    |

```bash
git tag v1.2.3 && git push origin v1.2.3        # builds and publishes the image
```

The workflow can also be run manually (**Actions → Docker Image → Run workflow**) to
build any branch; it only pushes when the `push` input is checked, and never tags
`:latest`.

**Maintainer note.** The image and the npm CLI package embed the 4 Google OAuth
client vars above. Docker reads them from GitHub Actions repository secrets of the
same names (`GEMINI_OAUTH_CLIENT_ID`, `GEMINI_OAUTH_CLIENT_SECRET`,
`ANTIGRAVITY_OAUTH_CLIENT_ID`, `ANTIGRAVITY_OAUTH_CLIENT_SECRET`) at build time. The
npm package is published with `npx dotenvx run -f .env.encrypted -- npm run
cli:publish`, which fails the publish if those defaults are missing. Both artifacts
are public; the values aren't confidential per Google's installed-app model above,
but secret scanners may flag the `GOCSPX-` string in them — accepted.

## Development

```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev
```

Production build: `npm run build && PORT=20128 HOSTNAME=0.0.0.0 npm run start`.
Local image: `docker build -t 9router-local .` (pass `--build-arg APK_MIRROR=dl-cdn.alpinelinux.org
--build-arg NPM_REGISTRY=https://registry.npmjs.org` to skip the default CN mirrors).
To bake the Google OAuth clients into a local image, pass them as BuildKit secrets
(see [DOCKER.md](DOCKER.md)).

Tests live in `tests/` as a separate package:

```bash
npm install && (cd tests && npm install)
npm test                                        # vitest + regression gate
node tests/__baseline__/verify-providers.mjs    # also verify-alias.mjs, verify-oauth-urls.mjs
npm --prefix cli install --ignore-scripts --no-package-lock && npm run cli:pack
```

The suite is not all-green on a plain checkout, so `npm test` fails only on failures not listed
in `tests/__baseline__/known-fails.txt`. These are the checks CI runs, plus a `linux/amd64`
Docker build on pull requests.

Architecture notes: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (system overview) and
[`open-sse/AGENTS.md`](open-sse/AGENTS.md) (routing/translation engine conventions).

## License

MIT — see [LICENSE](LICENSE).

## Linting & Formatting

```bash
npm run lint       # Biome (JS/JSON/CSS), markdownlint + Prettier (Markdown/YAML), ShellCheck
npm run lint:fix   # auto-fix what is fixable
npm run format     # format everything
```

`*:modified`, `*:staged` and `*:unstaged` variants limit the run to changed files. Git hooks
(lefthook) are installed by `npm install`: pre-commit formats and lints staged files, commit-msg
enforces [Conventional Commits](https://www.conventionalcommits.org/). CI runs the same checks
plus the tests above and a production build on every pull request.
