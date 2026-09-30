# Plan: Native Meta Code (Muse Spark) provider — YAN-6 / GH #98

## Summary

Add a `meta-code` provider (alias `mc`) that talks to Meta Model API (`https://api.meta.ai/v1`) directly.
Two auth modes: **device-code OAuth identical to the `muse` CLI** (mints the subscription-bound
API key, so usage is billed at subscription rates) and **paste API key** (pay-as-you-go or a key
copied from `~/.config/muse/auth.json`). OAuth connections get a 5h + weekly quota tracker.

## User Story

As a 9router user with a Muse Code subscription, I want to sign in like the `muse` CLI does, so that
requests use my subscription key (not pay-as-you-go) and I can see my 5h / weekly quota.

## Problem → Solution

Muse only via OpenCode (`oc`/`ocg`), or a custom OpenAI-compatible provider with a hand-copied
key and no quota → first-class provider with CLI-equivalent login, key auto-mint/re-mint, quota.

## Metadata

- **Complexity**: Large (~20 files, mostly small list edits)
- **Source PRD**: N/A (Linear YAN-6, GitHub #98)
- **Estimated Files**: 22

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/9router/.config/opencode/worktrees/9router-feat-yan-6-meta-code-provider/ (branch: feat/yan-6-meta-code-provider)

---

## Research Findings (verified live 2026-09-24)

Reverse-engineered from the `muse` launcher script (`~/.local/bin/muse`) and binary
`muse-bin-1.3.0-R3401.1`, then verified with real requests.

| Fact                                                                                                                                                                                                                                                                                                                                                                                               | Evidence                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Device flow: `POST https://auth.meta.com/oidc/device/authorization/` form `client_id` → `{device_code,user_code,verification_uri,verification_uri_complete,expires_in:600,interval:5}`                                                                                                                                                                                                             | launcher L7-12, live 200 |
| Poll: `POST https://auth.meta.com/oidc/device/token/` form `grant_type=urn:ietf:params:oauth:grant-type:device_code, device_code, client_id` → `{access_token:"dca:…", token_type:"Bearer"}`. **No refresh_token, no expires_in.** Errors: `authorization_pending`, `slow_down` (must back off +5s), `expired_token`, `access_denied`                                                              | live test                |
| Client ID: public CLI client `1031625952748946` (launcher L8). Kept out of source → env `META_CODE_OAUTH_CLIENT_ID`                                                                                                                                                                                                                                                                                | issue requirement        |
| Mint: `POST https://api.meta.ai/muse-code/key`, headers `Authorization: Bearer <dca>`, `x-api-version: 1.0.0`, `Content-Type: application/json`, body `{}` → `{api_key:"LLM\|…", base_url, user_email, user_full_name, is_subs_active, subs_tier_name, require_payment, action_url, subs_usage:{window:{used_percent,window_duration_mins:300,resets_at}, weekly:{used_percent,resets_at}, tier}}` | live 200                 |
| Mint is **idempotent**: fresh device login + mint returns the same subscription key already in `~/.config/muse/auth.json` → re-minting never breaks prod                                                                                                                                                                                                                                           | live compare             |
| Mint rejects plain API keys (401) → quota only available for OAuth connections                                                                                                                                                                                                                                                                                                                     | live 401                 |
| Inference: OpenAI-compatible, Bearer key. `/v1/models`, `/v1/chat/completions`, `/v1/responses`, `/v1/messages` all 200                                                                                                                                                                                                                                                                            | live                     |
| `/v1/responses` stream emits standard `response.*` events incl. reasoning summary + extra `response.subscription_usage`. `/v1/chat/completions` stream emits **no reasoning deltas** → Responses is the right default target                                                                                                                                                                       | live                     |
| Models: `muse-spark-1.3`, `muse-spark-1.2`, `muse-spark-1.1`, `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor` (+ non-chat `muse-image-1.0`, `muse-voice-transcribe-1.0`, `sam-3.1`)                                                                                                                                                                                                     | `/v1/models`             |

## Design Decisions

- **Connection shape (OAuth)**: `accessToken` = minted `LLM|` key (what every executor/test path
  already sends as Bearer); `refreshToken` = `dca:` token (re-mint credential). This makes the
  existing 401 → `refreshCredentials` → retry path in `chatCore.js:578-605` re-mint for free, with
  one `REFRESH_HANDLERS` entry. `expiresAt` null (key does not expire).
- **Transport**: `format: "openai-responses"`, `baseUrl: https://api.meta.ai/v1/responses`,
  `DefaultExecutor`. No custom executor unless live test shows body rejections.
- **Usage**: OAuth only (`features.usage: true`, no `usageApikey`). Handler re-calls mint with the
  `dca` token and maps `subs_usage` → `Session (5h)` / `Weekly` percent quotas.
- **Shared helper**: `open-sse/services/metaCode.js` — `mintMetaCodeKey()` + `parseMetaSubsUsage()`
  used by OAuth postExchange, token refresh and usage (DRY).
- **Env client**: generalize the OAuth-defaults plumbing from id+secret pairs to key lists so a
  single-value `META_CODE_OAUTH_CLIENT_ID` embeds into Docker/npm like the Google clients.

## NOT Building

- Live `/models` fetcher (static list matches upstream; add when Meta ships new ids often).
- Quota for API-key connections (would need passive capture of `response.subscription_usage`
  from streams; add if users ask).
- `/v1/messages` passthrough transport for Claude clients (translation already works; add if lossy).
- Provider PNG icon (`display.textIcon` fallback).
- Muse Image / Voice / SAM models.

---

## Patterns to Mirror

### REGISTRY (dual auth)

```js
// SOURCE: open-sse/providers/registry/kimi.js:7-24
category: "oauth",
authModes: ["oauth", "apikey"],
hasOAuth: true,
```

### DEVICE_CODE_MODULE

```js
// SOURCE: src/lib/oauth/providers/grok-cli.js:83-136
body: new URLSearchParams({ client_id: config.clientId, scope: config.scope });
const pending = data?.error === "authorization_pending" || data?.error === "slow_down";
```

### POST_EXCHANGE_MINT

```js
// SOURCE: src/lib/oauth/providers/github.js:55-95
postExchange: async (tokens) => { /* Bearer tokens.access_token → second token */ }
copilotToken: extra?.copilotToken?.token,
```

### REFRESH_HANDLER

```js
// SOURCE: open-sse/services/tokenRefresh.js:140-177
"grok-cli": (c, log) => refreshXaiToken(c.refreshToken, log),
```

### USAGE_HANDLER

```js
// SOURCE: open-sse/services/usage/misc.js:86-121 + shared.js:15-70
return { used: usedPct, total: 100, remainingPercentage: 100 - usedPct, resetAt, unlimited: false };
parseResetTime(sec); // → ISO; fetchWithTimeout(url, opts, 10000, proxyOptions)
```

### TEST_STRUCTURE

```js
// SOURCE: tests/unit/grok-cli-executor.test.js:17-34, tests/unit/usage-dispatch.test.js:3-36
import REGISTRY from "../../open-sse/providers/registry/index.js";
vi.mock(".../proxyFetch.js", () => ({ proxyAwareFetch: vi.fn(...) }))
```

---

## Files to Change

| File                                                                                | Action             | Justification                           |
| ----------------------------------------------------------------------------------- | ------------------ | --------------------------------------- |
| `open-sse/services/metaCode.js`                                                     | CREATE             | Shared mint + subs_usage parser         |
| `open-sse/providers/registry/meta-code.js`                                          | CREATE             | Provider entry                          |
| `open-sse/providers/registry/index.js`                                              | UPDATE             | Register entry                          |
| `open-sse/services/tokenRefresh.js`                                                 | UPDATE             | `meta-code` re-mint handler             |
| `open-sse/services/usage/meta-code.js`                                              | CREATE             | Quota handler                           |
| `open-sse/services/usage.js`                                                        | UPDATE             | Dispatch + pass `refreshToken` in ctx   |
| `src/lib/oauth/providers/meta-code.js`                                              | CREATE             | Device flow + mint                      |
| `src/lib/oauth/providers/index.js`                                                  | UPDATE             | Register module                         |
| `src/lib/oauth/constants/oauth.js`                                                  | UPDATE             | `META_CODE_CONFIG` with env client id   |
| `src/shared/components/OAuthModal.js`                                               | UPDATE             | Device-code provider list               |
| `src/app/api/oauth/[provider]/[action]/route.js`                                    | UPDATE             | Two no-PKCE lists                       |
| `src/app/api/providers/[id]/test/testUtils.js`                                      | UPDATE             | OAuth test probe + refresh branch       |
| `src/app/api/providers/validate/route.js`                                           | UPDATE (if needed) | `/responses` → `/models` probe          |
| `custom-server.js`                                                                  | UPDATE             | Key-list OAuth defaults incl. meta      |
| `scripts/write-oauth-clients.cjs`                                                   | UPDATE             | Add meta-code entry                     |
| `Dockerfile`, `.github/workflows/docker-publish.yml`, `compose.yml`, `.env.example` | UPDATE             | Env plumbing                            |
| `.env.encrypted`                                                                    | UPDATE             | `META_CODE_OAUTH_CLIENT_ID` via dotenvx |
| `tests/__baseline__/*-baseline.json`, `verify-alias.mjs`, `verify-oauth-urls.mjs`   | UPDATE             | Snapshots                               |
| `tests/unit/meta-code-provider.test.js`                                             | CREATE             | Critical-path tests                     |
| `tests/unit/usage-dispatch.test.js`, `tests/unit/antigravity-oauth-client.test.js`  | UPDATE             | Dispatch list; single-key defaults      |

---

## Step-by-Step Tasks

### Batch 0 (sequential, lead)

#### Task 0.1: Shared Meta helper

- **ACTION**: Create `open-sse/services/metaCode.js`.
- **IMPLEMENT**: `META_CODE_KEY_URL`; `mintMetaCodeKey(dcaToken, proxyOptions)` → POST via `proxyAwareFetch`, throws `Error` with `status` on non-2xx, throws when `api_key` empty; `parseMetaSubsUsage(subs)` → `{ "Session (5h)", Weekly }` percent quotas.
- **MIRROR**: USAGE_HANDLER.
- **GOTCHA**: `resets_at` is unix seconds; clamp `used_percent` 0-100.
- **VALIDATE**: unit test (Task 3.1).

### Batch 1 (parallel, depends on 0.1)

#### Task 1.1: Registry + routing + provider test

- **ACTION**: Registry file, index import, testUtils OAuth probe (`GET https://api.meta.ai/v1/models`, Bearer, `refreshable: true`) + add `meta-code` to the refresh branch at testUtils ~L259; confirm validate route builds `/v1/models` from `/v1/responses` base.
- **MIRROR**: REGISTRY. Models: 5 `muse-spark*` ids. `display.textIcon: "MC"`, `notice.apiKeyUrl: https://dev.meta.ai`.
- **GOTCHA**: alias `mc` must stay unique; no `clientId` in registry source.
- **VALIDATE**: `node tests/__baseline__/verify-providers.mjs` shows only `+ meta-code`.

#### Task 1.2: OAuth device flow + refresh + env plumbing

- **ACTION**: OAuth module, dispatcher registration, `META_CODE_CONFIG`, modal + route lists, `REFRESH_HANDLERS["meta-code"]` (re-mint with `c.refreshToken`, returns `{accessToken, refreshToken}`), env plumbing files.
- **MIRROR**: DEVICE_CODE_MODULE, POST_EXCHANGE_MINT, REFRESH_HANDLER.
- **GOTCHA**: requestDeviceCode throws `META_CODE_OAUTH_CLIENT_ID not configured` when unset; mint `require_payment` / `!api_key` → clear error with `action_url`.
- **VALIDATE**: `node --check custom-server.js`; `node scripts/write-oauth-clients.cjs --check` with env set.

#### Task 1.3: Usage handler

- **ACTION**: `open-sse/services/usage/meta-code.js` + dispatch; add `refreshToken` to handler ctx.
- **MIRROR**: USAGE_HANDLER. Return `{ plan: subs_tier_name, quotas }`; `{ message }` when no dca / 401.
- **VALIDATE**: usage-dispatch test.

### Batch 2 (lead)

#### Task 2.1: Secrets + baselines

- **ACTION**: `dotenvx set META_CODE_OAUTH_CLIENT_ID … -f .env.encrypted`; `gh secret set META_CODE_OAUTH_CLIENT_ID`; regenerate baselines (`snapshot-providers.mjs`, `verify-alias.mjs --snapshot`, `verify-oauth-urls.mjs --snapshot`).
- **VALIDATE**: all three verify scripts exit 0.

#### Task 3.1: Tests + live verification

- **ACTION**: `tests/unit/meta-code-provider.test.js` (registry URL/format, mint mapping, subs parse, poll slow_down/pending mapping, refresh handler); live chat + responses stream + tool call + image through local dev server with the real key.
- **VALIDATE**: `npm test` gate green, `npm run lint`.

---

## Testing Strategy

| Test         | Input                  | Expected                                | Edge                    |
| ------------ | ---------------------- | --------------------------------------- | ----------------------- |
| subs parse   | window 0% / weekly 5%  | two quotas, ISO resets                  | clamp >100              |
| mint mapping | mint JSON              | accessToken=`LLM…`, refreshToken=`dca:` | empty api_key throws    |
| poll mapping | `slow_down`            | pending, not error                      | `expired_token` → error |
| refresh      | 401 on inference       | re-mint → new creds                     | dca 401 → null          |
| registry     | PROVIDERS["meta-code"] | responses URL, oauth+apikey             | alias `mc`              |

## Validation Commands

```bash
node tests/__baseline__/verify-providers.mjs
node tests/__baseline__/verify-alias.mjs
node tests/__baseline__/verify-oauth-urls.mjs
cd tests && npx vitest run unit/meta-code-provider.test.js unit/usage-dispatch.test.js unit/antigravity-oauth-client.test.js
npm run lint
npm test
```

## Acceptance Criteria

- [ ] Connect via device code from dashboard; models listed.
- [ ] `/v1/chat/completions` + `/v1/responses` stream (reasoning, tools, image) via `mc/muse-spark-1.3`.
- [ ] 401 re-mints key (token refresh equivalent).
- [ ] Combo `mc/muse-spark-1.3` → `ocg/muse-spark-1.3-contributor` falls back.
- [ ] Quota shows 5h + weekly for OAuth connection.
- [ ] No credentials in source.

## Risks

| Risk                                      | Mitigation                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `dca` token silently expires              | 401 on mint → refresh returns `invalid_grant`-style null → user re-auths (same as CLI) |
| Responses body fields rejected by Meta    | live test; add minimal executor only if needed                                         |
| Publish check fails without new GH secret | set `META_CODE_OAUTH_CLIENT_ID` repo secret before merge                               |
