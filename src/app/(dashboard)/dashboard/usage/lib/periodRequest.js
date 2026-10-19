// Period query/key helpers shared by the Usage page's stats and chart fetches
// (YAN-426). A custom range adds `from`/`to` to the request and to the cache
// key, so switching between two custom ranges never shows the old range's data.

import { isCustomPeriod } from "@/shared/utils/period";

/**
 * Query string for a usage endpoint: `period=…`, plus `from`/`to` when the
 * period is a custom range.
 * @param {string} period named period or "custom"
 * @param {{from: string, to: string}|null} [range] inclusive day keys for "custom"
 * @returns {string}
 */
export function periodQuery(period, range = null) {
  const params = new URLSearchParams({ period });
  if (isCustomPeriod(period) && range) {
    params.set("from", range.from);
    params.set("to", range.to);
  }
  return params.toString();
}

/**
 * Identity of the data window: the period itself, or `custom:from:to`. Null
 * while the period is unresolved. Compare this (not the bare period) to tell
 * whether fetched data belongs to the current selection.
 * @param {string|null} period
 * @param {{from: string, to: string}|null} [range]
 * @returns {string|null}
 */
export function periodKey(period, range = null) {
  if (!period) return null;
  return isCustomPeriod(period) && range ? `${period}:${range.from}:${range.to}` : period;
}

/**
 * Parse a usage response. A 4xx carries a human `error` message (e.g. the
 * typed 400 for an invalid custom range), so it surfaces as the Error message;
 * 5xx and unreadable bodies keep the terse `<label> <status>` form.
 * @param {Response} response
 * @param {string} label short request name used in the fallback message
 * @returns {Promise<any>}
 */
export async function readUsageJson(response, label) {
  if (response.ok) return response.json();
  let message = "";
  if (response.status >= 400 && response.status < 500) {
    try {
      const body = await response.json();
      if (typeof body?.error === "string") message = body.error;
    } catch {
      // Non-JSON error body: fall back to the status message.
    }
  }
  throw new Error(message || `${label} ${response.status}`);
}
