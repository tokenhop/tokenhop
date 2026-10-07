# YAN-370 research: usage recording sites and principal context

Read-only map. Paths are relative to the worktree root.

## 0. Sink: `saveRequestUsage(entry)`, `src/lib/db/repos/usageRepo.js:418`

- Re-exported through `src/lib/db/index.js:187` and `@/lib/usageDb.js`.
- Accepted fields: `provider, model, tokens, timestamp, connectionId, apiKey (raw, legacy), apiKeyId, workspaceId, userId, endpoint, status, savings, comboName, userAgent, meta`.
- Cost: `entry.cost = await calculateCost(provider, model, tokens)` (:423). The cost function is described in §6.
- Identity: `resolveUsageKeyIdentity(db, {apiKey, apiKeyId})` (:378). In legacy mode it returns the raw key. In hashed mode it returns the key id or a `historical:` pseudonym. It **fails closed** (throws) when the raw key and `apiKeyId` don't match, or when schema state is invalid (:511-516).
- Writes run in one transaction (:448-507):
  - `usageHistory` INSERT with columns `timestamp, provider, model, connectionId, apiKey(=identity), endpoint, promptTokens, completionTokens, cost, status, tokens(json), meta(json)`.
  - **`workspaceId`/`userId` only go into `meta` JSON** (:436-438). They have no columns. Schema is in `migrations/001-initial.js:24`; no later ALTER adds columns.
  - `usageDaily` upsert via `aggregateEntryToDay` (:154). Buckets are `byProvider/byModel/byAccount/byApiKey/byEndpoint`. **There is no byWorkspace or byUser bucket.** `byApiKey` key = `${apiKey|"local-no-key"}|model|provider`.
  - `_meta.totalRequestsLifetime` counter and the savings lifetime counter.
- After the commit: `pushToRing(entry)` (:509) and `scheduleStatsEvent("update",250)` (:510).
- Units: tokens only. No field exists for characters, seconds, images, queries, or fetches. `aggregateEntryToDay` counts `requests += 1` per row, so a 0-token row still counts as a request.

## 1. Call sites of usage recording

### A. Chat, through `saveUsageStats(...)` in `open-sse/handlers/chatCore/requestDetail.js:132`

- Signature: `{provider, model, tokens, connectionId, apiKey, keyContext, endpoint, userAgent, savings, comboName, label, silent}`.
- It returns early when tokens are missing, when in and out are both 0 (:151), or when `endpoint === COMBO_PROBE_ENDPOINT` (:156).
- It canonicalizes tokens with `canonicalizeUsage`, then calls `saveRequestUsage({... apiKey, ...keyContext, endpoint, userAgent, savings, comboName})` (:178).
- It is fire-and-forget (`.catch(() => {})`), so a fail-closed identity error is swallowed here.

Callers (every one passes the same field set, with `endpoint: clientRawRequest?.endpoint` and `userAgent` from headers):

| Call site                                               | Path                               |
| ------------------------------------------------------- | ---------------------------------- |
| `open-sse/handlers/chatCore/nonStreamingHandler.js:337` | non-streaming JSON                 |
| `open-sse/handlers/chatCore/sseToJsonHandler.js:189`    | Responses SSE to JSON              |
| `open-sse/handlers/chatCore/sseToJsonHandler.js:361`    | generic SSE to JSON                |
| `open-sse/handlers/chatCore/streamingHandler.js:319`    | streaming (`label:"STREAM USAGE"`) |

### B. Embeddings, `src/sse/handlers/embeddings.js:161`

```js
saveRequestUsage({
  provider,
  model,
  connectionId: credentials.connectionId,
  apiKey,
  ...gatewayKeyContext(gateway),
  endpoint: url.pathname,
  tokens: exactEmbeddingUsage(result.usage),
  status: "success",
});
```

- `apiKey` comes from `auth.legacy ? extractApiKey(request) : null` (:60).
- The call only runs when `exactEmbeddingUsage` returns non-null.

There are no other `saveRequestUsage` callers in `src/` or `open-sse/`.

## 2. Handlers that record nothing (no usage, no detail, no pending)

All of these call `resolveGatewayAuth(request)` and hold `gateway = auth.principal`. **None** of them call `gatewayKeyContext`, and none compute a legacy `apiKey`, except search, fetch, and video, which do compute it. To add recording, copy the embeddings pattern: `apiKey = auth.legacy ? extractApiKey(request) : null` plus `...gatewayKeyContext(gateway)`.

### TTS, `src/sse/handlers/tts.js`

- Entry: `handleTts` :27. Per-model function: `handleSingleModelTts(body, modelStr, responseFormat, language, style, gateway)` :106. `url` is set at :35 but not passed down.
- Success points:
  - noAuth branch :128, `if (result.success) return result.response`. No connectionId.
  - Credentialed loop :180, with `credentials.connectionId` available.
