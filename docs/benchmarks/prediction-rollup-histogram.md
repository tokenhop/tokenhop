# Prediction histogram write cost — YAN-1063 / GH #888

Measured 2026-10-12 against `origin/master` a887e04a (v1.1.0 work).
**Keep current writer; no follow-up needed under preset local threshold.**

## Method and threshold (fixed before measuring)

`scripts/bench-prediction-rollup.mjs` imports current schema, adapters,
`latencyDeltas` and `upsertRollupRowUnscoped`. Each transaction includes current
history INSERT, stored-identity SELECT and rollup upsert. History SQL is copied
from `usageRepo.js` (aliases prevent standalone import), with source-text drift
assertions. Baseline uses identical SQL/parameters minus only histogram UPDATE
merge; INSERT still stores first histogram. Baseline intentionally retains
first-insert bins and is **not a valid replacement**.

Material means median paired histogram-minus-baseline overhead **>=20% AND

> =0.1 ms**, on p50 **or** p95. Local diagnostic, not universal SLA. p99 reported
> but not decision gate. Delta statistics are medians of per-rep paired differences
> and percentages, not subtraction of arm medians.

Fresh file-backed temporary DB per arm; current `TABLES` users/workspaces,
history with all eight indexes and rollup with workspace/date index. 20,000
seed history rows, 1,000 warmup transactions, 10,000 measured transactions,
four reps/arm/scenario. Alternating arm order H/B, B/H, H/B, B/H. Identical seeded
payloads per pair. Two invocations/driver;
128 arm runs and 1.28 million measured transactions total.

- `hot`: one dimension tuple; `varied`: 512 tuples across 8 workspaces, 16 users,
  32 keys, 8 models, 24 connections (including ownerless/keyless dimensions).
- Prediction-only plus `*-mixed`: 30% prediction, 70% non-prediction chat.
  Mixed pools produce 2 hot or 1023–1024 varied rollup rows.
- Synthetic latencies sample all bin boundaries, overflow, zero, invalid/missing
  values; 10% empty flag. Not a measured production latency distribution.
- Every arm checks history row count, exact counters and all 12 histogram bins
  per dimension against payload oracle, distinct-key isolation, bin sum/count,
  baseline first-insert-only bins. Helper fixture asserts boundaries/overflow,
  invalid samples and non-prediction gating. All assertions passed.

## Commands and environment

Run from worktree root (dependencies linked from root `node_modules`):

```bash
# Each command run twice, default 20k rows/10k writes/1k warmup/4 reps:
node scripts/bench-prediction-rollup.mjs
/home/yandy/.local/share/mise/installs/node/22/bin/node scripts/bench-prediction-rollup.mjs
# Validation:
node --check scripts/bench-prediction-rollup.mjs
node_modules/.bin/biome check scripts/bench-prediction-rollup.mjs
node_modules/.bin/markdownlint docs/benchmarks/prediction-rollup-histogram.md
node_modules/.bin/prettier --check docs/benchmarks/prediction-rollup-histogram.md
```

Node v26.9.0 / `node:sqlite` (active production default on Node >=24);
Node v22.23.2 / `better-sqlite3` 13.0.3 (pinned `.nvmrc` 22 default).
Both SQLite 3.53.4. Linux 7.0.0-38-generic x64, Intel Xeon E5-2640 v4 @2.40GHz
x40, 248 GiB RAM, ext4 `/dev/sdb` under `/tmp/opencode`.
Pragmas: WAL, synchronous=NORMAL (1), temp_store=MEMORY (2), mmap_size=30000000,
cache_size=-64000, foreign_keys=1, busy_timeout=5000, wal_autocheckpoint=1000.

## Results

All times ms/transaction. B/H = baseline/histogram, arm medians across four
reps. Paired deltas shown separately. Throughput includes timing-loop overhead.

