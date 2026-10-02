# Plan: grok-cli agent id header + atomic duplicate API-key name guard

Linear: YAN-26, YAN-273 · GitHub: #491, #492 · Target: `v0.6.x` (trunk, then `backport:0.6`)

## Research summary

- **YAN-26** — `GrokCliExecutor.execute()` derives a machine id into `_agentId`, then
  `BaseExecutor.execute` calls `transformRequest`, which overwrites `_agentId` with
  `deviceId || agentId || null`. `buildHeaders` sees `null` and drops
  `x-grok-agent-id` for every connection without `deviceId`/`agentId`. The executor is a
  process-wide singleton, so simply falling back to the previous `_agentId` would leak
  one connection's `deviceId` into another's requests.
- **YAN-273** — `POST /api/providers` checks for a duplicate apikey name with an
  `await getProviderConnections()` before `createProviderConnection()`. Two concurrent
  POSTs interleave at that `await`; the repo's name-based apikey upsert then replaces the
  first key. The repo's `db.transaction` body is synchronous on every adapter, so a check
  inside it is atomic within the process.
- `release/0.6` has identical copies of all touched files: the backport cherry-picks clean.

## Design

1. `grok-cli.js`: cache the machine-derived id once in `_machineAgentId` (lazy, in
   `execute`); `transformRequest` sets `_agentId = deviceId || agentId || _machineAgentId`.
2. `connectionsRepo.js`: `createProviderConnection(data, { rejectDuplicateName })` throws
   an error with `code: "DUPLICATE_CONNECTION_NAME"` instead of upserting when an apikey row
   with the same name exists. Other callers (OAuth/import flows) keep the upsert.
3. `api/providers/route.js`: drop the read-then-write pre-check, pass
   `rejectDuplicateName: true` for apikey creates, map the error code to 409.

## Tasks

| #   | File                                                 | Change                                       |
| --- | ---------------------------------------------------- | -------------------------------------------- |
| 1   | `open-sse/executors/grok-cli.js`                     | cached machine agent id, no `null` overwrite |
| 2   | `src/lib/db/repos/connectionsRepo.js`                | `rejectDuplicateName` option                 |
| 3   | `src/app/api/providers/route.js`                     | atomic guard, 409 mapping                    |
| 4   | `tests/unit/grok-cli-executor.test.js`               | header sent without deviceId; no leak        |
| 5   | `tests/unit/compatible-provider-connections.test.js` | parallel same-name POSTs → one 201, one 409  |

## Validation

`npm run lint`, targeted vitest files, then `npm test` (touches gateway and dashboard API).