- Known values: `provider, model` (model = voice) and `body.input`. Unit: `body.input.length` characters.
- Core: `open-sse/handlers/ttsCore.js:15` `createTtsResponse`. It returns only `{success, response}`; no usage.
- Combos go through `handleComboChat` (:89) with `comboName: comboRotationKey(gateway?.workspaceId, modelStr)`.

### STT, `src/sse/handlers/stt.js`

- Entry: `handleStt` :19. `gateway` at :32. Inputs: `formData` and `file`.
- Success points: noAuth :56 and credentialed :103, both `if (result.success) return result.response`.
- Units: **no audio duration is available**.
  - `sttCore.js:194-210` returns the raw upstream text or JSON. Only the OpenAI `verbose_json` format carries `duration`.
  - Fallbacks are `file.size` bytes, or parsing the response body for `duration`.
- Provider, model, and connectionId are known on the credentialed path.

### Image, `src/sse/handlers/imageGeneration.js`

- Entry: `handleImageGeneration` :25. `url` at :33.
- Success points: noAuth :118 and credentialed :178, `if (result.success) return result.response`.
- Units: requested count is `body.n ?? 1`. The actual count lives in `finalBody.data.length` inside `imageGenerationCore.js:97/257`, but the core returns only `{success, response}`.
  - The binary branches (:84, :244) always return 1 image.
  - The SSE branch (:205) returns `parsed.sseResponse`.
  - To get an exact count, the core must return a `usage`/`count` field.

### Video, `src/sse/handlers/videoGeneration.js`

- Create: `handleVideoCreate(request, action)` :261.
  - Success point :376-389: after `clearAccountError`, `recordVideoJobProvenance(gateway, …, {provider, connectionId, modelId: canonicalModel})`, then `withConnectionHeader`.
  - Known values: `provider, model, canonicalModel, credentials.connectionId, action`.
  - Units: 1 job per create. Seconds may be in `bodyInfo.parsed?.seconds/duration` (JSON bodies only; multipart is raw). This is not parsed today.
- Poll: `handleVideoGet` :417 is a status poll; don't count it.
- Legacy apiKey: `extractApiKey` :68. Auth: `resolveVideoAuth` :84-101.

### Search, `src/sse/handlers/search.js`

- Entry: `handleSearch` :26. `url` at :35. `apiKey` at :47 (legacy).
- Success points: noAuth :178 and credentialed :273.
- Units: `result.data.usage = {queries_used:1, search_cost_usd: providerConfig.costPerQuery ?? null, provider_credits_used?}`, from `open-sse/handlers/search/index.js:157-172`. This is the only modality with a ready cost value.
- Provider is `providerId`/`resolvedProvider.id`. There is no model, except when a combo resolves one.

### Fetch, `src/sse/handlers/fetch.js`

- Entry: `handleFetch` :27. `apiKey` at :50 (legacy).
- Success points: noAuth :184 and credentialed :259-263.
- Units: 1 fetch, `result.data.content.length` characters, and `result.data.usage.fetch_cost_usd` (`fetch/index.js:65-74` `buildData`).
- Provider is `resolvedProvider.id`. There is no model.

## 3. Request principal (YAN-355/363/368)

### Resolver: `resolveGatewayAuth(request)`, `src/lib/auth/gatewayAuth.js:108`

It returns one of:

- `{principal:null, legacy:true}` for legacy storage. The raw key flows as `apiKey`.
- `{principal, legacy:false}` for hashed storage.
- A `Response` (401 or 503) on denial.

### Principal shapes (frozen)

- API key, from `resolveApiKey` in `src/lib/auth/apiKeyPrincipal.js:50`:
  `{workspaceId, userId|null, apiKeyId, scopes:{allowedModels, allowedCombos}, via:"apiKey"}`
- Owner, from `ownerPrincipal` in `gatewayAuth.js:26`:
  `{userId, workspaceId, apiKeyId:null, scopes:{[] , []}, via:"mitm"|"cli"|"local"}`

### Recording projection: `gatewayKeyContext(principal)`, `gatewayAuth.js:221`

- Returns frozen `{apiKeyId, workspaceId, userId}`, or `null` for legacy.
- Spreading `null` is safe: `...null` produces nothing.

### How chat passes it down

1. `src/sse/handlers/chat.js:121` `auth = await resolveGatewayAuth(request)`. :132 sets `gateway = auth.principal`. :133 sets `options.principal`. :134 sets `apiKey = auth.legacy ? extractApiKey(request) : null`.
2. :685 `handleChatCore({..., connectionId: credentials.connectionId, apiKey, ...gatewayKeyContext(gateway), comboName, ...})`.
3. `open-sse/handlers/chatCore.js:94-134` receives `apiKey, apiKeyId, workspaceId, userId`. It builds `keyContext` with only the non-null id fields and threads `keyContext` plus `apiKey` into the stream, non-stream, and sse-to-json handlers and into `buildRequestDetail`.
4. In-process combo probes pass `options.principal` (`chat.js:108-114`; `src/sse/services/comboProbe.js:183`).

