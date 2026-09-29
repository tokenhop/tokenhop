# YAN-407 stream diet measurements

Seed: 60,000 `usageHistory` rows and 121 `usageDaily` rollups, inserted directly via `getAdapter()` into `DATA_DIR=/tmp/opencode/dd-measure` (node:sqlite). Script: `/tmp/opencode/measure-yan407.mjs`. Both paths were warmed once (ring init, connection cache), then averaged over 20 runs. The live snapshot had 12 in-flight model/account pairs.

| Path            | What                                                  | ms / call (avg 20) | Bytes / message |
| --------------- | ----------------------------------------------------- | -----------------: | --------------: |
| Old             | `getUsageStats("all")` then `JSON.stringify`          |              348.7 |           8,849 |
| Old, per update | same object sent twice (quick cache + full recalc)    |              348.7 |          17,698 |
| New             | `getActiveRequests()` + `buildLivePayload`, one frame |               0.83 |             235 |

- **Speed:** the new path is about 420× faster per message.
- **Size:** the new message is about 38× smaller (about 75× per update, because the old route sent the full object twice).
- **2 KB bound:** the payload only carries per-provider counts (capped at 24 providers, ids clipped to 48 chars), so it stays under 2 KB however many requests are in flight. A unit test covers this with 500 oversized entries.
- **Frequency:** the old route sent 3 full messages per gateway request (2 pending, 1 update). The new route sends 3 slim messages, and none while the tab is hidden or on the Request log tab.
