# Docker

Run tokenhop in a container. Published image: [`ghcr.io/tokenhop/tokenhop`](https://github.com/tokenhop/tokenhop/pkgs/container/tokenhop) — multi-platform `linux/amd64` + `linux/arm64`.

---

# 👤 For Users

## Quick start

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.tokenhop:/app/data" \
  -e DATA_DIR=/app/data \
  --name tokenhop \
  ghcr.io/tokenhop/tokenhop:latest
```

App listens on port `20128`. Open: <http://localhost:20128>

## Manage container

```bash
docker logs -f tokenhop       # view logs
docker stop tokenhop          # stop
docker start tokenhop         # start again
docker rm -f tokenhop         # remove
```

## Data persistence

```bash
-v "$HOME/.tokenhop:/app/data" \
-e DATA_DIR=/app/data
```

Without `DATA_DIR`, the app falls back to `~/.tokenhop/` (macOS/Linux) or `%APPDATA%\tokenhop\` (Windows). In the container, `DATA_DIR=/app/data` makes the bind mount work.

**Upgrading from 9router?** Keep mounting the host directory or volume you already use (for example `$HOME/.9router`); the container only sees `/app/data`, so nothing moves. See [UPGRADING.md](UPGRADING.md#9-docker). <!-- legacy(9router) -->

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Host path: `$HOME/.tokenhop/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

## Optional env vars

`GEMINI_OAUTH_CLIENT_ID`/`_SECRET` and `ANTIGRAVITY_OAUTH_CLIENT_ID`/`_SECRET` are
built into the official image, so they're only needed to override the built-in pair.

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.tokenhop:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name tokenhop \
  ghcr.io/tokenhop/tokenhop:latest
```

## Optional Headroom sidecar

The tokenhop image does not bundle Python or Headroom. To use Headroom in Docker, run it as a separate service and point tokenhop at that proxy:

```yaml
services:
  tokenhop:
    image: ghcr.io/tokenhop/tokenhop:latest
    ports:
      - "20128:20128"
    volumes:
      - "$HOME/.tokenhop:/app/data"
    environment:
      DATA_DIR: /app/data
      HEADROOM_URL: http://headroom:8787
    depends_on:
      - headroom

  headroom:
    image: ghcr.io/chopratejas/headroom:latest
    ports:
      - "8787:8787"
```

In the dashboard, open `Endpoint` → `Token Saver` → `Headroom`, confirm the URL is `http://headroom:8787`, recheck status, then enable Headroom.

If Headroom runs on the Docker host instead of as a sidecar, use `http://host.docker.internal:8787` on macOS/Windows. On Linux, add `--add-host=host.docker.internal:host-gateway` or the equivalent compose `extra_hosts` entry.

## Update to latest

```bash
docker pull ghcr.io/tokenhop/tokenhop:latest
docker rm -f tokenhop
# re-run the quick start command
```

---

# 🛠 For Developers

## Build image locally (test)

```bash
docker build -t tokenhop .

docker run --rm -p 20128:20128 \
  -v "$HOME/.tokenhop:/app/data" \
  -e DATA_DIR=/app/data \
  tokenhop
```

To bake the Google OAuth clients into a local image (otherwise supply via `-e`), pass them via BuildKit secrets:

```bash
docker build --no-cache-filter oauth-defaults \
  --secret id=GEMINI_OAUTH_CLIENT_ID,env=GEMINI_OAUTH_CLIENT_ID \
  --secret id=GEMINI_OAUTH_CLIENT_SECRET,env=GEMINI_OAUTH_CLIENT_SECRET \
  --secret id=ANTIGRAVITY_OAUTH_CLIENT_ID,env=ANTIGRAVITY_OAUTH_CLIENT_ID \
  --secret id=ANTIGRAVITY_OAUTH_CLIENT_SECRET,env=ANTIGRAVITY_OAUTH_CLIENT_SECRET \
  -t tokenhop .
```

## Publish (automatic via CI)

Push a git tag `v*` → GitHub Actions builds multi-platform (amd64+arm64) and pushes to:

- `ghcr.io/tokenhop/tokenhop:{version}` and `:{major}.{minor}`, plus `:latest` for the highest stable tag

Releases are cut by maintainers only; see [RELEASING.md](RELEASING.md). Workflow:
[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml).
