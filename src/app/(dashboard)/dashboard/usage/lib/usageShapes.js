// Pure data-shaping helpers for the YAN-300 Usage redesign.
//
// Framework-free mirrors of the semantics in
// src/shared/components/UsageStats.js (sortData, getGroupKey,
// groupDataByKey). No API routes or DB access here — plain input → output.

export function getGroupKey(item, keyField) {
  const row = item || {};
  switch (keyField) {
    case "rawModel":
      return row.rawModel || "Unknown Model";
    case "accountName":
      return row.accountName || `Account ${row.connectionId?.slice(0, 8)}...` || "Unknown Account";
    case "keyName":
      return row.keyName || "Unknown Key";
    case "endpoint":
      return row.endpoint || "Unknown Endpoint";
    default:
      return row[keyField] || "Unknown";
  }
}

// Sort a row array, deriving token/cost totals first (same as sortData).
// ponytail: cost split is a token-share allocation of the (rate-accurate)
// row total, not a per-rate recompute. cached is a subset of prompt, so peel
// it out of the input share. Upgrade to a stored per-component cost breakdown
// if exact cached-rate cost display is needed.
export function sortRows(rows, sortBy, sortOrder) {
  return (rows || [])
    .map((row) => {
      const totalTokens = (row.promptTokens || 0) + (row.completionTokens || 0);
      const totalCost = row.cost || 0;
      const cachedTokens = row.cachedTokens || 0;
      const nonCachedInput = Math.max(0, (row.promptTokens || 0) - cachedTokens);
      const inputCost = totalTokens > 0 ? (nonCachedInput * totalCost) / totalTokens : 0;
      const cachedCost = totalTokens > 0 ? (cachedTokens * totalCost) / totalTokens : 0;
      const outputCost =
        totalTokens > 0 ? ((row.completionTokens || 0) * totalCost) / totalTokens : 0;
      return {
        ...row,
        totalTokens,
        totalCost,
        inputCost,
        cachedCost,
        outputCost,
        pending: row.pending || 0,
      };
    })
    .sort((a, b) => {
      let valA = a[sortBy];
      let valB = b[sortBy];
      if (typeof valA === "string") valA = valA.toLowerCase();
      if (typeof valB === "string") valB = valB.toLowerCase();
      if (valA < valB) return sortOrder === "asc" ? -1 : 1;
      if (valA > valB) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });
}

// Group row arrays by keyField (same as groupDataByKey). Account pending edge
// handling simplified: plain sum of row.pending instead of the
// pending.byAccount connectionId lookup from UsageStats.
export function groupRows(rows, keyField) {
  if (!Array.isArray(rows)) return [];
  const groups = {};
  for (const item of rows) {
    const gk = getGroupKey(item, keyField);
    if (!groups[gk]) {
      groups[gk] = {
        groupKey: gk,
        summary: {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          totalTokens: 0,
          cost: 0,
          inputCost: 0,
          cachedCost: 0,
          outputCost: 0,
          lastUsed: null,
          pending: 0,
        },
        items: [],
      };
    }
    const s = groups[gk].summary;
    s.requests += item.requests || 0;
    s.promptTokens += item.promptTokens || 0;
    s.completionTokens += item.completionTokens || 0;
    s.cachedTokens += item.cachedTokens || 0;
    s.totalTokens += item.totalTokens || 0;
    s.cost += item.cost || 0;
    s.inputCost += item.inputCost || 0;
    s.cachedCost += item.cachedCost || 0;
    s.outputCost += item.outputCost || 0;
    s.pending += item.pending || 0;
    if (item.lastUsed && (!s.lastUsed || new Date(item.lastUsed) > new Date(s.lastUsed))) {
      s.lastUsed = item.lastUsed;
    }
    groups[gk].items.push(item);
  }
  return Object.values(groups);
}

// Share of a part within a total, as a percentage. 0 when total is falsy.
export function sharePct(value, total) {
  if (!total) return 0;
  return ((value || 0) / total) * 100;
}

// Period-over-period delta. pct is null when previous is 0 (no baseline);
// up is false only when current strictly dropped below previous.
export function periodDelta(current, previous) {
  const cur = current || 0;
  const prev = previous || 0;
  if (!prev) return { pct: null, up: cur > 0 };
  return { pct: ((cur - prev) / Math.abs(prev)) * 100, up: cur >= prev };
}

// Map API chart buckets to recharts rows.
// Basic bucket {label,tokens,cost} (legacy shape) → tokens land in input.
// Extended bucket {label,input,cached,output,tokens,cost}
// (from getChartData): input is cache-inclusive, cached is a subset of input,
// tokens = input + output. cost passes through unchanged.
export function shapeChartSeries(buckets) {
  return (buckets || []).map((b) => {
    const bucket = b || {};
    if (bucket.input !== undefined || bucket.cached !== undefined || bucket.output !== undefined) {
      const input = bucket.input || 0;
      const cached = bucket.cached || 0;
      const output = bucket.output || 0;
      return {
        label: bucket.label,
        input,
        cached,
        output,
        cost: bucket.cost || 0,
        tokens: input + output,
      };
    }
    return {
      label: bucket.label,
      input: bucket.tokens || 0,
      cached: 0,
      output: 0,
      cost: bucket.cost || 0,
      tokens: bucket.tokens || 0,
    };
  });
}

const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "cookie", "token", "api-key"]);

// Known secret-bearing JSON body keys. Values are replaced before the body
// is serialized into a cURL snippet so secrets never reach the clipboard.
const SENSITIVE_BODY_KEYS = new Set([
  "api_key",
  "apikey",
  "api-key",
  "authorization",
  "token",
  "secret",
  "password",
  "access_token",
  "refresh_token",
  "client_secret",
]);

// Deep-clone JSON-safe values, replacing sensitive-key values with
// "[redacted]". Non-JSON-safe values (BigInt etc.) fall back to String().
function redactBody(value) {
  if (Array.isArray(value)) return value.map(redactBody);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_BODY_KEYS.has(String(k).toLowerCase()) ? "[redacted]" : redactBody(v);
    }
    return out;
  }
  return value;
}

// Shell-escape a value wrapped in single quotes.
function sq(value) {
  return String(value).replace(/'/g, `'\\''`);
}

// Build a multi-line curl snippet. Sensitive header VALUES are replaced with
// "[redacted]" (names kept, entries kept even when empty) so the output never
// carries secrets.
export function buildCurl({ method = "GET", url = "", headers = {}, body } = {}) {
  const lines = [`curl -X ${method} '${sq(url)}'`];
  for (const [name, value] of Object.entries(headers || {})) {
    const shown = SENSITIVE_HEADERS.has(String(name).toLowerCase()) ? "[redacted]" : value;
    lines.push(`-H '${sq(`${name}: ${shown}`)}'`);
  }
  if (body !== undefined && body !== null && body !== "") {
    let text;
    if (typeof body === "string") {
      text = body;
      try {
        text = JSON.stringify(redactBody(JSON.parse(body)));
      } catch {
        // Not JSON — keep as-is (header redaction still applies above).
      }
    } else {
      text = JSON.stringify(redactBody(body));
    }
    lines.push(`--data '${sq(text)}'`);
  }
  return lines.join(" \\\n  ");
}
