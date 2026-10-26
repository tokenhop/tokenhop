// Serialization for usage export (YAN-425 / GitHub #1018). Pure helpers so
// the CSV writer's escaping and formula-injection rules are unit-testable
// without a database or an HTTP request.

import { localDateKey } from "@/lib/db/repos/usageRollupRepo.js";

/** Request-level export columns, in file order. `api_key` is the key's display
 * name and `api_key_masked` its masked prefix — never a raw key. */
export const REQUEST_COLUMNS = [
  "timestamp",
  "provider",
  "model",
  "account",
  "account_id",
  "api_key",
  "api_key_masked",
  "endpoint",
  "prompt_tokens",
  "completion_tokens",
  "cached_tokens",
  "cost",
  "status",
  "saved_tokens_est",
];

/** Daily export columns: the rollup's day grain, no per-request status. */
export const DAILY_COLUMNS = [
  "date",
  "provider",
  "model",
  "account",
  "account_id",
  "api_key",
  "api_key_masked",
  "endpoint",
  "requests",
  "prompt_tokens",
  "completion_tokens",
  "cached_tokens",
  "cost",
  "saved_tokens_est",
];

// Spreadsheet formula injection: a string cell starting with one of these is
// executed as a formula by Excel/Sheets on open. A leading single quote makes
// it inert text. Numbers are handled before this check, so a plain negative
// number (-5) stays numeric; only string cells are neutralized.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * One CSV cell (RFC 4180): quote when the value contains a comma, quote, CR
 * or LF, doubling inner quotes; neutralize formula-leading string cells.
 * @param {unknown} value
 * @returns {string}
 */
export function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  let text = String(value);
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  if (NEEDS_QUOTING.test(text)) text = `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** One CRLF-terminated CSV record from raw values. */
export function csvRow(values) {
  return `${values.map(csvCell).join(",")}\r\n`;
}

/** Header record for a column list (column names need no escaping). */
export function csvHeader(columns) {
  return `${columns.join(",")}\r\n`;
}

/** A row object projected onto a column list, in column order. */
export function rowValues(columns, row) {
  return columns.map((column) => row[column]);
}

/**
 * Fold request-level export rows into daily rows grouped by the rollup's
 * dimensions (date, provider, model, account, key, endpoint). Used for the
 * sub-day periods (`today`, `24h`), whose on-screen totals come from
 * usageHistory rather than the day-grain rollup, so the daily export matches
 * the screen instead of over-counting whole calendar days from the rollup.
 * @param {Iterable<object>|AsyncIterable<object>} rows request-level rows
 */
export async function* aggregateDailyRows(rows) {
  const groups = new Map();
  for await (const row of rows) {
    const date = row.timestamp ? localDateKey(row.timestamp) : "";
    const dims = [
      date,
      row.provider || "",
      row.model || "",
      row.account_id || "",
      row.api_key_id || "",
      row.api_key || "",
      row.api_key_masked || "",
      row.endpoint || "",
    ];
    const key = JSON.stringify(dims);
    let group = groups.get(key);
    if (!group) {
      group = {
        date,
        provider: row.provider || "",
        model: row.model || "",
        account: row.account || "",
        account_id: row.account_id || "",
        api_key: row.api_key || "",
        api_key_id: row.api_key_id || "",
        api_key_masked: row.api_key_masked || "",
        endpoint: row.endpoint || "",
        requests: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        cached_tokens: 0,
        cost: 0,
        status: "",
        saved_tokens_est: 0,
        _dims: dims,
      };
      groups.set(key, group);
    }
    group.requests += 1;
    group.prompt_tokens += Number(row.prompt_tokens) || 0;
    group.completion_tokens += Number(row.completion_tokens) || 0;
    group.cached_tokens += Number(row.cached_tokens) || 0;
    group.cost += Number(row.cost) || 0;
    group.saved_tokens_est += Number(row.saved_tokens_est) || 0;
  }
  const sorted = [...groups.values()].sort((a, b) => {
    for (let i = 0; i < a._dims.length; i++) {
      if (a._dims[i] < b._dims[i]) return -1;
      if (a._dims[i] > b._dims[i]) return 1;
    }
    return 0;
  });
  for (const group of sorted) {
    group.cost = Number(group.cost.toFixed(9));
    delete group._dims;
    yield group;
  }
}
