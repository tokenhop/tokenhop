// Byte-bounded keyset paging (YAN-1013). A fixed row count is not a memory
// bound: a page of 500 rows with multi-MiB `data` columns would load GiBs into
// the heap at once. Each page is therefore cut by a cheap in-SQLite size
// estimate (no row data crosses into JS for the estimate) so one page holds
// about `PAGE_BYTE_BUDGET` bytes, or a single row when that row alone exceeds
// the budget. Callers must not write to the table between pages.

export const PAGE_BYTE_BUDGET = 8 * 1024 * 1024;

const q = (id) => `"${id}"`;

// length() counts characters for TEXT (bytes for BLOB): an estimate that is
// exact for ASCII and never reads more than SQLite already scans internally.
export function sizeExpr(columns) {
  return columns.map((c) => `COALESCE(length(${q(c)}), 0)`).join(" + ") || "0";
}

/**
 * Walk `table` in `key` order, calling `onRows(rows)` once per byte-bounded page.
 * @param {(sql: string, params?: unknown[]) => object[]} all sync row reader
 * @param {{ table: string, key: "rowid" | "seq", columns: string[], pageSize: number, maxBytes?: number }} spec
 *   `table` is already qualified/quoted. Rows keep every `SELECT *` column; the
 *   internal cursor column is stripped.
 * @param {(rows: object[]) => void} onRows
 */
export function forEachBoundedPage(
  all,
  { table, key, columns, pageSize, maxBytes = PAGE_BYTE_BUDGET },
  onRows,
) {
  const sizeCols = `SELECT ${key} AS __k, (${sizeExpr(columns)}) AS __sz FROM ${table}`;
  // Two plain shapes instead of `(? IS NULL OR key > ?)`: the OR form defeats
  // the rowid range seek, turning every page into a full scan (quadratic).
  const sizesFirst = `${sizeCols} ORDER BY ${key} LIMIT ?`;
  const sizesNext = `${sizeCols} WHERE ${key} > ? ORDER BY ${key} LIMIT ?`;
  const fetchFirst = `SELECT *, ${key} AS __k FROM ${table} WHERE ${key} <= ? ORDER BY ${key}`;
  const fetchNext = `SELECT *, ${key} AS __k FROM ${table} WHERE ${key} > ? AND ${key} <= ? ORDER BY ${key}`;
  // A null cursor means "from the first row": rowids may be zero or negative
  // (usageHistory.id is a user-importable INTEGER PRIMARY KEY), so no numeric
  // sentinel is safe — `key > 0` would silently skip those rows.
  let last = null;
  for (;;) {
    const probe = last === null ? all(sizesFirst, [pageSize]) : all(sizesNext, [last, pageSize]);
    if (probe.length === 0) return;
    let end = 0;
    let bytes = 0;
    while (end < probe.length) {
      bytes += Number(probe[end].__sz) || 0;
      if (end > 0 && bytes > maxBytes) break;
      end++;
    }
    const upTo = probe[end - 1].__k;
    const rows = last === null ? all(fetchFirst, [upTo]) : all(fetchNext, [last, upTo]);
    if (rows.length === 0) return;
    last = upTo;
    for (const row of rows) delete row.__k;
    onRows(rows);
    // A short probe means the table is exhausted once this page is delivered.
    if (end === probe.length && probe.length < pageSize) return;
  }
}

/** Live-table variant: pages by rowid. */
export function forEachBoundedSectionPage(db, section, pageSize, onRows, opts = {}) {
  forEachBoundedPage(
    (sql, params) => db.all(sql, params),
    { table: q(section.name), key: "rowid", columns: section.columns, pageSize, ...opts },
    onRows,
  );
}
