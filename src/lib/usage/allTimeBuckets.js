// Pure bucketing for the "All time" usage chart (YAN-421): folds per-day
// rollup rows into weekly buckets (weeks start Monday, local) while the span
// is at most MAX_WEEKS, else monthly while at most MAX_MONTHS, else yearly
// (always ≤ 100 points). An explicit `{from, to}` day range (YAN-426) fixes
// both ends of the series instead of the first row / today. No DB or DOM access.

const MAX_WEEKS = 98;
const MAX_MONTHS = 100;

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

function parseDateKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Local Monday on or before `d`; setDate keeps local midnight across DST. */
function weekStart(d) {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() - ((r.getDay() + 6) % 7));
  return r;
}

// grain + start are the machine-readable bucket bounds (YAN-1233): the
// client formats localized labels from them; `label` stays English for
// compatibility with older consumers.
const emptyBucket = (label, grain, start) => ({
  label,
  grain,
  start,
  input: 0,
  cached: 0,
  output: 0,
  tokens: 0,
  cost: 0,
  requests: 0,
});

/**
 * @param {Array<{dateKey:string,requests:number,tokensIn:number,tokensOut:number,tokensCached:number,cost:number}>} rows
 *   one row per local dateKey
 * @param {Date} [todayArg] "today" for the series end (ignored when `range` is set)
 * @param {{from: string, to: string}|null} [range] inclusive local day keys; the
 *   series spans exactly from..to (rows outside are clamped into the edge buckets)
 * @returns {Array<{label:string,grain:"week"|"month"|"year",start:string,input:number,cached:number,output:number,tokens:number,cost:number,requests:number}>}
 *   `start` is the bucket's first local day key (week), `YYYY-MM` (month) or `YYYY` (year)
 */
export function buildAllTimeBuckets(rows, todayArg = new Date(), range = null) {
  const valid = rows.filter((r) => r?.dateKey);
  const today = range ? parseDateKey(range.to) : todayArg;
  const currentWeek = weekStart(today);
  if (!valid.length && !range) {
    return [
      emptyBucket(
        currentWeek.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        "week",
        dayKey(currentWeek),
      ),
    ];
  }
  const minDay = parseDateKey(
    range ? range.from : valid.reduce((m, r) => (r.dateKey < m ? r.dateKey : m), valid[0].dateKey),
  );
  // Future-only (clock skew) or malformed keys start the series today, so it is never empty.
  const first = Number.isNaN(minDay.getTime()) || minDay > today ? today : minDay;
  const firstWeek = weekStart(first);
  const weeks = Math.round((currentWeek - firstWeek) / (7 * 86400000)) + 1;
  const months =
    (today.getFullYear() - first.getFullYear()) * 12 + today.getMonth() - first.getMonth() + 1;
  const grain = weeks <= MAX_WEEKS ? "week" : months <= MAX_MONTHS ? "month" : "year";
  const multiYear = firstWeek.getFullYear() !== today.getFullYear();

  // Ordered bucket skeleton: [key, label]. Keys are zero-padded, so they sort as strings.
  const skeleton = [];
  if (grain === "week") {
    const fmt = { month: "short", day: "numeric", ...(multiYear && { year: "numeric" }) };
    for (let d = new Date(firstWeek); d <= currentWeek; d.setDate(d.getDate() + 7)) {
      skeleton.push([dayKey(d), d.toLocaleDateString("en-US", fmt)]);
    }
  } else if (grain === "month") {
    const fmt = { month: "short", year: "numeric" };
    const end = new Date(today.getFullYear(), today.getMonth(), 1);
    for (
      let d = new Date(first.getFullYear(), first.getMonth(), 1);
      d <= end;
      d.setMonth(d.getMonth() + 1)
    ) {
      skeleton.push([monthKey(d), d.toLocaleDateString("en-US", fmt)]);
    }
  } else {
    for (let y = first.getFullYear(); y <= today.getFullYear(); y++) {
      skeleton.push([String(y), String(y)]);
    }
  }
  const byKey = new Map(skeleton.map(([key, label]) => [key, emptyBucket(label, grain, key)]));
  const firstKey = skeleton[0][0];
  const lastKey = skeleton.at(-1)[0];

  for (const r of valid) {
    const d = parseDateKey(r.dateKey);
    const raw =
      grain === "week"
        ? dayKey(weekStart(d))
        : grain === "month"
          ? monthKey(d)
          : String(d.getFullYear());
    // Clamp strays (e.g. a row dated after today) into the edge bucket instead of dropping them.
    const b = byKey.get(raw < firstKey ? firstKey : raw > lastKey ? lastKey : raw);
    const input = Math.max(r.tokensIn || 0, r.tokensCached || 0);
    b.input += input;
    b.cached += r.tokensCached || 0;
    b.output += r.tokensOut || 0;
    b.tokens += input + (r.tokensOut || 0);
    b.cost += r.cost || 0;
    b.requests += r.requests || 0;
  }
  return skeleton.map(([key]) => byKey.get(key));
}
