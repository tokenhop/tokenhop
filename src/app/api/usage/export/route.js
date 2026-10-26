// Usage export (YAN-425 / GitHub #1018): download the Usage page's data for
// the selected window as CSV or JSON. Same auth and scoping as the other
// /api/usage routes (usageScope resolves view/userId/apiKeyId filters and
// the Users & teams switch behavior). Daily rows follow the on-screen
// totals: today/24h fold usageHistory, other periods and custom ranges read
// the daily rollup. Request rows stream usageHistory for every window
// (history retention is opt-in, so days pruned by that setting simply have
// no request rows; daily rollup rows are unaffected).
//
// Query: period (named or custom, default 7d), from/to (custom only),
// format=csv|json (default csv), granularity=request|day (default day).
//
// Responses stream with pull-based backpressure: rows are keyset-paginated
// and a pull drains only ~64KB before returning. The first iterator step is
// awaited before the Response is built, so an early failure (e.g. DB down)
// is a clean 500 rather than a broken download. JSON is a single array
// streamed as `[row,row,...]`; CSV is RFC 4180 with spreadsheet
// formula-injection neutralization (see exportFormat.js).
import { NextResponse } from "next/server";
import { streamDailyRows, streamRequestRows } from "@/lib/usageDb";
import { exportWindow } from "@/lib/usage/exportWindow.js";
import {
  DAILY_COLUMNS,
  REQUEST_COLUMNS,
  aggregateDailyRows,
  csvHeader,
  csvRow,
  rowValues,
} from "@/lib/usage/exportFormat.js";
import { usageScope } from "@/lib/usage/scope.js";
import { isCustomPeriod, isPeriod, localTodayKey, parseDateRange } from "@/shared/utils/period";

export const dynamic = "force-dynamic";

const BATCH_BYTES = 64 * 1024;

const jsonError = (error, status) => NextResponse.json({ error }, { status });

/** Validate + normalize the export query params; `{ error }` on failure. */
export function parseExportParams(searchParams) {
  const period = searchParams.get("period") || "7d";
  const format = searchParams.get("format") || "csv";
  const granularity = searchParams.get("granularity") || "day";
  if (format !== "csv" && format !== "json") return { error: "Invalid format" };
  if (granularity !== "request" && granularity !== "day") {
    return { error: "Invalid granularity" };
  }
  let range = null;
  if (isCustomPeriod(period)) {
    const parsed = parseDateRange(
      searchParams.get("from"),
      searchParams.get("to"),
      localTodayKey(),
      // Server accepts `to` one day past its local today so a browser timezone ahead of the server still validates.
      { futureToleranceDays: 1 },
    );
    if (!parsed.ok) {
      return { error: parsed.message, code: "invalid_request", reason: parsed.reason, status: 400 };
    }
    range = { from: parsed.from, to: parsed.to };
  } else if (!isPeriod(period)) {
    return { error: "Invalid period" };
  }
  return { period, format, granularity, range, window: exportWindow(period, range) };
}

function exportFilename({ period, range, granularity, format }) {
  const stamp = range ? `${range.from}_${range.to}` : period === "all" ? "all-time" : period;
  const ext = format === "json" ? "json" : "csv";
  return `tokenhop-usage-${stamp}-${granularity}.${ext}`;
}

/** The export row stream for the resolved period + granularity. */
function rowStream(scope, { period, granularity, window }) {
  if (granularity === "request") return streamRequestRows(scope, window.history);
  if (period === "today" || period === "24h") {
    return aggregateDailyRows(streamRequestRows(scope, window.history));
  }
  return streamDailyRows(scope, window.rollup);
}

function makeStream(iterator, first, { format, columns }) {
  const encoder = new TextEncoder();
  let pending = first;
  let started = false;
  let firstRow = true;
  let closed = false;
  const serialize = (row) => {
    if (format === "json") {
      const picked = {};
      for (const column of columns) picked[column] = row[column];
      const text = `${firstRow ? "" : ","}${JSON.stringify(picked)}`;
      firstRow = false;
      return text;
    }
    return csvRow(rowValues(columns, row));
  };
  return new ReadableStream(
    {
      async pull(controller) {
        if (closed) return;
        try {
          let out = "";
          if (!started) {
            started = true;
            out += format === "json" ? "[" : csvHeader(columns);
          }
          while (out.length < BATCH_BYTES) {
            if (pending.done) {
              if (format === "json") out += "]";
              controller.enqueue(encoder.encode(out));
              closed = true;
              controller.close();
              return;
            }
            out += serialize(pending.value);
            pending = await iterator.next();
          }
          controller.enqueue(encoder.encode(out));
        } catch (error) {
          console.error("[API] Usage export stream failed:", error);
          controller.error(error);
        }
      },
      cancel() {
        return iterator.return?.();
      },
    },
    { highWaterMark: 1 },
  );
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const params = parseExportParams(searchParams);
    if (params.error) {
      return NextResponse.json(
        { error: params.error, code: params.code, reason: params.reason },
        { status: params.status || 400 },
      );
    }

    const scope = await usageScope(request);
    if (scope instanceof Response) return scope;

    const { granularity, format } = params;
    const columns = granularity === "day" ? DAILY_COLUMNS : REQUEST_COLUMNS;
    const rows = rowStream(scope, params);
    const iterator = rows[Symbol.asyncIterator]();
    // Prime the first step before responding: early failures become a 500.
    let first;
    try {
      first = await iterator.next();
    } catch (error) {
      console.error("[API] Usage export failed to start:", error);
      return jsonError("Failed to export usage", 500);
    }

    return new Response(makeStream(iterator, first, { format, columns }), {
      headers: {
        "Content-Type": format === "json" ? "application/json" : "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(params)}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("[API] Failed to export usage:", error);
    return jsonError("Failed to export usage", 500);
  }
}
