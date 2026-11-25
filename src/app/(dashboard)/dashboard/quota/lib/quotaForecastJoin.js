// Joins server quota forecasts (YAN-401) and persisted 7d history (YAN-422)
// onto parsed quota rows.

/**
 * Attach server `forecasts` (keyed by raw quota key) to parsed rows.
 * Rows join via `quotaType ?? modelKey ?? name`; unlimited/credit rows
 * are skipped (they never run out). Non-object `forecasts` is ignored.
 *
 * @param {Array<object>} rows Parsed quota rows.
 * @param {Record<string, object>|null|undefined} forecasts Forecast map.
 * @returns {Array<object>} Rows with `forecast` attached.
 */
export function attachForecasts(rows, forecasts) {
  if (!Array.isArray(rows)) return [];
  const map =
    forecasts && typeof forecasts === "object" && !Array.isArray(forecasts) ? forecasts : null;
  return rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    if (row.unlimited === true || row.isCreditBalance === true) return { ...row, forecast: null };
    const key = row.quotaType ?? row.modelKey ?? row.name;
    const forecast = map && typeof key === "string" && key ? (map[key] ?? null) : null;
    return { ...row, forecast };
  });
}

function resolveGroupedHistory(map, modelKey) {
  if (modelKey !== "gemini" && modelKey !== "claude") return null;
  const candidates = Object.entries(map).filter(([k, pts]) => {
    if (!Array.isArray(pts) || pts.length < 2) return false;
    const lower = k.toLowerCase();
    if (modelKey === "gemini") return lower.startsWith("gemini-") && !lower.includes("image");
    return lower.startsWith("claude-");
  });
  if (candidates.length === 0) return null;
  // Pick the series with the highest latest usedPct (mirrors parseQuotaData representative).
  let best = candidates[0][1];
  let bestUsed = best[best.length - 1]?.usedPct ?? -1;
  for (let i = 1; i < candidates.length; i++) {
    const pts = candidates[i][1];
    const used = pts[pts.length - 1]?.usedPct ?? -1;
    if (used > bestUsed) {
      best = pts;
      bestUsed = used;
    }
  }
  return best;
}

/**
 * Attach persisted 7d quota history series (`{ ts, usedPct }[]`) to parsed rows.
 * Matches by `quotaType ?? modelKey ?? name`, with grouped Antigravity fallback
 * for `gemini`/`claude` rows. Unlimited/credit rows get `history: null`.
 *
 * @param {Array<object>} rows Parsed quota rows.
 * @param {Record<string, Array<{ ts: number, usedPct: number }>>|null|undefined} history
 * @returns {Array<object>} Rows with `history` attached.
 */
export function attachQuotaHistory(rows, history) {
  if (!Array.isArray(rows)) return [];
  const map = history && typeof history === "object" && !Array.isArray(history) ? history : null;
  return rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    if (row.unlimited === true || row.isCreditBalance === true) return { ...row, history: null };
    const key = row.quotaType ?? row.modelKey ?? row.name;
    let series = null;
    if (map && typeof key === "string" && key) {
      if (Array.isArray(map[key])) series = map[key];
      else if (Array.isArray(map[`model:${key}`])) series = map[`model:${key}`];
      else if (row.modelKey) series = resolveGroupedHistory(map, row.modelKey);
    }
    return { ...row, history: series };
  });
}
