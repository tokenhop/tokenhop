# v0.5.3 (2026-09-30)

## Fixes
- **CLI tools**: the CLI tools page no longer goes blank behind a reverse proxy. Opened remotely, the page keeps the tool grid and shows each tool's manual configuration inline; Intercept IDEs list their hosts-file lines. Apply/Reset remain host-only — security is unchanged (#386, #398).
- **Grok CLI**: `GROK_CLI_VERSION` is env-configurable with default `1.0.44`, fixing HTTP 426 from `cli-chat-proxy.grok.com`, which now requires CLI 1.0.13+; the OAuth device-code flow no longer sends a stale version fingerprint (#396, #397).

# v0.5.2 (2026-09-30)

## Fixes
- **Security**: settings routes no longer leak credentials or trust any CLI token header. `/api/settings/database` only skips password re-auth with a valid machine-bound CLI token, the public require-login response returns only `requireLogin`, and `GET`/`PATCH /api/settings` strip every secret setting, including `mitmSudoEncrypted` (#387, #388).
- **Auth**: HS256/384/512 OIDC id_tokens signed with the client secret are verified (algorithms restricted to discovery, `none` rejected, nonce enforced), `authMode: "sso"` now starts OIDC, settings refuse SSO-only when the protocol is not configured, and SSO lockouts are recoverable via fixed `/login` error codes and a new troubleshooting section (#392, #393).

# v0.5.1 (2026-09-30)

## Changes
- **Repository**: the project moved to [`tokenhop/tokenhop`](https://github.com/tokenhop/tokenhop). Repo, docs, skill, badge and dashboard links point at the new home; old `yandy-r/9router` URLs keep redirecting (#375, #378).
- **Container image**: images now publish to `ghcr.io/tokenhop/tokenhop`. `docker-compose.yml`, the Docker docs and the landing page use the new path; `ghcr.io/yandy-r/9router` stays at v0.5.0 and gets no new images (#376, #378).

## Fixes
- **Docs**: LICENSE, CHANGELOG and README links that pointed at a non-existent `main` branch now resolve (#375).

# v0.5.0 (2026-09-30)

## Features
- **Gateway heartbeat**: sidebar gateway card shows a 15-minute requests-per-minute sparkline with an accessible summary; the pulse follows live traffic (#360).
- **Count-up numbers**: hero numbers on Home, Token saver, Quota and Usage animate to new values without layout shift, instant under reduced motion (#360).
- **Savings milestones**: a one-time toast when lifetime token savings pass 100k, 1M and 10M, once per install (#360).
- **Routes map**: one idle-aware routes map shared by Home and Usage, showing your real providers when idle and live flow when traffic arrives (#364).
- **Combos**: weighted steps explain configured weight, effective share and quota source using the router's own math; route tests replay step by step on the track (#363).
- **Quota**: runway forecast, "at this pace, empty in ~9h · resets in 1d 18h" (#358).
- **Home**: copyable tunnel URL with a full-value tooltip.

## Fixes
- **Tunnel**: target the port the server actually bound and refresh status after toggling.
- **Settings**: show pending states for network toggles.
- **Usage**: compact usage statistics display.
- **i18n**: translate the "Tunnel live" label in all locales.

## Changes
- **Media**: media provider detail and combo pages move onto the Signal sections (#359).
- **i18n**: copy-tone sweep with a guard test, re-keyed and newly translated literals across 34 locales, and unused keys pruned (#366).
- **Dependencies**: drop `@xyflow/react`; bump material-symbols, monaco-editor, undici and uuid (#361, #362, #364).
- **Process**: branching and release rules in `RELEASING.md` (#368).

# v0.4.2 (2026-09-29)

## Features
- **Dashboard**: shared period control across Usage pages and smart quiet-period empty states (#356).

## Fixes
- **Home**: one primary, clickable recent requests with client-side links and one focus refresh (#354).
- **Providers**: pin "Your providers" on top and remove duplicate list controls (#355).
- **Tests**: triage and repair all ~86 known-failing tests behind the regression gate (YAN-416) (#353).
- **i18n**: translate the combo editor Discard button (#350).
- **Combos**: stabilize editor header actions.

## Changes
- **Usage**: lighter live stream and stat-tile trends consistent with the request log (#357).
- **Shell**: consolidate badge and auth polling behind a summary endpoint (#352).
- **i18n**: skip English DOM translation and cache locale maps (#349).

# v0.4.1 (2026-09-28)

## Features
- **UI bundle**: shrink the shared bundle, icon font and provider logos (#348).

## Fixes
- **CLI tools**: explain local-only access behind a reverse proxy instead of a failing Retry (#341).
- **Dashboard**: polish Token saver, Skills and Proxy pools (#345).
- **Usage**: explain idle Meta Code subscription instead of an empty quota card (#347).

## Changes
- **Maintenance**: temporary GLM coding secret added then removed.

# v0.4.0 (2026-09-28)

## Features
- **Signal design system**: new dark-first theme with design tokens, Bricolage Grotesque / Geist / Geist Mono typography, action and form primitives, display primitives, accessible overlays (focus trap, Esc, focus return), and a dev-only UI kit (#164, #170, #178, #251).
- **App shell**: grouped Route/Watch/Tune sidebar, gateway status with uptime, mobile drawer, header, skip link (#261).
- **Command palette**: ⌘K / Ctrl+K navigation to pages, providers, combos, models and actions, with dirty-guard routing (#262, #327, #335).
- **Home command center**: endpoint, keys, stats, savings, recent requests, quota watch, provider health and a live routes map (#273, #281, #326).
- **Providers**: redesigned list with filters and attention strip, full provider detail page with connections, strategy, priority reorder, models and auth flows, plus in-place connection repair (#268, #282, #337).
- **Combos**: route builder with four strategies, keyboard/pointer sortable steps, weighted shares, Fusion judge, test-this-route dry run and unsaved-changes guard (#269, #280, #335).
- **Endpoint & keys**: three ways in, one-time key reveal, quick connect that copies the real key, key-name validation and inline rename (#270, #322).
- **Usage**: stats, chart, breakdown, redacted request-detail drawer and savings summary priced from real usage (#272, #277).
- **Quota**: summary, filters, meters, bulk actions, single re-render per refresh and failure surfacing with retry (#271, #336).
- **Console log**: live/pause/resume, level filters, honest stream state and grouped repeats (#264, #325).
- **CLI tools**: redesigned list and setup panels with per-tool cards, real status detection and confirm-before-reset (#275, #323).
- **Settings**: consolidated tabbed sections covering General, Security, SSO, Pricing, Data, Routing, Network, Token saver, Providers, Observability, Reliability and Danger zone (#267, #276, #279, #284, #285).
- **Media providers and proxy pools**: kind tabs with try-it playground, bulk actions, masked credentials and relay deploy (#263, #274).
- **Skills page**: local, allowlisted `/skills/<id>/SKILL.md` URLs (#265).
- **Login, callback, landing, MITM, translator, basic chat**: restyled on Signal primitives (#266, #324, #334).
- **Provider logos** restored across the dashboard with brand fallbacks and Muse Code mark; Buy Me a Coffee donate dialog with local QR (#288, #290).
- **Reliability policy**: configurable retry, cooldown, backoff and timeouts with defaults preserving existing behavior (#285).
- **Config export/import**: versioned, secret-stripping, preview-diff and atomic apply (#284).

## Fixes
- **Accessibility, RTL and responsive audit**: zero serious/critical axe violations on all 24 routes in both themes at 1440 px and 390 px (#287).
- **Provider detail crash**: `ReferenceError: staticModels is not defined` fixed for live-catalog providers; Usage stats error state no longer crashes; Biome now fails on undeclared variables (#289).
- **Shell**: mobile header without overlap, accessible language control, no false-zero badge flash, page titles centralized (#334).
- **Quota**: weekly Codex primary window labeled correctly; stale responses can no longer overwrite fresh data (#336).
- **Endpoint**: Quick connect copies the real key for every language (#322).
- **CLI tools**: status-request loops stopped, real detection errors surfaced, Copilot reports its real status (#323).
- **Feedback**: truthful copy status, error toasts with undo and shared loading/error views; MITM load/save/DNS failures surface with rollback (#324).
- **Console log**: precise grouping, stable keyboard focus, smooth scrolling (#325).
- **Live routes**: rapid flashing removed; reduced-motion safe in Home and Usage (#333).
- **Combos sidebar**: long capability-adapter model chips no longer overflow the 320 px column (#295).

## Changes
- **Translations**: redesigned copy translated across all 34 locales with placeholder-mismatch and coverage guards; accessible attributes now translate (#291, #338).
- **Legacy cleanup**: old style tokens removed, dead components and assets deleted, README and `docs/ARCHITECTURE.md` updated for the SQLite persistence layer, shell, Settings, reliability precedence and auth boundaries (#296, #321).
- **Sidebar promos**: upstream 9Remote/9English links removed (#294).

# v0.3.3 (2026-09-27)

## Security
- **Privacy**: 9router no longer tracks anyone or calls services run by the original upstream authors (#293).
  - The dashboard's hardcoded Google Analytics tag is removed. It had been sending every page view (URL and title) to the upstream author's analytics account.
  - The Donate dialog is bundled locally and no longer calls `9router.com`.
  - `.env.example` no longer points `CLOUD_URL` at `9router.com`.
  - The Cloudflare tunnel no longer registers its URL with the upstream `abc-tunnel.us` relay.
  - The Headroom sidecar is started with its telemetry and update check turned off.

## Changes
- **Cloudflare tunnel**: a stable-URL relay is now opt-in through `TUNNEL_WORKER_URL`, which must be an https origin you run yourself. Without one, the tunnel's public URL is its own `*.trycloudflare.com` address, which changes when the tunnel restarts (#293).
- **Dashboard**: the sidebar no longer promotes the upstream 9Remote and 9English products. The landing page now installs this project's GHCR image instead of `npx 9router`, which is the upstream author's npm package (#293).

# v0.3.2 (2026-09-25)

## Features
- **Cursor**: connect from any browser with a "Login with browser" PKCE flow, including headless and Docker hosts. Tokens refresh, IDE import also captures the refresh token, and Provider Limits shows the Cursor plan and usage (#255).

## Fixes
- **Combos**: every combo strategy (fallback, round-robin, weighted, fusion) skips accounts whose quota window is known to be exhausted, instead of calling them until upstream returns 429/403 (#254).
- **Cursor connection test**: makes a real authenticated read instead of only checking that a token exists, so expired or revoked sessions no longer show as valid. On 401/403 it refreshes, retries once and saves the new tokens (#257).

# v0.3.1 (2026-09-25)

## Fixes
- **Account fallback**: an active account-wide lock (for example, a monthly limit) is honored even when a per-model lock has expired, and the cooldown timer shows the active lock (#120).
- **Executors**: Codex decides `/responses/compact` routing per request, and CommandCode replays full chunks after peeking (#123). Chat Completions bodies sent to `/v1/responses/compact` keep compact routing, and passthrough streams send `[DONE]` once (#188).
- **Credentials**: stop accepting stale or unauthenticated provider credentials (#130). Kiro and CodeBuddy refresh failures no longer crash account fallback, and API-key connections skip impossible refresh retries (#131).
- **Connection tests**: Kiro and Kimi tests use runtime refreshers (#173). OAuth providers and compatible nodes no longer report false errors (#185).
- **Translation**: tool results, tool ids and Claude tool-choice intent survive translation (#169).
- **Streaming**: Cursor AgentService read failures surface as errors instead of successful completions (#177). DNS-bypass requests honor aborts, and image/document input survives fallback attempts (#182).
- **Usage**: concurrent identical requests are all recorded (#174). Kimi quota parses the live `/usages` schema, so an exhausted 5-hour window shows 0% and a monthly row appears (#249).

# v0.3.0 (2026-09-25)

## Features
- **Weighted routing**: combo models and provider accounts can now use quota-aware weights. Combo editor exposes weights; account strategies support per-plan and per-connection overrides (#116, #117).
- **Quota visibility**: per-connection quota snapshots and plan-tier detection support weighted routing and usage views (#108).
- **Meta Code**: native Muse Spark provider with OAuth or API-key connections and quota tracking (#101).

## Fixes
- **Client formats**: non-streaming Claude and Responses requests now receive bodies in their requested format, with reasoning, truncation and cache usage preserved (#93). Developer and system instructions survive translation (#115).
- **Usage and costs**: record final upstream token usage, avoid double-counting cached/reasoning tokens, and apply partial pricing overrides correctly (#100).
- **Ollama**: `/v1/api/chat` returns content and errors in Ollama format, preserving UTF-8, thinking and tool calls with one final stream line (#107).
- **Reliability**: retry interrupted legacy database imports, handle large hosts files, reject malformed chat bodies, and read device-code token responses safely (#113).
- **Combo editor**: clarify weights and make their disclosure collapsible.

# v0.2.1 (2026-09-24)

## Security
- **API key enforcement**: `/v1/models`, `/v1/models/{id|kind}`, `/v1/models/info`, `/v1/audio/voices`, `/v1/messages/count_tokens` and `/v1beta/models` now enforce `requireApiKey` (local callers and the local CLI token still pass). Usage stats group per-key rows by key id instead of the raw or masked key, so full API keys are never returned and distinct keys no longer merge into one row (#77–#81).

## Fixes
- **Combos**: a self-referencing or cyclic combo returns 400 instead of recursing forever, and combo create/update rejects cycles, empty names and non-string model lists. A failed combo returns the last model's status with its matching message, plus the earliest upstream `Retry-After` (#72–#76).
- **Cursor**: AgentService requests now carry the conversation history and system prompt. Before, Cursor only saw the last user message, so in tool loops the latest tool result became the prompt (#88, #89).
- **CLI**: `--port=N`, `-pN` and `--host=H` work; unknown flags or an invalid port/host exit 2 instead of silently binding `0.0.0.0:20128`. Hide-to-Tray, autostart entries and the tray autostart toggle keep the chosen port and host, and Hide-to-Tray no longer turns on autostart without asking. Ctrl+C in menus stops the server, MITM and tunnel. Without a TTY (pm2, systemd, Docker) the launcher runs headless instead of shutting down. After repeated crashes it retries with MITM off, then exits 1 instead of restarting forever (#82–#86, #90).
- **Audio**: `/v1/audio/voices` lists voices again instead of always returning 401 (#81).

# v0.2.0 (2026-09-24)

## Security
- **Login lockout**: the client IP now comes from the rightmost `X-Forwarded-For` hop, falling back to `X-Real-IP`. Before, behind Cloudflare/cloudflared, nginx or Caddy the leftmost (client-supplied) value was used, so rotating it gave every login attempt a fresh lockout bucket. `TRUST_PROXY` follows the same rule (#35).
- **SAML**: an ACS post without a pending `saml_state` request ID is rejected, and `InResponseTo` is enforced with a one-time request-ID cache (10 min), blocking assertion replay, including concurrent replay (#40).
- **h2c**: upgrade requests whose `Content-Length` exceeds `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE` (default 128mb) get 413 before anything is buffered, closing a pre-auth memory DoS (#41).
- **CLI tools**: the whole `/api/cli-tools/` API is now local-only, so remote clients can't read or rewrite host tool configs when login is off (#42).

## Features
- **Google OAuth**: official Docker images and the npm CLI package now embed public Google "installed app" OAuth clients, so gemini, gemini-cli and antigravity OAuth login and token refresh work with no env vars set. Set `GEMINI_OAUTH_CLIENT_ID`/`_SECRET` or `ANTIGRAVITY_OAUTH_CLIENT_ID`/`_SECRET` (both of a pair) to override, or when running from source (#6, #7).
- **Codex**: OpenAI Codex connections now use Codex's live model list, like Claude and Cursor. A warning appears when the live list lacks built-in models, which usually means `CODEX_CLI_VERSION` is stale. Retired `gpt-5.4`, `gpt-5.4-mini` and `gpt-5.3-codex-spark` are gone from the built-in list (#37, #39).
- **Codex**: the new `CODEX_CLI_VERSION` env var sets the Codex client version 9router sends (default `0.155.1`, which unlocks `gpt-6-sol` and `gpt-6-luna`).

## Fixes
- **Gemini API (`/v1beta`)**: `x-goog-api-key` and `?key=` auth work instead of returning 401; streamed text is no longer lost when an SSE line spans chunks; model ids with several path segments are no longer cut short; `:countTokens` is answered locally instead of running a billable chat; bad JSON returns 400 instead of 500 (also on `/v1/responses/compact`); `/v1beta/models` lists only configured chat models (#65–#70).
- **CLI tools**: Apply/Reset no longer wipes a tool config it can't parse. JSON configs are read as JSONC (comments, trailing commas); an unparseable `opencode.json`, Codex `config.toml`, etc. now returns an error and is left untouched (#60, #62). Codex Reset only removes an `auth.json` key 9Router itself wrote (#61). Changing a Claude Code model from the terminal UI keeps the Exa MCP server and auto-compact setting (#63).
- **CLI**: startup, port reclaim and "Shutdown for manual update" now stop only 9router's own processes, tracked in `DATA_DIR/9router.pid`. Before, they matched process names and could kill unrelated Next.js apps, test runners, shells or personal cloudflared tunnels, and port reclaim could hit clients connected to the port (#36, #38).
- **Dashboard**: the local endpoint option and media curl examples use the dashboard's real origin instead of assuming port 20128, and media example cards show the tunnel URL again (#44–#46).

## Changes
- **CI**: added CLI package, PR Docker build and provider baseline checks, plus a root `npm test` script (vitest + known-fails regression gate). `engines.node` is now `>=22.5` (#48).

# v0.1.4 (2026-09-23)

## Fixes
- **Cursor**: 9router now answers every AgentService exec request instead of aborting the turn, so Cursor no longer hangs mid-turn waiting for a reply (#33).

## Changes
- **Dev**: added `compose.dev.yml` and `dev:docker`/`dev:docker:down` scripts for running the dashboard in Docker while developing.
- **Deps**: bumped better-sqlite3 to 13.0.3, http-proxy-middleware to 4.2.0, chalk to 6.0.0, react-is to 19.3.0, socks-proxy-agent to 10.1.0, vitest to 5.0.1, and the minor-and-patch group (#24–#31).
- **Build**: added formatters, linters, git hooks and CI workflows; formatting commit ignored in git blame (#22).

# v0.1.3 (2026-09-23)

## Features
- **Models**: Claude connections now show Anthropic's live model list on the provider page, in the model picker and in `/v1/models`, so new models appear without waiting for a 9router update. A new **Fetch Models** button refreshes the list on demand and adds any missing models. It replaces the separate Qoder and Cline import buttons. Cursor, Zed, Qoder, Cline and ClinePass use the same live list. When a live list can't be loaded, the page keeps the built-in list and shows why (#21).
- **Claude**: added Claude Opus 5.5 (`claude-opus-5-5`, 1M context, $4/$20) (#19).

## Fixes
- **Claude**: subscription (OAuth) requests no longer fail with 400 "You're out of extra usage" when Headroom compression is on. Headroom rebuilt the request's system prompt and dropped the billing header that marks it as Claude Code traffic, so Anthropic billed it to extra usage. Headroom now compresses only the conversation messages (#16, #17).
- **Claude**: a "none" reasoning setting on models that can't turn thinking off (Opus 5.5, Fable 5.1) now sends the lowest effort, `low`. Before, it sent `thinking: disabled` or the unsupported effort `minimal`, and both failed with a 400 (#19).
- **Claude**: loading models for a subscription (OAuth) connection no longer fails with "API key is invalid" (#18, #19).
- **Cursor**: tool-call and image turns now go through Cursor's AgentService, and Cursor's "Update Required" response no longer puts the account on a quota cooldown (#20).

# v0.1.2 (2026-09-23)

## Fixes
- **Claude**: subscription (OAuth) requests no longer fail with 400 "You're out of extra usage" while the plan still has headroom. 9router sent the fast-mode beta on every request. It now goes out only when a request asks for `speed: "fast"`, even if `CLAUDE_CLI_BETA_FLAGS` lists it. A fast-mode request that runs out of extra usage is retried once at standard speed, as Claude Code does. An "out of extra usage" error now moves on to the next account or combo model instead of stopping there (#3).
- **Zed**: 9router now identifies itself as the Zed client, sending `User-Agent: Zed/<version> (<os>; <arch>)` and a current `x-zed-version`. When Zed returns no usable models, the dashboard now says why: the models' disabled reasons, the org's model-provider settings or plan, or the minimum client version. The new `ZED_CLIENT_VERSION` env var sets the version (default `1.20.2`) (#8).
- **Zed**: a 401/403 from Zed (for example on a plan-gated model) now comes back right away. Before, 9router spent about 3s on token-refresh retries that could never succeed. Qoder, Cursor, Trae and Windsurf, which also have no token refresh, get the same fix (#12).
- **Responses API**: tool calls through Codex (`cx/*`), OpenCode, OpenCode Go and Grok CLI no longer fill in every optional parameter. For example, OpenCode subagent launches were failing with "Subagent session not found: ses_invalid". A tool sent without `strict` now goes upstream as `strict: false`, as Chat clients expect, and an explicit `strict` from the client is kept (#14).
- **Tests**: the test suite no longer writes fixture connections, `jwt-secret`, `machine-id` or MITM logs into your real `~/.9router`. Every test file now runs against its own temp data dir and home, and `verify-no-regression.mjs` works on local checkouts again.

## Changes
- **Docker**: arm64 images are now built on native arm64 runners instead of under QEMU emulation, so an image build takes about 5 minutes instead of 20. A stalled build now fails after 30 minutes instead of running for hours (#15).

# v0.1.1 (2026-09-23)

## Fixes
- **Zed**: you can now finish sign-in by pasting the callback URL. While it waits, the Connect Zed modal always shows the sign-in URL and a field for the callback URL, so login works even when the browser can't reach 9router's `127.0.0.1` callback (Docker, a remote host, or another machine). The callback listener now accepts the redirect on any path, as the Zed client does, and the "Paste token" tab, which crashed for Zed, is no longer shown for it (#1).

## Changes
- **Links**: the dashboard's changelog, README link and skill links now point to `yandy-r/9router` instead of upstream. `docker-compose.yml` now uses `ghcr.io/yandy-r/9router:latest`.
- **Docs**: the README explains where to get the Google OAuth client IDs and secrets.

# v0.1.0 (2026-09-22)

First release of this fork, which restarts version numbers at 0.1.0. It is based on upstream 9Router v0.5.81 and includes every change listed below that entry.

## Breaking Changes
- **Google OAuth**: `gemini`, `gemini-cli` and `antigravity` OAuth login and token refresh now need the `GEMINI_OAUTH_CLIENT_ID`/`_SECRET` and `ANTIGRAVITY_OAUTH_CLIENT_ID`/`_SECRET` env vars. These client credentials are no longer built into the source. Without the vars, login fails with an error that names the missing ones, and refresh is skipped.
- **Updater**: removed the npm self-update, which checked for and installed upstream's `9router` package. The dashboard no longer shows an "update available" banner, `GET /api/version` and `POST /api/version/update` are gone, and the CLI no longer checks for updates at startup or offers "Update to vX". Update by pulling a newer image. The `--skip-update` flag is removed and ignored if passed, so existing autostart entries keep working.

## Features
- **Claude Code**: the client fingerprint sent on `claude` OAuth traffic can be set through `CLAUDE_CLI_VERSION`, `CLAUDE_CLI_SDK_VERSION`, `CLAUDE_CLI_RUNTIME_VERSION` and `CLAUDE_CLI_BETA_FLAGS`. Defaults now match Claude Code 2.1.280 (SDK 0.112.1, runtime v26.3.0), with an updated beta-flag list and `x-claude-code-session-id`. Malformed values fail at startup.
- **Docker**: pushing a `v*` tag publishes multi-arch (`linux/amd64`, `linux/arm64`) images to `ghcr.io/yandy-r/9router`, tagged `:<version>`, `:<major>.<minor>` and `:sha-<sha>`. `:latest` only goes to the highest stable tag. The Dockerfile's package mirrors are now build args.

## Changes
- **Version**: the reported app version is now `0.1.0`. Cline (`User-Agent`, `X-CLIENT-VERSION`, `X-CORE-VERSION`) and Kimi (`X-Msh-Version`) upstream requests send this value in place of `0.5.81`.
- **Windsurf**: removed the unused `firebaseApiKey`.
- **Docs**: rewrote the README for this fork and removed the GitBook deploy workflow.

# v0.5.81 (2026-09-18)

## Features
- **Xiaomi MiMo**: merge MiMo Desktop support into `xiaomi-mimo` with dual auth (API key + Desktop/OAuth session), Preview models support, and encrypted-callback OAuth flow
- **Claude Code**: add 1M-context toggle (`[1m]` marker) and drive `CLAUDE_CODE_AUTO_COMPACT_WINDOW` directly from the dashboard
- **Models**: add DeepSeek-V4.1-Flash to DeepSeek provider, CodeBuddy-Intl, and Ollama (`deepseek-v4.1-flash:cloud`); enable `low`..`max` reasoning effort levels and vision capability for DeepSeek-V4.*
- **i18n**: integrate Persian (fa) translation

## Fixes
- **OpenCode / OpenCode Go**: resolve 403 `FreeTierError` and 429 rate limits with canonical session format, valid User-Agent, and stable upstream session reuse; force stream and declare `forceStream` for free-tier SSE aggregation; cloak decoy tools, normalize Muse Free tool choice, and strip prior reasoning items on Responses models; route Union Alpha via Messages API
- **Kiro**: preserve underscores in tool names (`mcp__server__tool`) and restore client tool names in responses; use neutral placeholder for tool-result-only turns; forward tool-result images
- **Stream**: report aborts after HTTP 200 in-band (per-format error frames) instead of closing silently
- **Command Code**: preserve images and `reasoning_effort` on `/alpha/generate`; retry transient stream errors and avoid fake stop chunks; add Quota Tracker support
- **Zed**: harden OAuth lifecycle (preserve `systemId`, renew proxy timeout), support live model resolution, and lower display priority in OAuth list
- **Antigravity**: scope cached thought signatures to model family; strip Claude Code billing headers from system prompts; sanitize Hermes system identity
- **Codex**: route bare `codex-auto-review` requests to the Codex provider (#4135)
- **Auth**: do not cool down an account for request-scoped 4xx errors
- **Usage**: improve DeepSeek credit balance display as currency credit instead of 0/total quota bar
- **Model Catalog**: scope synced catalog to gateways and declare vision capabilities for DeepSeek V4.1-Flash IDs

# v0.5.75 (2026-09-10)

## Features
- **Video**: add OpenRouter and Vertex AI (Veo) video generation on `/v1/videos/*` via a provider adapter layer; poll requests resolve their provider from `x-connection-id` or `?provider=`
- **Antigravity**: add weekly quota tracking (Gemini weekly / Claude & GPT weekly) and free-tier handling from `retrieveUserQuotaSummary` (#3892)
- **Codex**: add GPT Image 2.5, Flare and Sunburst image models with multi-image support; add the same ids to the OpenAI catalog
- **Qoder**: surface usage to all clients and stop inlining large attachments — images upload through `/api/v2/image/upload` like qodercli, oversized file blocks become stubs, context tier auto-escalates
- **OpenCode Go**: add newly published models (glm-5.3, kimi-k3, deepseek-flash, longcat-2.0, hy4-preview, hy3 on chat/completions; qwen3.8-max, qwen3.8-flash on `/messages`; grok-4.6, gpt-5.6-luna on Responses) and list `deepseek-v4.1-flash` first in the catalog
- **CLI tools**: group the model selector by provider with full-text search and manual custom model ID entry
- **CodeBuddy-CN**: replace `deepseek-v4-flash` with `deepseek-v4.1-flash`

## Fixes
- **Tools**: scope Claude tool type defaulting to gateways declaring `requireClaudeToolType` — the global default broke Anthropic-compatible endpoints that only accept the legacy typeless tool shape (#3905)
- **Claude**: cap re-anchored `cache_control` at the 4-marker budget so a spent budget no longer 400s and triggers a full combo failover; wrap bare single-object content turns before the mid-conversation-system fold
- **Cline / Airforce**: unwrap the `{"success":true,"data":…}` envelope on non-stream chat completions (#3644); add the live Cline/ClinePass model catalog and refresh Airforce free models
- **Cline**: stop `workos:`-prefixing ClinePass API keys (401 on every request, #2333) and add clinepass token refresh
- **Kiro**: never send a top-level `systemPrompt` (`400 REQUEST_BODY_INVALID`); route requests through current runtime surfaces (#3776)
- **Codex**: strip Unicode-property tool schema patterns the validator rejects (#3922); restore the `Version` header and single-source the CLI version
- **DeepSeek**: keep Anthropic-only tool types when forwarding to `/anthropic/v1/messages`
- **Qoder**: drop the Responses usage plumbing from shared translator/handler code, which changed token accounting for every provider, not just Qoder
- **Antigravity**: normalize contents and handle intermediate tool responses; protect the OAuth token-refresh path from Google anti-abuse rate limits (#3813)
- **Providers**: clear stale connection health state (`modelLock_*`, `backoffLevel`, `rateLimitedUntil`, `errorCode`) when a connection is re-validated (#3810, #3830); remove the duplicate `qwen` provider that shadowed `alims-intl`
- **Video / Vertex**: reject job ids and model ids that would escape the request URL path (SSRF)
- **Usage**: parse the Fable weekly limit from `limits[]` instead of fabricating a row (#3847)
- **Auth**: set a 24h `maxAge` on the dashboard session cookie

# v0.5.69 (2026-09-05)

## Features
- **Codex**: add GPT 6.0 Astra (`gpt-6-astra`) with vision, thinking and search capabilities
- **Usage**: add Claude Fable quota tracker support with weekly window normalization (`weekly fable (7d)`)
- **Dashboard**: group Antigravity Gemini and Claude quotas in Quota Tracker, prune stale hidden keys
- **OpenCode Go**: add `muse-spark-1.3-contributor` model and support parallel tool calls on Responses path (#3819)
- **Providers & Models**: align CodeBuddy-CN catalog/capabilities with server config; add GPT-5.6 Sol, Terra, Luna image aliases on Codex (#3806); refresh Qoder catalog with capability mapping and image pass-through
- **CLI tools**: replace Copilot MITM with VS Code extension setup guide
- **Gemini**: persist and replay `thoughtSignature` scoped by session namespace

## Fixes
- **Claude**: normalize adaptive auto effort (`output_config.effort`) (#3792)
- **Antigravity**: prevent Google anti-abuse rate limits during multi-account refresh (#3813)
- **Anthropic-compatible**: forward Claude beta flags to nodes fronting Anthropic (#3797)
- **Dashboard**: dynamic mode label for local/remote detection (#3801)
- **Codex**: format reset credit API errors cleanly (#3778)
- **Security**: guard cowork MCP tools probe against SSRF (#3783)
- **OpenCode Go**: track OpenCode Go quota (#3791) and send stable session headers (#3800)
- **Logger**: suppress noisy background token refresh logs
- **CLI**: export packed `.tgz` directly into workspace root instead of parent directory

# v0.5.65 (2026-09-03)

## Features
- **Fetch**: add Ollama Cloud web fetch provider
- **Gemini / Antigravity**: add Gemini 3.8 Flash support and bump IDE fingerprint to 2.11.0
- **Claude**: add Claude Fable 5.1 support (adaptive thinking with `output_config.effort`), bump Claude Code fingerprint to 2.1.258 for new-model access
- **Providers**: add client-side status filter (All / Active / Inactive / No connection) on the Providers dashboard; add max height and scroll for connection list
- **Providers & Models**: streamline tokenrouter model catalog down to 22 flagship/newest models and add missing provider icons; refresh Codebuddy-CN catalog (add hy4-preview/hy3/glm-5.3/kimi-k3-1, drop EOL glm-5.0/glm-4.7)
- **Models**: capability toggles (vision, reasoning) when adding custom models with upsert and live caps refresh
- **CLI tools**: support saving and managing custom API key presets
- **Quota**: add usage and rate-limit tracking for Groq via `x-ratelimit-*` headers
- **i18n**: complete Indonesian translation (1391 keys)

## Fixes
- **Security**: close SSRF guard bypasses in `ssrfGuard.js` (alternate IPv6 encodings, hostname trailing dots, wildcard DNS resolution check, safe redirect handling) (#3714)
- **Model markers**: strip the `[1m]` context marker Claude Code appends to model names (`claude-opus-5[1m]`) preventing model resolution failures (#3690)
- **Claude**: drop `server_tool_use` blocks carrying foreign IDs to avoid Anthropic 400 rejections; never anchor cache breakpoints on `defer_loading` tools (#3567)
- **Antigravity**: strike-break optimistic quota readings that keep 429ing by blocking the connection+model pair for 15m after 3 strikes (#3681); preserve client identity on model catalog requests (#3414)
- **Auth**: protect root `/responses` rewrite requiring API key validation in dashboardGuard
- **Chat & Docker**: return 503 Service Unavailable when all credentials are rate-limited; explicitly bundle `node-machine-id` into standalone Docker runtime image
- **OpenCode**: route Muse Spark models to `/zen/v1/responses` and declare vision support; filter inactive free model
- **Kiro**: preserve inline images as OpenAI-compatible `image_url` parts in OpenAI MITM; remove redundant top-level `systemPrompt` from payload
- **Usage**: read Responses-shape `cached_tokens` in `extractUsageFromResponse` for non-streaming traffic
- **Models**: support single model lookup with provider-prefixed IDs (e.g. `cc/claude-sonnet-5`)
- **Translator**: route Gemini thinking through `reasoning_effort` on OpenAI-compatible wire; convert `prefixItems` and ensure array items in Gemini schema sanitizer
- **UI**: apply persisted theme before first paint to prevent flash on reload; translate combo vision adapter label

# v0.5.59 (2026-08-29)

## Features
- **Search**: new web search providers — Antigravity (Google Search grounding
  on the existing OAuth account pool, citations keyed and merged by URL) and
  Xquik (X search with `x-api-key` auth, cursor pagination, credit-based
  usage), both on `POST /v1/search`. Based on #3437 by @Nautilaceae
- **Search**: ollama-search and zai-search borrow a chat provider's API key
  instead of requiring their own connection, driven by a new
  `credentialFallback` registry field. zai-search later folded into the `glm`
  provider itself so the web search page shows the shared connection
- **Models**: daily background sync of model capabilities from models.dev —
  modalities keyed by model id (majority of sources must declare one),
  context/output limits keyed by provider + model, strictly additive and
  sitting below the hand-written tables. ETag + mtime cache, 60s startup
  delay, `MODEL_CATALOG_SYNC=off` to disable
- **Models**: add GLM-5.3-Flash (1M context, natively multimodal), DeepSeek
  V4 Vision, Grok 4.5/4.6 (500k context); correct glm-4.6v/4.5v video input
  and output limits, backfill glm-4.6v on glm-cn
- **Usage**: show the Zed plan quota on the dashboard — plan, edit
  predictions, hosted model requests and billing-cycle reset; unlimited rows
  render as "N used · Unlimited"
- **Usage**: track GPT-5.3-Codex-Spark quota windows (spark_session /
  spark_weekly) from the Codex usage response (#3431)
- **Antigravity**: quota-aware routing — on 409/429 fetch live quota for the
  exact per-model resetAt and skip only the exhausted account/model pair;
  report the earliest reset when every account is blocked (#3561)
- **Antigravity**: map image `size` to the aspect-ratio model suffix (-WxH);
  add the Gemini 3.7 Flash tiers to MITM defaultModels so they show up in
  the dashboard model-mapping table
- **Dashboard**: bulk import Grok CLI accounts from JSON — paste an array or
  drag-drop multiple .json files, all OAuth connections created in a single
  call, mirroring the codex flow
- **CLI tools**: endpoint presets shared across every tool card through one
  live-resyncing store, instead of per-card localStorage copies that never
  saw each other's saved endpoints
- **Token Saver**: configurable compression timeout (`headroomTimeoutMs`) —
  the fixed 3000 ms made busy machines time out and send inconsistently
  compressed bodies, hurting prompt caching
- **i18n**: pt-BR expanded to 1132 terms

## Fixes
- **Claude Code**: add Claude Fable 5.1 and advertise Claude Code 2.1.258 in
  both the request header and billing identity; use its permanent adaptive-thinking
  mode with `output_config.effort`
- **Stream**: record usage when a client closes on the terminal event — the
  Responses API has no [DONE] sentinel, so codex closed the socket on
  `response.completed` and cancelled the reader before flush() ran its usage
  side effects; the tail now lives in a once-guarded finalizeStream(). Also
  stop logging a disconnect for every completed Responses call
- **Stream**: parse the trailing NDJSON line an Ollama stream leaves behind
  without a closing newline — the final chunk carrying `done_reason` and the
  token counts was dropped
- **Session**: read the Claude Code session id from the
  `x-claude-code-session-id` header — `metadata.user_id` is dropped by
  Responses translation, splitting one conversation across several
  `prompt_cache_key` values and missing the upstream prefix cache
- **Usage**: preserve nested `cached_tokens` — the top-level-only read
  persisted `cached_tokens: 0` for every Responses-format provider (codex,
  grok-cli, …), billing cache hits at the full input rate
- **Usage**: GLM quotas accept CREDIT_LIMIT plans and multi-interval windows
  (5h session / 7d weekly) instead of overwriting a single "session" key
- **Models**: the catalog sync no longer erases its own output — deltas were
  measured against the previous run's writes (the second run cut `providers`
  from 20 entries to 5); one vote per provider in the modality tally, ETag
  restored from file on startup, and the worker thread dropped after the
  bundler rewrote its path into a module-not-found error
- **Executor**: CommandCode returns errors as a `type:"error"` event inside
  an HTTP 200 NDJSON stream — peek the first events before committing, abort
  and return a real 4xx/5xx so combo/account fallback triggers instead of
  streaming the error text as content
- **Search**: scope failure locks on the credential-fallback path — a failing
  search locked `modelLock___all` and took the shared glm key offline for
  chat as well; locks are now attributed to the connection's owner and
  scoped to `websearch:<provider>`
- **Providers**: connection tests get a 15s AbortSignal timeout instead of
  hanging and exhausting the browser socket pool; guard undefined provider
  names on the providers page
- **Antigravity**: sanitize competing-client branding via a config-driven
  rule table (Zed's Claude-agent prompt, opencode → antigravity) — upstream
  answers 429 Quota Exhausted. Applied in the executor so the shared
  openai-to-gemini translator leaves gemini/vertex/zed untouched
- **MiniMax**: preserve images on the sourceFormat-matched OpenAI transport
  — MiniMax-M3 resolved a Claude-shaped body posted to the OpenAI endpoint,
  silently dropping `image_url` blocks (#3418)
- **Claude**: decloak tool names in same-format streaming passthrough —
  OAuth-cloaked names (CLAUDE_TOOL_SUFFIX) leaked to the client and every
  tool call was rejected as unknown
- **Tools**: default a missing `tools[].type` to "custom" on Claude-format
  requests — strict Anthropic-compatible gateways (MiniMax) reject the
  request with 400 otherwise
- **Translator**: zai thinkingFormat sends the top-level `reasoning_effort`
  object GLM-5.2+ requires — every GLM-5.x request ran at the model default
  (max); gated on GLM-5.2+ since older GLM does not read it (#2721)
- **RTK**: system prompt injection matches each target wire format
  (Chat/Responses/Claude/Gemini/Kiro) and is exact-idempotent across retries,
  so distinct prompts sharing a long prefix are no longer collapsed (#3202).
  Also set the diagnostic before the silent null return on Responses
  translation failure so the panel is no longer blank
- **OpenCode**: route muse-spark through /zen/v1/responses (it 500s on
  chat/completions), normalizing the Chat fields the Responses API rejects
  and clamping max/ultra effort to xhigh
- **CLI**: install better-sqlite3 without build tools on Node 22+ (N-API
  13.0.3 ships per-platform prebuilds, `--ignore-scripts` skips the implicit
  node-gyp build); Node < 22 stays on 12.6.2, working installs untouched
- **CLI tools**: send the API key Codex actually reads —
  `[model_providers.9router.http_headers]` instead of auth.json (which left
  every request 401 and clobbered an existing ChatGPT login); subagent model
  moved to `agents.default_subagent_model`
- **OAuth**: refresh Cline tokens with the extension JSON contract
- **Dashboard**: clamp the API key mask length — keys shorter than 8 chars
  threw RangeError and crashed the media-provider detail page
- **UI**: wait for the Material Symbols font itself before revealing icons —
  `document.fonts.ready` resolved before the 4MB woff2 even started loading,
  leaving icons blank until a second load

# v0.5.55 (2026-08-14)

## Features
- **Auth**: native SAML 2.0 SSO alongside OIDC — AuthnRequest generation, ACS
  assertion handling, SP metadata export, admin config test, replay-protected
  via a `saml_state` cookie matched against `InResponseTo`
- **Providers**: add Alibaba Token Plan (`token-plan.ap-southeast-1`) — the
  fourth Alibaba key type, Singapore-only and OpenAI-compatible transport only
- **Providers**: add `glm-5.3` to GLM Coding and GLM (China)
- **Providers**: Kimchi accepts API keys as well as OAuth (dual auth), with a
  working Test Connection for both modes
- **Antigravity**: add Gemini 3.7 Flash and its tiered high/medium/low variants
  (also in the Gemini registry) with pricing and quota tracking
- **TTS**: add Fish Audio — model id travels in an HTTP `model` header, voice
  is a `reference_id` (preset or cloned voice model)
- **OpenCode-Go**: route by request format via declared transports instead of
  forcing every client into `/messages` — Codex/OpenAI clients no longer pay a
  lossy Responses→OpenAI→Claude double translation. Per-model `supportedFormats`
  guard; the bespoke executor is gone (its shared `_lastModel` cache could cross
  auth headers between concurrent requests)
- **Usage**: dedup + cache Claude quota calls (120s TTL keyed by access token,
  in-flight promise dedup, last-good read on soft failure) to stop multiple
  tabs tripping 429; manual refresh (↻) sends `force=1` to bypass the cache

## Fixes
- **Docker**: ship `sql.js` in the image so the pure-JS DB fallback can start —
  file tracing carried the package's JS without `dist/sql-wasm.wasm`, so a
  container with no native driver aborted with ENOENT and never got a database
  (#3248)
- **Usage**: read Gemini `usageMetadata` out of the antigravity `{ response }`
  envelope — every non-streaming antigravity request logged `IN 0 | OUT 0`
  (#3260)
- **Claude**: re-anchor passthrough cache breakpoints — the client's own
  `cache_control` markers point at pre-normalization offsets, so the tail was
  re-cached every request. Last system block and last tool pinned at 1h TTL,
  last assistant turn at 5m, mid-conversation system messages folded into the
  neighbouring user turn instead of hoisted into `body.system`
- **Combos**: detect images from Hermes and attachment payloads (`images[]`,
  `experimental_attachments`, message-level `image_url`/`audio_url`, inline
  `data:` URIs) so the Vision Adapter auto-switch fires for Hermes/Ollama/
  Vercel AI SDK shapes
- **Kiro**: intercept chat via `x-amz-target` — Kiro IDE 1.0.228+ moved
  `GenerateAssistantResponse` to `POST /` + header, bypassing MITM. Also emit
  the now-mandatory initial-response frame and map the `auto` model slot
- **Kiro**: report real output tokens and stop discarding usable turns
- **Qoder**: detect billing blocks at stream start and return a synthetic 403
  so combo/account fallback triggers instead of leaking the error into chat
- **Antigravity**: strip competitive system prompts (Zed IDE's Claude-agent
  prompt) that Antigravity flags with a 429 Quota Exhausted
- **OpenCode**: send the official client fingerprint on free-tier requests so
  the Console stops classifying traffic as unidentified and rate-limiting it;
  session id resolves conversation-stable to preserve prompt caching
- **Responses**: don't close the message on an empty `tool_calls` array — some
  providers attach one to every chunk, and the truthy check ended the message
  on the first content token (#3234)
- **Translator**: preserve `prompt_cache_key` when converting chat to responses
- **Models**: expose snake_case token limits on `/v1/models`
- **Combos**: strip `stream_options` from the Fusion panel fan-out to avoid a
  DeepSeek 400 (#3024); raise the dashboard model-test probe budget to 1024 and
  soft-pass reasoning-only responses (#3010)
- **Headroom**: the toggle reflects the `headroomEnabled` setting even when the
  proxy is down — it previously showed OFF while the engine kept calling
  `/v1/compress`; proxy status stays visible via the status chip
- **Hermes**: add the `api_key` parameter to the model block in YAML config
- **Providers**: add llm7 to provider test support

## Docs
- **i18n**: add Spanish, French, and Brazilian Portuguese README translations

## Security
- **Real IP**: `x-9r-real-ip` and the Host fallback were trusted from
  client-controlled headers whenever `custom-server.js` was not in the request
  path (`npm run start`, `start:bun`), letting a remote caller pose as local to
  skip API key auth and reach `LOCAL_ONLY_PATHS` (`/api/mcp/*`,
  `/api/tunnel/enable`, `/api/auth/reset-password`). The server now stamps a
  per-process `x-9r-peer-token` on every request it sanitizes and only trusts
  `x-9r-real-ip` behind it — falling back to Host in development and failing
  closed in production (GHSA-pjm4-8fpg-f9p6). Also fixes IPv6 loopback
  detection (`::1`, `::ffff:127.0.0.1`) and routes `npm run start` /
  `start:bun` through `custom-server.js`
- **Search**: `resolveBaseUrl()` rejects client-supplied non-public baseUrls
  (SSRF guard on `/v1/search`)
- **Login**: fresh-install remote login with the default password returns 403
  without issuing a JWT
- **Usage**: `/api/usage/request-details` redacts request/response payloads

# v0.5.50 (2026-08-05)

## Features
- **Providers**: add TokenRouter (300+ models via OpenAI-compatible gateway) with
  exact per-model pricing for 110 models and `reasoning_effort` thinking config
- **Providers**: add Self-hosted STT / TTS / Embedding — point 9Router at your own
  OpenAI-compatible speech and embedding servers (whisper.cpp, faster-whisper,
  Kokoro-FastAPI, llama-server, vLLM, Infinity). Unlike the named cloud providers
  these read `baseUrl` per connection, so one provider can front several machines
- **Combos**: default-enable vision/audio capacity adapter (auto-routes to a
  vision/audio-capable model when the target lacks that capability, falling back
  to `oc/mimo-v2.5-free`), wired into chat handler routing
- **Endpoint**: auto-provision a "Default Key" for first-time users so `/v1`
  works without a manual dashboard step
- **Codex**: support GPT-5.6 Max/Ultra reasoning-level overrides (cx/ routes only)
- **Qoder**: support PAT (Personal Access Token) connections end-to-end, alongside
  OAuth device flow
- **CLI tools**: add OpenDesign (manalkaff/opendesign) support
- **Headroom**: report effective payload savings (tool schema/history bytes broken
  out, byte-savings % reflects actual outbound reduction)
- **Ollama**: Cloud quota tracker (session + weekly) + proactive background OAuth
  token refresh scheduler for all providers

## Fixes
- **Providers**: remove Qwen (OAuth flow stopped working reliably)
- **Passthrough**: detect codex-tui/Codex Desktop as native Codex client — they
  were falling through to the translator and losing fields like `reasoning.summary`
- **OAuth**: scope antigravity header fixes to loadCodeAssist/onboardUser only
- **OAuth**: keep `open` external in the build so xAI/Grok token refresh works on
  Windows
- **OAuth**: declare missing `searchParams` in register-session handler (was a
  500 instead of JSON on error)
- **DB**: `ENABLE_REQUEST_LOGS` env var now overrides the UI setting correctly;
  observability defaults to off (opt-in)
- **Translator**: preserve Codex Responses Lite tool use across chat-native
  OpenAI-compatible providers
- **Translator**: don't drop image-only user messages in `prepareClaudeRequest`
- **Translator**: drop JSON Schema keywords Gemini rejects (`uniqueItems`,
  `contains`, `multipleOf`, `unevaluatedProperties`, `unevaluatedItems`,
  `contentSchema`)
- **Claude**: remove global header cache that leaked one client's identity
  headers onto another client/account sharing the server; gate `anthropic-beta`
  by model instead
- **Antigravity**: drop retired Gemini 3.0 quota tiers, show Gemini 3.6 Flash
  usage bars
- **Cloudflare AI**: declare API key authentication (dashboard showed "No
  connections" despite an active key)
- **GitHub Copilot**: hold monthly-exhausted accounts until UTC month reset
  instead of only cooling down 120s
- **CodeBuddy**: dodge Tencent CN content filter, add usage tracking, normalize
  codebuddy-intl messages
- **Usage**: stop losing cached prompt tokens in the forced-SSE→JSON path
- **Grok CLI**: display the public subscription tier from the OAuth token claim
- **Providers**: count apikey connections for Ollama free-tier card; free-tier/
  apikey providers without `authModes` now default to apikey (were treated
  oauth-only)
- **Build**: include static/public assets in standalone output (login page hung
  on 404s when run via PM2)
- **Server**: support IntelliJ IDEA OpenAI-compatible clients over HTTP (h2c
  upgrade handling)
- **Auth**: redirect already-logged-in sessions away from `/login`
- **CLI tools**: enable Apply button for dynamic OpenAI/Anthropic-compatible
  provider connections
- **CLI**: include complete API artifacts in the CLI package
- **TTS**: a bare self-hosted model name is the MODEL, not the voice — `kokoro`
  was parsed as a voice against a default model, 404ing or synthesising with the
  wrong one
- **Embeddings**: self-hosted embeddings no longer fall back to `api.openai.com`
  when a connection has no `baseUrl` — that silently sent the input text and API
  key to OpenAI under a provider named "Self-hosted"
- **Embeddings**: an adapter that rejects a misconfigured connection now returns
  400 with the reason instead of escaping the handler uncaught
- **Embeddings**: bound the upstream fetch with `FETCH_CONNECT_TIMEOUT_MS` — an
  endpoint that drops packets never returns headers, so the request previously
  hung indefinitely

## Docs
- **i18n**: fix port typo, add RTK Token Saver feature descriptions

# v0.5.45 (2026-07-30)

## Features
- **TTS**: add Xiaomi MiMo text-to-speech (preset voices 冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean, style control, language hint dropdown with Auto-detect, i18n for Style label/placeholder)
- **Providers**: add Poolside (OpenAI-compatible)
- **Providers**: add api-airforce, baidu, bazaarlink, bluesminds, kilo-gateway, llm7, morph, sambanova, tencent
- **OAuth**: zed / trae / windsurf providers + harden callback proxies
- **CLI tools**: set Claude Code max context tokens
- **Qoder**: PAT auth + refresh model list
- **Gemini**: Gemini 3.6 Flash tier routing + Gemini 3.5 Flash Lite
- **Claude**: bump default Opus to `claude-opus-5`
- **Kiro**: add Claude Opus 5 models
- **Usage**: Kimi and DeepSeek usage handlers
- **Usage**: SuperGrok weekly pool via gRPC-web

## Fixes
- **Refresh**: rotate `refresh_token` between retry attempts
- **Kiro**: canonicalize tool history and route API keys correctly
- **Kiro**: normalize dashboard thinking intensity models
- **Cursor**: stop leaking agent tool errors as text
- **Gemini**: fill empty tool schemas after `$ref` strip
- **Antigravity**: strip `stream_options` from non-stream requests
- **Jina-reader**: recover after transient errors, use JSON POST API
- **Usage**: record exact embedding tokens
- **Tunnel**: preserve successor cloudflared PID
- **Console-log**: initialize capture at server boot + prevent SSE proxy buffering
- **Dashboard**: count dual-auth, free-tier OAuth and API-key connections correctly
- **Dashboard**: flex quota rows, thin global scrollbars, no hidden-row overflow

## Docs
- **i18n**: expand pt-BR translation to 986 terms
- README: Indonesian translation

# v0.5.40 (2026-07-20)

## Features
- **i18n**: add Khmer (km) translations
- **CLI tools**: configure Grok Build subagent models
- **Kimi**: merge OAuth into dual-auth provider, add K3 / K2.7 models
- **Dashboard**: ProviderTopology flow animation

## Fixes
- **DB**: resolve better-sqlite3 parameter binding crash
- **Translator**: pass `service_tier` through OpenAI → Responses conversion
- **Kiro**: map GPT-5.6 reasoning effort fields
- **Kiro**: validate terminal streams before emitting output
- **Kiro**: map GPT reasoning effort fields
- **Codex**: current `client_version` + refresh-aware model sync
- **Alicode-intl**: split into Coding Plan + Model Studio providers
- **Cursor**: HTTP/2 AgentService support + version bump 3.12.17
- **Dashboard**: cut duplicate API/icon spam, lazy-load provider assets


# v0.5.35 (2026-07-16)

## Features
- **xAI**: Grok Imagine video generation (`/v1/videos`) + CLI
- **CLI tools**: Grok Build setup — choose separate main/general-purpose/explore/plan models and preserve each model's context window
- **GitHub Copilot**: route Claude models through Copilot's native `/v1/messages`
- **Kiro**: add GPT-5.6 model family (#2596)
- **RTK**: `X-9Router-Token-Saver` header to bypass token savers per request
- **Providers**: quota visibility settings
- **Translator**: drop temperature for all Claude models
- **i18n**: Thai (th) + Persian (fa) translations / README

## Fixes
- **Providers**: bulk-add API keys no longer overwrite existing keys (gap-fill `Key N`)
- **Anthropic**: lowercase `anthropic-version` header to prevent duplication on `/v1/messages`
- **Alicode-intl**: use DashScope compatible-mode endpoint so standard keys work
- **Grok CLI**: align Grok Build with current subscription protocol (#2590)
- **Grok CLI**: surface `expiresAt` so proactive token refresh fires (#2546)
- **Kiro**: improve direct session cache reuse
- **Models**: populate capabilities for live-catalog LLM models
- **Models**: list compatible provider models in `/v1/models`
- **Thinking**: send explicit `thinking:{type:adaptive}` alongside `output_config.effort`
- **Translator**: strip `client_metadata` when converting openai-responses → openai

## Improvements
- **Perf**: skip inactive background services on startup

## Docs
- README: Persian YouTube tutorial

# v0.5.30 (2026-07-10)

## Features
- **Perplexity**: add Agent API provider (#2492)
- **Grok CLI**: add Grok CLI / Grok Build provider with OAuth device-code flow (#2502)
- **Featherless**: add OpenAI-compatible provider presets
- **SearXNG**: configure endpoint via SEARXNG_URL env (#2499)
- **Providers**: add max thinking level for gpt-5.6-sol (#2500)
- **Headroom**: add extras detection and install UI (#2403)
- **Headroom**: activate/uninstall extras + fix interpreter detection
- **PXPipe**: PXPIPE token saver — multimodal prompt compression (#2465)
- **Proxy-Pools**: auto-rotate strategy for no-auth providers (#2409)

## Fixes
- **Cloudflare-AI**: support accountId in bulk key import (#2449)
- **DB**: backup on schema change, MCP child cleanup, codex models, usage providers OOM
- **Codex**: avoid bare-email OAuth dedup (#2477)
- **CLI**: allow staged app bundle builds (#2479)
- **Headroom**: compress Kiro conversation state (#2488)
- **Gemini-CLI**: raise output floor for thinking and add validated toolConfig (#2486)
- **GitHub**: label Copilot profiles by account identity (#2498)
- **OpenAI-to-Claude**: unwrap bare {function:{…}} tools without parent type (#2473)
- **Translator**: clamp thinking effort max->xhigh for OpenAI format (#2466)
- **RTK/find**: detect and group Windows backslash-style find output (#2448)
- **Codex**: handle fast tier and capacity SSE (#2452)
- **Volcengine-ark**: clamp Kimi max_tokens to 32768 endpoint cap
- **Antigravity**: align provider fingerprint with IDE Desktop 2.1.1 (#2389)
- **Pricing**: update Claude/Codex model rates and add new models

## Improvements
- **i18n(zh-CN)**: complete Chinese translations for all UI strings (#2436)
- **API**: caching for tunnel and version status endpoints
- **Perf**: faster dev startup and lighter bundle

# v0.5.20 (2026-07-07)

## Features
- **Thinking**: per-model thinking level picker on provider page — appends `(level)` suffix to copied model names for forced reasoning effort across all formats (openai, claude, gemini, deepseek, kimi, qwen, zai, minimax, hunyuan, step)
- **RTK**: add JS-native git-log filter (#2423)
- **Caveman**: add targeted upstream-aligned style rules (#2424)
- **i18n**: add Farsi (fa) language support (#2385)

## Fixes
- **Thinking**: strip `(level)` suffix from upstream `body.model` so providers no longer reject requests
- **Translator**: preserve developer instructions in openai-responses conversion (#2434)
- **count_tokens**: count structured Anthropic blocks (#2419)
- **Volcengine-ark**: clamp GLM-5 max_tokens to model output ceiling (#2428)
- **Kimi**: normalize reasoning_effort to backend enum (#2427)
- **Claude**: reconcile max_tokens vs thinking budget and lift per-model ceiling (#2381)
- **Kiro**: deliver system prompt natively, add Opus 4.5/4.7/4.8, tolerate dash version ids (#2366)
- **Headroom**: proxy dashboard through app (#2372)
- **MITM**: recover from stale lock file on server start

# v0.5.18 (2026-07-03)

## Features
- **Usage**: track cached tokens + correct input/output/cache cost (#2209) — hodtien
- **Codex**: show reset credit expiry details (#2290) — Rafli Ahmad Zulfikar
- **NVIDIA**: add new models and capabilities
- **ClinePass**: add provider support — sternelee

## Fixes
- **Usage**: dedupe streaming request-details log entries — Qin Li
- **Claude**: drop foreign thinking signatures in passthrough
- Prevent non-SSE stream pipe crash and cross-IdP account overwrites (#2244) — KunN-21
- **Kiro**: route IdC auth to regional CodeWhisperer surface (#2297) — Volodymyr Saakian
- **Kiro**: add Claude Sonnet 5 model support (#2264) — Edison42
- **Xiaomi-tokenplan**: region selector, key validation, multi-connection (#2251) — MiQieR
- **Translator**: strict Anthropic content block compliance (#2225) — Sahrul Ramadhan Hardiansyah
- **Kimchi**: strip reasoning_content echo to bound multi-turn input tokens — KunN-21
- **Kimchi**: bump User-Agent to kimchi/0.1.40 (#2256) — Ansh7473
- **Codebuddy-cn**: strip empty tool_calls arrays to preserve reasoning — zmf
- **Antigravity**: preserve Claude tool delta index (#2223) — Sutarto Jordan Chrisfivo
- **MITM**: generate root CA on server startup (#2228) — Sutarto Jordan Chrisfivo

# v0.5.15 (2026-06-29)

## Features
- Add Kimchi OAuth provider — Nant361
- Refine Qwen vision/video + thinking model patterns
- Opt-in Codex auto-ping quota keep-alive — Emirhan

## Fixes
- **Responses**: handle response.done terminal events (#2142) — rifuki
- **Headroom**: skip unsafe responses tool history (#2132) — Sutarto Jordan Chrisfivo
- **Translator**: map mid-conversation system message to user (claude→openai)
- **Gemini**: normalize contents to prevent 400 invalid_argument (#2192) — warelik
- **Gemini**: backfill thoughtSignature + suppress stream done sentinel — WARELIK
- **Alicode**: preserve cache_control for DashScope providers (#2069) — Rex
- **Antigravity**: strip deprecated/readOnly/writeOnly from tool schemas — iletai, Yudhistira-Official
- **CodeBuddy CN**: show bonus packs as one-time, not monthly-replenishing — whale9820
- **Kiro**: strip leaked <thinking> tags from content stream (#2158) — hamsa0x7
- **Tray**: make Windows context menu DPI-aware — Emirhan
- **Kilocode**: expose full gateway catalog in combo model picker — jellylarper
- **OpenCode**: fix Go GLM

# v0.5.12 (2026-06-26)

## Features
- Add token-saver dashboard page
- Add bulk delete for provider connections — teddytkz
- Resolve GitHub Copilot model catalog from upstream — caiqinzhou
- Add Venice AI provider — Brokenc0de
- Add Kiro external_idp import for Microsoft SSO (CLIProxyAPI) — Stevanus Pangau
- Overhaul Blackbox provider catalog + WebUI test support — suryacagur

## Fixes
- Provider thinking compatibility (DeepSeek/Gemini) — Mink Nguyen
- Stop double-counting streaming usage at source
- Usage logging dedupe to reduce stats churn — Mink Nguyen
- Prevent non-JSON SSE lines / duplicate [DONE] from breaking clients (PR #2046) — qianze
- Resolve Gemini TTS models from catalog — nguyenha935
- Support Kiro IDC (organization) token import — quanturbo
- Preserve forced streaming for JSON clients (#2031) — Joseph Yaksich
- Preserve Responses text format (Codex) — tenglong
- Support Gemini native TTS generateContent endpoint — nguyenha935
- Add missing zh-CN endpoint key label (i18n) — weimaozhen
- CodeBuddy: only send reasoning params when client requests reasoning (#2071) — Rex
- CodeBuddy CN: show one-shot bonus packs as expiring, not monthly-replenishing
- Show custom provider models in combo picker — Sapto
- Docker: add docker-compose.yml with headroom enabled by default — nitsuahlabs
- Clarify token diagnostics vs provider billing (headroom, #1998) — Sutarto Jordan Chrisfivo
- Translate openai-responses input through OpenAI for compression (#1998) — Ankit
- Kiro: report 1M context window for claude-opus-4.8 — EdisonPVE
- Avoid stale redirects after auth changes (#2100) — Emirhan
- Mark Claude Opus 4.7 (dashed id) as 1M context — Brokenc0de
- Preserve reasoning effort through Codex translations — ntdung6868
- Token-saver: full width card layout
- Antigravity: retry transient upstream failures — Sutarto Jordan Chrisfivo
- Param-support: handle strip rules without match/drop (#1960) — Joseph Yaksich
- Translator: resolve custom provider prefix in debug endpoint (#1083) — hamsa0x7

# v0.5.8 (2026-06-21)

## Features
- **Antigravity**: native image generation support (image models tagged kind:image, hiển thị trong media-providers UI)
- **CodeBuddy CN**: API key auth + credit quota tracker
- **CodeBuddy CN**: short model prefix alias "cbcn"

## Fixes
- **MiniMax-M3**: enable vision capability
- **Headroom**: support Docker sidecar proxy
- **Antigravity**: image executor fixes
- **mimo-free**: Chrome User-Agent rotation to bypass anti-abuse gate
- **cloudflare-ai**: flatten content-part arrays to string to avoid oneOf 400 (#1926)
- **Translator**: normalize tools to Anthropic-native shape for non-Anthropic providers
- **CLI**: handle Next.js 16 nested standalone output path (#1940)
- **Codex**: preserve custom tools during request normalization
- **next.config**: add new route for responses endpoint to API

# v0.5.6 (2026-06-20)

## Features
- **Ponytail**: minimalist code generation feature
- **Headroom**: proxy lifecycle management + dashboard UI (one-click start/stop, install detection, status probing, token saver, claude↔openai shape conversion)
- **CodeBuddy CN**: new OAuth provider (copilot.tencent.com) — 15-model catalog, /v2 inference, forced streaming, OpenAI-style reasoning
- **OpenCode-Go**: align models with official endpoints; route Qwen 3.7 MiniMax via /v1/messages, GLM/Kimi/DeepSeek/MiMo via /chat/completions

## Fixes
- **Anthropic-compatible validation**: use POST /v1/messages (GET /models not spec, false "invalid" for valid keys)
- **CLI tools**: tolerate JSONC configs in all 8 settings routes (opencode, openclaw, kilo, droid, cowork, copilot, claude, cline)
- **Gemini/Antigravity**: preserve 'pattern' in tool schema translation (glob/grep)
- **Combo/Fusion**: flatten Anthropic-style tool messages in panel calls (prevent 503)
- **Models**: store provider custom models by provider scope
- **Perplexity**: use /v1/models endpoint for key validation

# v0.5.4 (2026-06-18)

## Fixes
- **Kiro**: honor thinking effort budgets
- **AG/Kiro/Xiaomi**: provider fixes
- **Combo/Fusion**: flatten tool history in panel calls to prevent 503
- **LLM selector**: show custom vision models in selector and model list
- **Image**: prevent compatible nodes from shadowing provider aliases

# v0.5.2 (2026-06-17)

## Features
- **Combo Fusion strategy** — fans the prompt out to all member models in parallel, then a configurable judge model synthesizes one final answer (quorum-grace, anonymized sources, graceful degradation)
- **Per-combo strategy selector** — pick `fallback` / `round-robin` / `fusion` / `capacity` per combo (replaces the old round-robin toggle), with a judge picker for fusion
- **Capacity auto-switch** — reorders models per request so images/PDFs route to capable models first
- **Kiro headless API-key auth** (`ksk_`) + direct `claude↔kiro` route that avoids the lossy OpenAI two-hop pivot
- **Claude auto-ping** — warms the 5h quota window right after reset so a fresh window starts immediately (per-connection toggle)

## Fixes
- **Claude 429**: stop hammering the OAuth usage endpoint — cache resetAt, throttle quota refresh to 3 min, cool down after a 429 (chat unaffected)
- **Usage logs always empty**: missing `await` on `getAdapter()` in `getRecentLogs` made `/api/usage/logs` & `/api/usage/request-logs` return nothing
- **Executors**: strip params unsupported by the provider/model (drops deprecated `temperature` for claude-opus-4 → Anthropic 400)
- **Translator**: derive deterministic tool_call ids for gemini/antigravity → OpenAI so function call/response pair correctly (fixes tool-pairing 400s)
- **Antigravity**: strip `optional` from tool schemas before sending to Gemini
- **Claude-to-OpenAI**: handle OpenAI-format responses in the non-streaming path (e.g. xiaomi-tokenplan)
- **Usage views**: show edited connection names consistently across Providers & Quota Tracker
- **Security**: hardened reverse-proxy local-access trust
- **Security**: SSRF hardening on web fetch

## Internal
- Large **open-sse / translator refactor** (~40 commits): unified provider/model registry (LiteLLM-style `models[]` + `kind` field, 100 co-located registry files), single-sourced media/OAuth/refresh/token URLs, registry-based dispatch for usage & token-refresh, DRY translator concerns (buildUsage, encodeDataUri, finishReasonMap, chunkBuilder, reasoningDelta…), ESM-safe registry init, large-file splits, dead-code removal, and golden/no-regression test gates

# v0.4.80 (2026-06-13)

## Features
- Vercel AI Gateway: support embeddings, images and credit usage (#1183)
- Add MiMo Free no-auth provider (#1789)
- Vertex: support ADC `authorized_user` credential
- Cowork: re-enable Claude Cowork with preset-only stdio MCP
- Codex: bulk add accounts via JSON (#1719)
- Kiro: enable multi-endpoint failover for GenerateAssistantResponse (#1722)

## Fixes
- Security: re-auth on DB export/import + SSRF guard on web fetch
- Auth: real client IP rate-limiting + remote default-password guard
- Cerebras/Mistral: strip unsupported `client_metadata` from downstream requests (#1742)
- SiliconFlow: update baseUrl `.cn` -> `.com` + curate verified model list (#1760)
- Gemini-to-OpenAI: route unsigned thought parts to `reasoning_content` (#1752)
- Claude-to-OpenAI: strip Anthropic billing header from system prompt (#1765)
- Anthropic-compatible: send Bearer auth for third-party gateways (#1795)
- Usage-stats: avoid partial stats on initial SSE race (#1767)
- Proxy: use `export default` in proxy.js for Next.js 16 middleware detection
- Claude passthrough: add body normalization
- GitHub Copilot: refresh missing/expired token on models discovery (#1727) + add mappable gpt-5-mini/gpt-5.4-nano slots for Copilot MITM (#1653)
- Kiro: auto-resolve profileArn to prevent 403 on IDC login, enhance profile ARN resolution, update endpoint to `runtime.us-east-1.kiro.dev` (#1713)
- Tunnel: detect system-installed Tailscale via dual-socket probe (#1723) + non-blocking probes to prevent UI freeze
- CommandCode: force `stream=true` in transformRequest (#1706)
- Qoder: increase timeouts for reasoning models and improve stream handling
- Dashboard: show provider node name instead of connection name in topology (#1770) + show explicit `kind="llm"` combos on combos page (#1684)

## Docs
- README: add Indonesian 9Router tutorial video (#1709)

# v0.4.71 (2026-06-06)

## Features
- Caveman: add wenyan classical Chinese levels and sync upstream prompts; locale-based visibility on endpoint page
- i18n: endpoint exposure notice across multiple languages + Russian README
- Antigravity: add gemini-3.5-flash-extra-low (Low) model
- xiaomi-tokenplan: add Claude-native MiMo V2.5 Pro alias via dedicated executor
- Qoder: fetch latest model + dashboard import-model button (#1642)
- MiniMax: add MiniMax-M3 + update Quota Tracker coding/CN (#1631)

## Fixes
- Codex: harden streaming timeouts (stall/connect raised to 60s, configurable per-provider), accept `response.done` event, and always emit a terminal `response.failed` + `[DONE]` for Responses passthrough when a stream closes, stalls, or aborts before a terminal event — prevents codex clients from hanging (#1648, #1680, #1688, #1618)
- Codex: durable OAuth refresh lifecycle (#1664)
- Tunnel: skip virtual interfaces to prevent false netchange watchdog
- Claude: fix forced tool_choice 400 on cc/ OAuth route (#1592)
- Proxy: raise Next client body limit to 128MB via `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE` (#1529, #1572)
- MiniMax: echo `reasoning_content` on follow-up turns to avoid 400 (#1543)
- Kiro: handle 400 on tool-bearing history without client tools; add mappable "auto" model slot; fix binary EventStream crash + add models & TTS tool filtering
- Antigravity: passthrough tab-autocomplete + mark default agent slot mandatory
- Qoder: allow `qmodel_latest` model key (#1638)
- Providers: restore one-connection guard for compatible/embedding nodes
- Model-test: route image/STT probes to their real endpoints, harden STT ping; add opencode-go + xiaomi-tokenplan to connection test (#1576, #1628)

## Improvements
- Dashboard: reorganize menu actions across sidebar/header/profile
- Translator: add data-driven coverage, bug-exposing cases, and real provider smoke tests

# v0.4.66 (2026-05-29)

## Features
- Add Qoder provider: device-flow OAuth, COSY signing, WAF-bypass body encoding, live model catalog, dashboard quota tracker, 11 models (#1372)
- Add new models: Claude Opus 4.8 (Claude Code), GPT 5.4 Mini (Codex)

## Fixes
- DeepSeek thinking mode: echo `reasoning_content` back on follow-up/tool-call turns so OpenCode-free and custom providers no longer 400 with "reasoning_content must be passed back" (#1543)
- Reasoning injector: match deepseek/kimi model ids case-insensitively (covers custom providers using capitalized model names)
- OpenCode suggested-models: include free models without the `-free` suffix, e.g. `big-pickle` (#1535)

## Improvements
- Codex: trim sunset models, keep gpt-5.5 / gpt-5.4 / gpt-5.3-codex family, add gpt-5.4-mini
- volcengine-ark: refresh model list (add DeepSeek-V4-Flash/Pro, drop EOL entries)
- Lower stream stall timeout 35s → 30s for faster hang detection

# v0.4.63 (2026-05-26)

## Fixes
- GitHub Copilot: never route Gemini/Claude models to the `/responses` endpoint; prevents misleading "does not support Responses API" 400s (#1062)
- proxyFetch: restore missing `Readable` import causing runtime `ReferenceError` in DNS-bypass fetch path

## Improvements
- Lower stream stall timeout from 60s → 35s for faster hang detection

# v0.4.62 (2026-05-26)

## Fixes
- Codex: auto-retry when upstream drops mid-stream (no more hangs)
- Codex: fix random 400/404 errors, tool-calling failures, and unstable prompt cache
- MITM: support Antigravity 2.x 
- Sanitize Read tool args to prevent retry loops from non-Anthropic models (#1144)
- Implement json_schema fallback for OpenAI-compatible providers without native Structured Output (#1343)
- Strip empty Read pages argument in OpenAI-to-Claude translator (#1354)
- Forward Gemini output dimensions for embeddings (#1366)
- Resolve setState-in-effect errors in dashboard components (#1362)
- Gemini CLI: reuse stored OAuth project IDs for quota checks and show clearer setup guidance when the project is missing (#1271, #1428)

## Features
- Add Cloudflare Workers proxy deployer and pool integration (#1360)
- Add Deno Deploy relays support and improved proxy pools dashboard layout (#1437)

## Improvements
- Refactor Tunnel into dedicated Cloudflare and Tailscale manager modules
- Refactor tokenRefresh service with in-flight dedup to prevent refresh_token_reused errors

# v0.4.59 (2026-05-21)

## Fixes
- OAuth: fix login flow on Windows

# v0.4.58 (2026-05-21)

## Features
- xAI Grok provider (OAuth, API key, image)
- Provider limits: paginated accounts with page size controls

## Fixes
- Tailscale: fix connection status on Windows (#1300)
- Tunnel: fix false "checking" when tunnel URL is reachable
- Stream: fix pipe errors on client disconnect/abort

# v0.4.55 (2026-05-18)

## Features
- Xiaomi MiMo Token Plan: region selector (Singapore / China / Europe) — keys are cluster-specific
- Antigravity: risk confirmation dialog before first connection
- Gemini CLI: surface upstream retry delay on 429 errors

## Fixes
- MITM: cannot kill process on macOS under sudo (lsof not found in PATH)
- Stream: false-positive stall timeout on Claude reasoning / Kiro responses
- Tunnel: cannot re-enable after disable (stuck state)
- Tunnel: cloudflared error messages now include log tail for easier debugging
- Language switcher: applies selected locale immediately on close (#1234)
- Antigravity OAuth: metadata now matches the official client

## Improvements
- Gemini CLI: bump engine to 0.34.0
- Re-hide `qwen` (OAuth EOL) and `iflow` (not ready) providers

# v0.4.52 (2026-05-17)

## Features
- Add Vercel AI Gateway provider support (#1183)
- rtk: Kiro format tool result compression — handle conversationState.history & currentMessage, preserve error results, ~13.6% savings (#1194)

## Fixes
- openclaw: normalize agent.model object form `{primary, fallbacks}` before .startsWith → fix TypeError & 'not configured' status (#1216)
- Usage Details pagination: stay inside mobile viewport <640px (#1218)
- Fix test model error
- Fix MIMO provider in Codex
- Disable log file creation when using MITM AG

# v0.4.50 (2026-05-16)

## Fixes
- Fix duplicate tray icon on macOS when hiding to tray
- Fix tray not showing in background mode on macOS
- Fix hide to tray broken on Windows/Linux
- Fix Shutdown button in web UI not working

# v0.4.49 (2026-05-16)

## Features
- Add Kiro provider support: full request/response translation, live model listing, reasoning content support
- Add `buildOutput` RTK filter with autodetect for npm/yarn/cargo build logs
- Add MITM warning notification in tray and dashboard

## Improvements
- Add modalities (input/output) to model configuration for OpenCode
- Fix tray hide-to-tray: keep current process alive instead of spawning detached child (fixes macOS NSStatusItem ghost icon)
- Fix tray kill: graceful shutdown with SIGTERM/SIGKILL escalation
- Fix SIGHUP handling so macOS terminal close doesn't kill tray process
- Hide deprecated providers (qwen, iflow, antigravity)
- Update i18n across 32 languages

## Fixes
- Fix model check (test-models) blocked by dashboardGuard: pass machineId-based CLI token in internal self-calls

# v0.4.46 (2026-05-15)

## Breaking Changes
- Tunnel public URL changed — old tunnel links no longer work, please reconnect to get the new URL