| Driver / invocation | Scenario     | p50 B/H     | p95 B/H     | p99 B/H         | Paired Δp50 ms (%) | Paired Δp95 ms (%) | txn/s B/H |
| ------------------- | ------------ | ----------- | ----------- | --------------- | ------------------ | ------------------ | --------- |
| node / 1            | hot          | .2143/.2401 | .3221/.3578 | 13.6909/13.7051 | .0243 (11.5)       | .0350 (10.9)       | 2358/2226 |
| node / 2            | hot          | .2079/.2419 | .3301/.3901 | 13.6371/13.7520 | .0367 (17.9)       | .0505 (14.9)       | 2373/2175 |
| node / 1            | varied       | .2129/.2404 | .3287/.3855 | 16.9539/17.0346 | .0229 (10.8)       | .0558 (17.0)       | 2130/2004 |
| node / 2            | varied       | .2207/.2491 | .3393/.3852 | 17.2674/17.2574 | .0284 (12.9)       | .0406 (11.8)       | 2076/1956 |
| node / 1            | hot-mixed    | .2104/.2166 | .3175/.3348 | 13.7539/13.6269 | .0022 (1.0)        | .0155 (4.9)        | 2374/2365 |
| node / 2            | hot-mixed    | .2131/.2206 | .3300/.3477 | 13.8160/13.7356 | .0068 (3.2)        | .0149 (4.5)        | 2348/2319 |
| node / 1            | varied-mixed | .2078/.2268 | .3311/.3587 | 17.3131/17.4445 | .0184 (9.0)        | .0182 (5.4)        | 2140/2049 |
| node / 2            | varied-mixed | .2037/.2232 | .3200/.3394 | 17.3798/17.3121 | .0167 (8.0)        | .0191 (6.0)        | 2156/2076 |
| better / 1          | hot          | .1849/.2033 | .3223/.3515 | 13.2857/13.3235 | .0185 (10.1)       | .0389 (12.1)       | 2509/2395 |
| better / 2          | hot          | .1790/.2004 | .3016/.3494 | 13.2254/13.2758 | .0285 (15.8)       | .0511 (17.9)       | 2573/2379 |
| better / 1          | varied       | .1692/.1826 | .2997/.3313 | 16.1191/16.1944 | .0190 (11.6)       | .0504 (16.7)       | 2388/2294 |
| better / 2          | varied       | .1678/.1782 | .3095/.3288 | 16.1733/16.0389 | .0112 (6.7)        | .0112 (3.6)        | 2374/2331 |
| better / 1          | hot-mixed    | .1904/.1888 | .3086/.3235 | 13.3501/13.2750 | .0046 (2.8)        | .0159 (4.7)        | 2511/2496 |
| better / 2          | hot-mixed    | .1805/.1919 | .3137/.3360 | 13.2467/13.4159 | .0077 (4.4)        | .0180 (5.7)        | 2549/2474 |
| better / 1          | varied-mixed | .1685/.1711 | .3184/.3144 | 16.4000/16.3852 | .0027 (1.6)        | -.0049 (-1.5)      | 2338/2353 |
| better / 2          | varied-mixed | .1649/.1663 | .3034/.3149 | 16.4189/16.3195 | .0038 (2.3)        | .0103 (3.4)        | 2372/2361 |

Prediction-only p50 histogram slower in 4/4 paired reps in every invocation;
p95 slower in 4/4 except better varied invocation 2 (3/4). Cost measurable, but
max paired p50 .0367 ms (17.9%), max paired p95 .0558 ms (17.0%): the 0.1 ms bar is never met.
All four invocations return NOT material. Keep current writer. If future target
hardware crosses both bars repeatedly, file separate writer optimization issue.

## Validation and limits

Syntax/Biome/Markdownlint/Prettier passed. Smoke run and sustained correctness
runs passed. Invalid positional/unknown option, nonnumeric/negative rows,
odd/out-of-range repetitions, invalid driver all exit 2 before DB creation.
No temp DB directories remained after runs. No HOME/DATA_DIR lookup or production
writer import. Full tests/build skipped: scripts/docs only; parent owns app gates.

Single sequential writer, no concurrent readers/load; host not dedicated.
p99 large and noisy (~13–17 ms), consistent with checkpoint/fsync stalls but
not traced. Baseline retains shorter bins, so row-size effects not isolated from
JSON computation. JS payload construction outside timed loop in both arms;
`latencyDeltas` construction overhead excluded. History pre-seeded without
matching historical rollup; active pool populated during warmup.
Omitted: lifetime/savings counters, key identity/pricing, emit/ring push and grant
budget work. Percentages are for history+rollup only, not full request path.
Untested fallback drivers: `bun:sqlite` and `sql.js`. Existing stale in-memory
`bench-usage-rollup.mjs` left untouched. Results doc ignored by repo `docs/*` rule;
parent must force-add this file when staging. No production edits/commit/push.
