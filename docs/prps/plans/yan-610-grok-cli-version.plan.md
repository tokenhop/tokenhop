# YAN-610: make GROK_CLI_VERSION env-configurable and bump to 1.0.44

GitHub: tokenhop/tokenhop#395 · Linear: YAN-610 · Target: v0.5.x patch (PR into `master`, then `backport:0.5` to `release/0.5`)

## Problem

`cli-chat-proxy.grok.com` returns HTTP 426 for client version `0.2.99` (it needs 1.0.13 or later). The version is hardcoded
(`open-sse/config/grokCli.js`). The OAuth device flow and the connection-test fallback carry a second, stale fingerprint:
`grok-pager/0.2.93 grok-shell/0.2.93`.

## Research findings (Grok CLI 1.0.44 wire capture via mitmproxy)

- The hosts, endpoints (`/v1/responses`, `/v1/models`, `/v1/user`, `/v1/billing`), OAuth client id, `referrer=grok-build`
  and the Responses body shape are all unchanged. **Bumping the version is enough to clear the 426.**
- The UA is always `grok-shell/<v> (linux; x86_64)`, and `grok-pager/...` is no longer sent anywhere. `x-grok-client-version`
  is now also sent on the auth.x.ai device-code and token calls.
- Not in this patch, since it would change behaviour we can't live-verify for a backport:
  - `x-xai-token-auth` and `x-grok-client-mode` on `/responses`. Upstream commit 5af08d26 removed these on purpose.
  - The new `/responses` headers: `x-grok-conv-group-id`, `x-authenticateresponse`, compaction and doom-loop.
  - The `workspaces:*` OAuth scopes, `include: no_inline_citations`, and the new default model `grok-4.6`.

  Each of these goes to a follow-up issue.

## Design

One source of truth, `open-sse/config/grokCli.js`:

```js
import { envString } from "./envOverride.js";
export const GROK_CLI_VERSION = envString("GROK_CLI_VERSION", "1.0.44", /^\d+\.\d+\.\d+$/);
```

`GROK_CLI_USER_AGENT` already derives from it. Every Grok call site (registry, executor, models, usage, connection test,
OAuth) reads the constants. A malformed value throws at module load (`Invalid GROK_CLI_VERSION=...`), which is the same
fail-fast behaviour as `CODEX_CLI_VERSION`. The browser bundle sees only the default, because `process.env` is not
inlined; that is the same as the Codex and Claude pins. The dashboard reads the live value from `GET /api/settings`.

The value is shown as a read-only client pin, the same way `CODEX_CLI_VERSION` is.

## Tasks (two parallel batches, disjoint files)

### A: runtime and tests

1. `open-sse/config/grokCli.js`: add the `envString` override, default `1.0.44`.
2. `open-sse/providers/registry/grok-cli.js`: update the header comment ("fingerprint from official @xai-official/grok
   wire capture; version from GROK_CLI_VERSION"). No other change.
3. `src/lib/oauth/providers/grok-cli.js`: use `GROK_CLI_USER_AGENT` for the UA on the device code, token poll and
   postExchange calls. Add `x-grok-client-version: GROK_CLI_VERSION` to all three. postExchange keeps `x-xai-token-auth`.
4. `src/app/api/providers/[id]/test/testUtils.js`: drop the dead `0.2.93` fallback and spread `PROVIDERS["grok-cli"].headers`.
5. Tests:
   - new `tests/unit/grok-cli-version.test.js`, modelled on `codex-cli-version.test.js`. The override has to reach the
     registry headers, `clientVersion`, the UA and the OAuth device-code request headers. A malformed value has to throw.
   - `grok-cli-executor.test.js`, `grok-cli-usage.test.js` and `grok-cli-models.test.js`: assert against the
     `GROK_CLI_VERSION` constant instead of the `"0.2.99"` literal.
   - `tests/__baseline__/providers-baseline.json`: hand-edit the grok-cli `clientVersion`, UA and version header to
     `1.0.44`. Don't regenerate the file, because the snapshot has unrelated drift.

### B: settings pin and docs

1. `src/app/api/settings/route.js`: GET response gets `GROK_CLI_VERSION` (dynamic import from `open-sse/config/grokCli.js`).
2. `src/app/api/settings/validateSectionSettings.js` `READ_ONLY_KEYS` and `src/lib/settingsConfigDoc.js`
   `READ_ONLY_SETTING_KEYS`: add `GROK_CLI_VERSION`.
3. `ProvidersModelsSection.js` `CLIENT_PINS`: add `{ key: "GROK_CLI_VERSION", label: "Grok CLI" }`. The grid becomes
   `sm:grid-cols-2 lg:grid-cols-4`.
4. `tests/unit/settings-sections-validation.test.js`: add `expect400({ GROK_CLI_VERSION: "1.0.0" })`.
5. Docs:
   - `.env.example`: a block after Codex.
   - `README.md`: a Grok CLI version paragraph and table after Codex.
   - `compose.yml` and `compose.dev.yml`: add `GROK_CLI_VERSION: 1.0.44` after `CODEX_CLI_VERSION`.
   - CHANGELOG.md stays untouched; release PRs own it.

## Validation

- `npm run lint`
- `rg -n "0\.2\.9[39]" src open-sse tests` → no hits
- `cd tests && npx vitest run unit/grok-cli-*.test.js unit/codex-cli-version.test.js unit/settings-sections-validation.test.js unit/settings-config-doc.test.js`
- `node tests/__baseline__/verify-providers.mjs`
- full `npm test` (regression gate) + `npm run build`
- Live check: run tokenhop's own OAuth device flow (the user finishes the browser step), then a `/v1/responses` chat
  call through `GrokCliExecutor`. There should be no 426.

## Acceptance

Matches YAN-610, except that CHANGELOG is left to the release PR.
