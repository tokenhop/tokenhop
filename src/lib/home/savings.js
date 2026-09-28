export const VALID_PERIODS = ["today", "7d", "30d"];

const PERIOD_DURATIONS = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Return [startMs, endMs] for a period, plus previous period range for delta math.
 */
export function resolvePeriodRange(period, now = Date.now()) {
  if (!VALID_PERIODS.includes(period)) {
    throw new Error(`Invalid period: ${period}. Expected one of: ${VALID_PERIODS.join(", ")}`);
  }

  const endMs = now;
  let startMs;
  let prevStartMs;
  let prevEndMs;

  if (period === "today") {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    startMs = startOfToday.getTime();
    const elapsedToday = endMs - startMs;
    prevStartMs = startMs - 24 * 60 * 60 * 1000;
    // Compare against identical time slice of yesterday
    prevEndMs = prevStartMs + elapsedToday;
  } else {
    const duration = PERIOD_DURATIONS[period];
    startMs = endMs - duration;
    prevEndMs = startMs;
    prevStartMs = startMs - duration;
  }

  return { startMs, endMs, prevStartMs, prevEndMs };
}

/**
 * Build per-request savings payload to record in usageHistory meta.
 * Estimated tokens only from measurable savers:
 * - RTK: bytes saved / 4
 * - Headroom: proxy tokens_saved if !isHeadroomPhantomSavings
 * - PXPIPE: estimated tokens from transform
 * Prompt-only techniques (Caveman, Ponytail) have no measurable baseline delta.
 */
export { buildSavingsEntry } from "../../../open-sse/rtk/savingsEstimate.js";

/**
 * Savings aggregation over recorded usageHistory rows: the request's own
 * `meta.savings` payload is the store (no double count with the PXPIPE JSONL
 * event log — events.jsonl is an append-only debug log, not a store of
 * record). Pure over items with `timestamp` + `savings`, so unit-testable
 * without a DB.
 */
export function aggregateSavings(items, period = "7d", now = Date.now()) {
  const { startMs, endMs } = resolvePeriodRange(period, now);

  const byMethod = {
    rtk: { tokensSavedEst: 0, tokensBeforeEst: 0, count: 0 },
    headroom: { tokensSavedEst: 0, tokensBeforeEst: 0, count: 0 },
    pxpipe: { tokensSavedEst: 0, tokensBeforeEst: 0, count: 0 },
  };

  let tokensSavedEst = 0;
  let tokensBeforeEst = 0;
  let requestsWithSavings = 0;

  for (const item of items || []) {
    if (!item?.timestamp) continue;
    const t = new Date(item.timestamp).getTime();
    if (Number.isNaN(t) || t < startMs || t > endMs) continue;

    const savings = item.savings;
    if (!savings || typeof savings !== "object") continue;

    let savedInItem = 0;
    if (savings.byMethod) {
      for (const [method, m] of Object.entries(savings.byMethod)) {
        if (!byMethod[method]) {
          byMethod[method] = { tokensSavedEst: 0, tokensBeforeEst: 0, count: 0 };
        }
        const s = Number(m?.tokensSavedEst) || 0;
        const b = Number(m?.tokensBeforeEst) || 0;
        byMethod[method].tokensSavedEst += s;
        byMethod[method].tokensBeforeEst += b;
        if (s > 0) byMethod[method].count += 1;
        savedInItem += s;
      }
    }

    const itemTotalSaved = Number(savings.tokensSavedEst) || savedInItem;
    const itemTotalBefore = Number(savings.tokensBeforeEst) || 0;

    if (itemTotalSaved > 0) {
      tokensSavedEst += itemTotalSaved;
      tokensBeforeEst += itemTotalBefore;
      requestsWithSavings += 1;
    }
  }

  const methods = Object.keys(byMethod).filter((k) => byMethod[k].tokensSavedEst > 0);
  const percentage =
    tokensBeforeEst > 0 ? +((tokensSavedEst / tokensBeforeEst) * 100).toFixed(2) : 0;

  return {
    period,
    tokensSavedEst,
    tokensBeforeEst,
    percentage,
    requestsWithSavings,
    byMethod,
    methods,
  };
}
