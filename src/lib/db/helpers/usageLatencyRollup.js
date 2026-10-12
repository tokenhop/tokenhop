// YAN-771: edit-prediction latency folded into usageRollup. Histogram v1 is a
// stored contract (migration 017, snapshots): bin i = (BOUNDS[i-1], BOUNDS[i]],
// the last bin also takes overflow. Exact: sum/count/empty. Coarse: p50.
// ponytail: p50 is a histogram estimate; add finer/versioned bins if needed.
export const LATENCY_ENDPOINT = "completions"; // YAN-736 edit predictions
export const LATENCY_BOUNDS = [
  0, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 60000, 120000,
];
export const LATENCY_COLUMNS = [
  "latencySumMs",
  "latencyCount",
  "emptyCount",
  "latencyRequests",
  "latencyHistogram",
];
export const EMPTY_HISTOGRAM = JSON.stringify(LATENCY_BOUNDS.map(() => 0));
export const LATENCY_DEFAULTS = {
  latencySumMs: 0,
  latencyCount: 0,
  emptyCount: 0,
  latencyRequests: 0,
  latencyHistogram: EMPTY_HISTOGRAM,
};

// Upsert merge (inside the writer's txn). Bins are only touched by rows that
// carry samples, so non-completions requests pay no JSON work.
export const LATENCY_MERGE_SQL = LATENCY_COLUMNS.map((col) =>
  col === "latencyHistogram"
    ? `${col} = CASE WHEN excluded.latencyRequests = 0 THEN ${col} ELSE json_array(${LATENCY_BOUNDS.map((_, i) => `json_extract(${col}, '$[${i}]') + json_extract(excluded.${col}, '$[${i}]')`).join(", ")}) END`
    : `${col} = ${col} + excluded.${col}`,
).join(", ");

export const latencyBin = (ms) => {
  const i = LATENCY_BOUNDS.findIndex((bound) => ms <= bound);
  return i === -1 ? LATENCY_BOUNDS.length - 1 : i;
};

/** One request, matching YAN-743 json_extract + Number / Boolean coercion. */
export function latencyDeltas(endpoint, meta) {
  if (endpoint !== LATENCY_ENDPOINT) return LATENCY_DEFAULTS;
  const raw = meta?.latencyMs;
  const ms = Number(raw && typeof raw === "object" ? JSON.stringify(raw) : raw);
  const valid = raw != null && Number.isFinite(ms);
  const bins = LATENCY_BOUNDS.map(() => 0);
  if (valid) bins[latencyBin(ms)] = 1;
  return {
    latencySumMs: valid ? ms : 0,
    latencyCount: valid ? 1 : 0,
    emptyCount: meta?.empty ? 1 : 0,
    latencyRequests: 1,
    latencyHistogram: JSON.stringify(bins),
  };
}

/** Avg / p50 / empty rate / samples over rollup rows (same shape as the history path). */
export function rollupLatencySummary(rows) {
  let sum = 0;
  let count = 0;
  let empty = 0;
  let samples = 0;
  const bins = LATENCY_BOUNDS.map(() => 0);
  for (const row of rows) {
    sum += row.latencySumMs;
    count += row.latencyCount;
    empty += row.emptyCount;
    samples += row.latencyRequests;
    // Corrupt stored histogram: keep this row's counts/avg, drop its bins (p50 may be null).
    let rowBins = null;
    try {
      rowBins = JSON.parse(row.latencyHistogram);
    } catch {}
    if (
      !Array.isArray(rowBins) ||
      rowBins.length !== bins.length ||
      !rowBins.every((n) => Number.isInteger(n) && n >= 0)
    )
      continue;
    for (let i = 0; i < bins.length; i++) bins[i] += rowBins[i];
  }
  let p50 = null;
  const half = count / 2;
  let seen = 0;
  for (let i = 0; i < bins.length && count; i++) {
    if (bins[i] && seen + bins[i] >= half) {
      const lo = i ? LATENCY_BOUNDS[i - 1] : 0;
      p50 = Math.round(lo + ((half - seen) / bins[i]) * (LATENCY_BOUNDS[i] - lo));
      break;
    }
    seen += bins[i];
  }
  return {
    latencyAvgMs: count ? Math.round(sum / count) : null,
    latencyP50Ms: p50,
    emptyRate: samples ? empty / samples : null,
    samples,
  };
}

/** Snapshot-row check of the latency columns (all optional: older snapshots lack them). */
export function validateLatencyColumns(row, fail) {
  const bad = (what) => fail("TRANSFER_STATE_INVALID", `usageRollup ${what}`);
  for (const f of ["latencyCount", "emptyCount", "latencyRequests"]) {
    if (row[f] !== undefined && !(Number.isInteger(row[f]) && row[f] >= 0)) {
      bad(`${f} must be a non-negative integer`);
    }
  }
  if (row.latencySumMs !== undefined && !Number.isFinite(row.latencySumMs)) {
    bad("latencySumMs must be a finite number");
  }
  const count = row.latencyCount ?? 0;
  if ((row.emptyCount ?? 0) > (row.latencyRequests ?? 0)) bad("emptyCount exceeds latencyRequests");
  if (row.latencyHistogram === undefined) {
    if (count > 0) bad("latencyHistogram is required when latencyCount > 0");
    return;
  }
  let bins = null;
  try {
    bins = JSON.parse(row.latencyHistogram);
  } catch {}
  if (
    !Array.isArray(bins) ||
    bins.length !== LATENCY_BOUNDS.length ||
    !bins.every((n) => Number.isInteger(n) && n >= 0)
  ) {
    bad("latencyHistogram must be a JSON array of non-negative integers");
  }
  const n = bins.reduce((a, b) => a + b, 0);
  if (n !== count || count > (row.latencyRequests ?? 0)) {
    bad("latency columns are inconsistent");
  }
}
