// Localized labels for /api/usage/chart buckets (YAN-1233). The server sends
// machine-readable bounds on each bucket — grain ("hour" | "day" | "week" |
// "month" | "year") and `start` (ISO instant for hours, `YYYY-MM-DD` for
// day/week, `YYYY-MM` for month, `YYYY` for year) — and keeps an English
// `label` for older consumers. Pure: no DOM or i18n runtime access.

/** Local-midnight Date for `YYYY[-MM[-DD]]` (never UTC parsing, which shifts the day). */
function keyToDate(key) {
  const [y, m = 1, d = 1] = String(key).split("-").map(Number);
  return new Date(y, m - 1, d);
}

function bucketDate(bucket) {
  if (!bucket || typeof bucket.start !== "string" || !bucket.grain) return null;
  const date = bucket.grain === "hour" ? new Date(bucket.start) : keyToDate(bucket.start);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatter(locale, options) {
  try {
    return new Intl.DateTimeFormat(locale || undefined, options);
  } catch {
    return new Intl.DateTimeFormat("en", options);
  }
}

/**
 * Returns the buckets with `label` localized to `locale`. Day and week labels
 * carry the year when the series spans more than one year or lies outside the
 * current year, so a range across New Year is unambiguous. Hour labels keep the
 * compact 24-hour form in the viewer's time zone. Buckets without bounds
 * (legacy servers) keep their server label.
 * @template {{label?: string, grain?: string, start?: string}} T
 * @param {T[]} buckets
 * @param {string|null|undefined} locale BCP 47 tag; falsy uses the runtime default
 * @param {Date} [now] "today" for the current-year rule
 * @returns {T[]}
 */
export function localizeBucketLabels(buckets, locale, now = new Date()) {
  if (!Array.isArray(buckets) || buckets.length === 0) return buckets ?? [];
  const dates = buckets.map(bucketDate);
  const years = new Set(dates.filter(Boolean).map((d) => d.getFullYear()));
  const withYear = years.size > 1 || (years.size === 1 && !years.has(now.getFullYear()));
  const formats = {
    hour: formatter(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    day: formatter(locale, {
      month: "short",
      day: "numeric",
      ...(withYear && { year: "numeric" }),
    }),
    month: formatter(locale, { month: "short", year: "numeric" }),
    year: formatter(locale, { year: "numeric" }),
  };
  return buckets.map((bucket, i) => {
    const date = dates[i];
    const format = formats[bucket.grain === "week" ? "day" : bucket.grain];
    return date && format ? { ...bucket, label: format.format(date) } : bucket;
  });
}