Routing services take `{principal}`: `src/sse/services/auth.js:83-133` (`getProviderCredentials`, mutex/pool key `${workspaceId}:${provider}`) and `src/sse/services/model.js:42-72`.

### Grants

**No grant concept exists.** There are no `grantId`, `grants` table, or `connectionGrant` in `src/` or `open-sse/`. "grant" only appears for membership roles and OAuth. Treat `grantId` as null and leave room for it. `credentials` carries `connectionId` and `connectionName`, but no owner or grant id.

## 4. requestDetails (full bodies)

- Writer: `saveRequestDetail(detail)`, `src/lib/db/repos/requestDetailsRepo.js:220`. It is buffered and batched, and does nothing when observability is disabled.
- `writeBatch` (~:167): the row has columns `id, timestamp, provider, model, connectionId, status`. The `data` JSON holds `apiKeyId, workspaceId, userId` (string-or-null validated), `latency, tokens, request, providerRequest, providerResponse, response (truncated), pxpipe`. Header and url values are sanitized.
- Builder: `buildRequestDetail(base, overrides)`, `requestDetail.js:94`. It spreads `base.keyContext`.
- Callers (chat only):

| Call site                    | Case                           |
| ---------------------------- | ------------------------------ |
| `chatCore.js:579`            | executor exception             |
| `chatCore.js:709`            | upstream non-OK                |
| `nonStreamingHandler.js:412` | non-streaming result           |
| `sseToJsonHandler.js:212`    | sse-to-json result             |
| `sseToJsonHandler.js:382`    | sse-to-json result             |
| `streamingHandler.js:228`    | streaming, pending/initial row |
| `streamingHandler.js:291`    | streaming, final update        |

Embeddings and the media endpoints write no detail rows.

## 5. Live feed (in-memory, `usageRepo.js:106-136`)

- `global._pendingRequests = {byModel:{"model (provider)":n}, byAccount:{connectionId:{modelKey:n}}}`.
  - Mutated only by `trackPendingRequest(model, provider, connectionId, started, error)` :255.
  - Callers: `chatCore.js:318,325,478,493,496,571,697,763` and `open-sse/utils/stream.js:506`. **Chat only.**
  - A 60 s safety timer runs per key. On error it sets `global._lastErrorProvider`.
  - **There is no principal dimension.**
- `global._recentRing = {items, initialized}` holds at most 50 entries (`RING_CAP`).
  - `pushToRing(entry)` runs at the end of `saveRequestUsage` with the full entry object. In hashed mode, `apiKey` has already been replaced by the identity, and the ring also keeps `workspaceId`/`userId`.
  - Lazy init from `usageHistory` (`ensureRingInitialized` :214) selects no workspace or user.
- `statsEmitter = global._statsEmitter`. Events are debounced: `"pending"` at 150 ms and `"update"` at 250 ms, and they carry **no payload**.
  - The only consumer is `src/app/api/usage/stream/route.js:65-66`. On each event it builds `buildLivePayload(await getLiveSnapshot())`.
  - `getLiveSnapshot` (:314) returns `{activeRequests:[{provider,count}], lastProvider, errorProvider}`. It is global and unscoped; there is no per-workspace filtering.
- `appendRequestLog()` is a no-op stub (`usageRepo.js:1230`). It is still called with `{...keyContext, model, provider, connectionId, status}`.

## 6. Cost

- `calculateCost(provider, model, tokens)` is private, `usageRepo.js:237`. It calls `pricingRepo.getPricingForModel(provider, model)` and then `calculateCostFromTokens`. It returns 0 when inputs are missing.
- `calculateCostFromTokens(tokens, pricing)`, `open-sse/providers/pricing.js:1182`. Rates are per 1M tokens: `input, output, cached, reasoning, cache_creation`. `prompt_tokens` is cache-inclusive and `completion_tokens` is reasoning-inclusive.
- There is no per-unit pricing (characters, seconds, images, queries). Search and fetch supply their own `*_cost_usd`. Today `saveRequestUsage` always overwrites `entry.cost` (:423), so a supplied cost would be clobbered.

## Gaps for YAN-370 (observations)

1. `usageHistory` has no `workspaceId`/`userId`/`apiKeyId`/`grantId` columns; these live only in `meta` JSON. `usageDaily` has no per-workspace or per-user buckets.
2. TTS, STT, image, video, search, and fetch record nothing and do not pass `gatewayKeyContext`.
3. The sink is token-only: it has no unit fields and cannot pass through a supplied cost.
4. The live snapshot and pending counters are global, with no principal dimension.
5. `saveUsageStats` swallows fail-closed identity errors through `.catch(() => {})`.
