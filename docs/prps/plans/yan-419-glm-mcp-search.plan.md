# YAN-419: GLM Coding (Z.ai) web search over MCP Streamable HTTP

GitHub: tokenhop/tokenhop#342 · Linear: YAN-419 · Target: v0.5.x patch (PR into `master`, then `backport:0.5` to
`release/0.5`). Every touched file is identical on `release/0.5`, so the cherry-pick applies cleanly.

## Problem

`buildGlmSearchRequest` sends one plain JSON-RPC `tools/call` to `https://api.z.ai/api/mcp/web_search_prime/mcp`, a
Streamable HTTP MCP server. Behaviour confirmed with a live GLM Coding key (2026-10-01):

| Request                                          | Response                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| No `Accept: application/json, text/event-stream` | HTTP 400, JSON body of Java stack frames                                                            |
| `initialize`, valid key                          | 200 SSE, `mcp-session-id` response header                                                           |
| `initialize` / any call, bad or missing key      | **200** `application/json` `{"code":401\|1001,"msg":"…","success":false}`                           |
| `notifications/initialized`                      | 202, empty                                                                                          |
| `tools/call` without a session                   | 200 SSE, `result.isError: true`, text `MCP error -401: Api key not found…`                          |
| `tools/call` with session                        | 200 SSE `id:1\nevent:message\ndata:{jsonrpc…}`; `content[0].text` is a JSON string of a JSON string |
| `DELETE` session                                 | error with stack frames, so sessions are not deleted, only cached                                   |

Tool args: `search_query`, `search_domain_filter`, `search_recency_filter`, `content_size`, `location` (`cn`/`us`,
default `cn`). No `count`.

## Design

- New `open-sse/handlers/search/glmMcp.js` exporting `runGlmMcpSearch(url, init, { signal })`. `buildGlmSearchRequest`
  keeps building `{url, init}` (SSRF check via `resolveBaseUrl`, auth header, `tools/call` body) and now adds the MCP
  `Accept` header, sends `location` (`cn` only when `params.country` is `cn`, else `us`) and drops `count`. The runner:
  1. Reuses an in-memory session id keyed by URL + `Authorization` (TTL 10 min), else runs `initialize` →
     `notifications/initialized` and caches the `mcp-session-id`.
  2. POSTs `init.body` with `Mcp-Session-Id`.
  3. Parses the body as SSE (`data:` lines of the JSON-RPC message) or plain JSON.
  4. Throws an error carrying `status` for: non-2xx HTTP (message from `message`/`msg`/`error.message`, never stack
     frames), the `{success:false}` auth envelope (401 for code 401/1001), JSON-RPC `error`, and `result.isError`
     (401 when the text mentions `-401`, else 502).
  5. On any failure, drops the cache entry. If the session was reused and upstream answered (the error has a
     `status`; aborts and network errors don't), re-initializes once and retries.
- `index.js` `tryDedicatedProvider`: a `RUNNERS` map (`glm: runGlmMcpSearch`). When present, the runner replaces the
  `fetchPublic` + `resp.json()` step; same timeout/abort signal. The catch block uses `err.status` when set, and its
  message becomes `${id} returned ${status}: ${message}`.
- `normalizers.js` `normalizeGlmSearch`: parse `content[0].text` while it is still a string (max 2 passes).

Out of scope: `search_recency_filter`/`search_domain_filter` mapping; `link` often being only the site origin
(upstream limitation).

## Tasks

1. `open-sse/handlers/search/glmMcp.js` (new): runner, SSE/JSON body parse, error summarizer, session cache.
2. `open-sse/handlers/search/callers.js`: update `buildGlmSearchRequest` (Accept, `location`, no `count`, doc comment).
3. `open-sse/handlers/search/index.js`: `RUNNERS` hook + `err.status` in catch.
4. `open-sse/handlers/search/normalizers.js`: double-decode.
5. Test `tests/unit/glm-mcp-search.test.js` (stubbed `fetch`, via `handleSearchCore`):
   - handshake order and headers, SSE parse, double-encoded text, `location: "us"`, no `count`, normalized results;
     a second search reuses the session (one fetch).
   - cached session answered with `isError -401` → re-initialize and retry succeeds.
   - auth envelope at `initialize` → 401 with the upstream `msg`; HTTP 400 stack-frame body → no `stackTrace` in error.

## Validation

- `npm run lint`
- `cd tests && npx vitest run unit/glm-mcp-search.test.js unit/search-ssrf-guard.test.js unit/xquik-search-provider.test.js`
- Live: `handleSearchCore` with a real GLM Coding key returns results; bad key returns 401 with the upstream message.
- `npm test` (known-fails gate), `npm run build` (CI)
