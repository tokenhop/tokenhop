// Joins server quota forecasts (YAN-401) onto parsed quota rows.

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
