// Dependency-free credential redaction shared by audit rows and deep request
// logs (YAN-378). Every function is fail-closed: on any internal error it
// returns a placeholder, never the raw input, and never throws.
//
// Scan design (bounded): text is cut into maximal [A-Za-z0-9_.-] runs by one
// linear regex, then each run gets a handful of ANCHORED checks (one start per
// run), so total work is O(n) with no nested/overlapping quantifiers. Do not
// replace this with unanchored `\b...{8,}` regexes: repeated "sk-"/"eyJ"
// prefixes make those quadratic.
// A run glued to a serialization delimiter (`\n`, `\t`, `\u0022`, `%0A`,
// `%20`) has just that prefix stripped before the anchored check (offset +
// original string, still O(1) per run). A matching run is masked whole.
// ponytail: a token glued to arbitrary prose ("foo.eyJ...", "x-sk-...") and a
// secret split across two stream chunks are not caught; add a stateful chunk
// tail buffer / mid-run scan when such leaks are reproduced. Historical log
// files are never rewritten; audit rows are only redacted on read.

export const REDACTED = "[REDACTED]";
const FAILED = "[REDACTION_FAILED]";

const RUN = /[A-Za-z0-9_.-]{11,}/g;
const JWT_HEAD = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}/;
// sk- needs a digit so project/library names ("sk-learn-project-alpha") survive.
const SK_HEAD = /^sk-[A-Za-z0-9_-]{8,}/;
// Gateway keys: generateGatewayApiKey() => th_ + 32 [A-Za-z0-9].
const TH_HEAD = /^th_[A-Za-z0-9]{32,}/;
const AIZA_HEAD = /^AIza[A-Za-z0-9_-]{30,}/;
const BEARER = /\b(Bearer)[ \t]{1,8}([A-Za-z0-9._~+/=-]{8,})/gi;
// Prose words ("Bearer authentication") lack digits/marks; real JWT/opaque
// tokens carry at least one digit or ._-~+/=.
const TOKEN_LIKE = /[\d._~+/=-]/;
// Strict absolute / protocol-relative URLs only; never free prose.
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;
const TOKEN_RULES = [
  ["eyJ", JWT_HEAD, false],
  ["sk-", SK_HEAD, true],
  ["th_", TH_HEAD, false],
  ["AIza", AIZA_HEAD, false],
  // Provider shapes are source-backed heuristics only; vendors rotate formats
  // (e.g. GitHub ghs JWT-style, Slack xoxe/xapp). Lengths are floors and any
  // anchored match masks the whole run.
  ["ghp_", /^ghp_[A-Za-z0-9]{36,251}/, false],
  ["gho_", /^gho_[A-Za-z0-9]{36,251}/, false],
  ["ghu_", /^ghu_[A-Za-z0-9]{36,251}/, false],
  ["ghr_", /^ghr_[A-Za-z0-9]{36,251}/, false],
  ["ghs_", /^ghs_[A-Za-z0-9_.]{36,560}/, false],
  ["github_pat_", /^github_pat_[A-Za-z0-9_]{40,244}/, false],
  ["xox", /^xox[abprs]-[A-Za-z0-9-]{10,}/, false],
  ["xoxe-", /^xoxe-[A-Za-z0-9.-]{10,}/, false],
  ["xoxe.", /^xoxe\.(?:xoxb|xoxp|xapp)-[A-Za-z0-9.-]{10,}/, false],
  ["xapp-", /^xapp-[A-Za-z0-9-]{10,}/, false],
  ["AKIA", /^AKIA[0-9A-Z]{16}/, false],
  ["ASIA", /^ASIA[0-9A-Z]{16}/, false],
  ["ya29.", /^ya29\.[A-Za-z0-9._-]{20,}/, false],
  ["gsk_", /^gsk_[A-Za-z0-9]{30,}/, false],
  ["xai-", /^xai-(?:mgmt-)?[A-Za-z0-9-]{20,}/, false],
  ["hf_", /^hf_(?:jwt_|oauth_)?[A-Za-z0-9]{20,}/, false],
  ["nvapi-", /^nvapi-[A-Za-z0-9-]{40,}/, false],
];

const TOKEN_CHAR = /[A-Za-z0-9_.-]/;
const unescapeChar = (hex) => String.fromCharCode(Number.parseInt(hex, 16));

const MIN_SECRET_LEN = 8;
const MAX_SECRET_LEN = 65536;

/** Bounded request-local secrets and their URL/JSON representations. Cap 32
 *  inputs is above every current caller's provenance list; raising it is safe
 *  because the derived-form expansion is bounded per input. */
export function normalizeSecrets(list) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const s of list.slice(0, 32)) {
    if (typeof s !== "string" || s.length < MIN_SECRET_LEN || s.length > MAX_SECRET_LEN) continue;
    out.add(s);
    out.add(JSON.stringify(s).slice(1, -1));
    try {
      const encoded = encodeURIComponent(s);
      out.add(encoded);
      out.add(encoded.replace(/%[A-F0-9]{2}/g, (v) => v.toLowerCase()));
      out.add(encoded.replace(/%20/g, "+"));
    } catch {
      // Unpaired surrogate: raw and JSON forms remain safe to replace.
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function redactRun(run, offset, original) {
  // Only serialization delimiters may precede an anchored token. No arbitrary
  // mid-run search: names such as project-sk-... remain ordinary prose.
  let escaped = 0;
  const before = original[offset - 1];
  if (before === "\\") {
    if (/^[nrtbf]/.test(run)) escaped = 1;
    else if (/^u[0-9a-f]{4}/i.test(run) && !TOKEN_CHAR.test(unescapeChar(run.slice(1, 5))))
      escaped = 5;
  } else if (
    before === "%" &&
    /^[0-9a-f]{2}/i.test(run) &&
    !TOKEN_CHAR.test(unescapeChar(run.slice(0, 2)))
  ) {
    escaped = 2;
  }
  const token = run.slice(escaped);
  for (const [prefix, pattern, needsDigit] of TOKEN_RULES) {
    if (!token.startsWith(prefix)) continue;
    const m = pattern.exec(token);
    if (m && (!needsDigit || /\d/.test(m[0]))) return run.slice(0, escaped) + REDACTED;
  }
  return run;
}

/**
 * Mask token-shaped substrings in free text. `secrets` (optional) are exact
 * known values (e.g. the credentials of the current request) replaced first,
 * which also catches opaque keys with no recognisable shape.
 */
export function redactText(text, secrets) {
  if (typeof text !== "string" || text.length < MIN_SECRET_LEN) return text;
  try {
    let out = text;
    if (secrets?.length) {
      for (const s of secrets) if (out.includes(s)) out = out.split(s).join(REDACTED);
    }
    out = out.replace(BEARER, (m, scheme, value) =>
      TOKEN_LIKE.test(value) ? `${scheme} ${REDACTED}` : m,
    );
    return out.replace(RUN, redactRun);
  } catch {
    return FAILED;
  }
}

const CRED_SUFFIXES = [
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "copilottoken",
  "authtoken",
  "apitoken",
  "bearertoken",
  "sessiontoken",
  "secret",
  "secretkey",
  "accesskey",
  "password",
  "passwd",
  "authorization",
  "cookie",
  "cookies",
  "privatekey",
  "credential",
  "credentials",
];

/**
 * Credential-bearing property name. Matches apiKey/api_key, *Token (camel) and
 * the review-required camel families (copilotToken/authToken/apiToken/
 * bearerToken/sessionToken), token / *_token, secret/secretKey/accessKey,
 * password, authorization, cookie, privateKey, credential(s). Deliberately NOT
 * max_tokens / prompt_tokens / budget_tokens, signature, or bare key/tokens.
 */
export function isCredentialName(key) {
  if (typeof key !== "string" || !key) return false;
  if (/(^|[_-])token$/i.test(key)) return true;
  const n = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (n.endsWith("tokens")) return false;
  return CRED_SUFFIXES.some((s) => n.endsWith(s));
}

// Provider auth aliases not covered by ordinary credential suffixes.
const AUTH_FIELDS = new Set(["session", "basic", "basicauth", "authheader", "mimopasstoken"]);

/** Request-local named credential leaves only; metadata is never provenance.
 * ponytail: unknown provider auth names stay unclassified; extend AUTH_FIELDS
 * when a provider uses one. Depth/nodes/secrets are bounded, no global DB reads.
 */
export function collectCredentialSecrets(credentials) {
  const secrets = [];
  const seen = new WeakSet();
  let nodes = 0;
  const visit = (value, secret, depth) => {
    if (++nodes > 1024 || depth > 16 || secrets.length >= 32) return;
    if (typeof value === "string") {
      if (secret && value.length >= MIN_SECRET_LEN && value.length <= MAX_SECRET_LEN)
        secrets.push(value);
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const key of Object.keys(value)) {
      // Runtime client headers aren't provider credentials.
      if (key === "rawHeaders") continue;
      try {
        const name = key.toLowerCase().replace(/[^a-z0-9]/g, "");
        visit(value[key], secret || isCredentialName(key) || AUTH_FIELDS.has(name), depth + 1);
      } catch {
        // A hostile property must not prevent collecting remaining secrets.
      }
      if (nodes >= 1024 || secrets.length >= 32) break;
    }
  };
  try {
    visit(credentials, false, 0);
  } catch {
    // Diagnostic provenance must never fail request handling.
  }
  return secrets;
}

const URL_KEY_NAMES = new Set([
  "key",
  "apikey",
  "token",
  "auth",
  "sig",
  "signature",
  "xgoogsignature",
  "xamzsignature",
  "xamzsecuritytoken",
  "xamzcredential",
  "clientsecret",
  "pwd",
  "accesskey",
  "sessiontoken",
]);

function isUrlCredentialKey(key) {
  let k = key;
  try {
    k = decodeURIComponent(key);
  } catch {
    // keep raw key
  }
  const n = k.toLowerCase().replace(/[^a-z0-9]/g, "");
  return URL_KEY_NAMES.has(n) || isCredentialName(k);
}

const URL_USERINFO = /^((?:[a-z][a-z0-9+.-]*:)?\/\/)[^/?#\s]+@/i;
const URL_PARAM = /([?&#;])([^=&#;?\s]{1,64})=([^&#;\s]*)/g;

/**
 * Sanitize a value KNOWN to be a URL: userinfo, credential-named query /
 * fragment params, then token shapes anywhere. Never call on free prose.
 */
export function sanitizeUrl(url, secrets) {
  if (url === null || url === undefined) return url;
  try {
    let s = typeof url === "string" ? url : String(url);
    s = s.replace(URL_USERINFO, "$1REDACTED@");
    s = s.replace(URL_PARAM, (m, sep, k) => (isUrlCredentialKey(k) ? `${sep}${k}=REDACTED` : m));
    return redactText(s, secrets);
  } catch {
    return FAILED;
  }
}

function walk(v, depth, st) {
  if (typeof v === "string") {
    // Nested absolute/protocol-relative URLs get credential-param/userinfo
    // masking plus provenance; ordinary prose stays on plain redactText.
    if (ABSOLUTE_URL.test(v) && !/\s/.test(v)) return sanitizeUrl(v, st.secrets);
    return redactText(v, st.secrets);
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "function" || typeof v === "symbol") return undefined;
  if (v === null || typeof v !== "object") return v;
  if (++st.nodes > st.maxNodes || depth >= st.maxDepth) return "[Truncated]";
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return `[Binary ${v.byteLength} bytes]`;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof URL !== "undefined" && v instanceof URL) return sanitizeUrl(v.href, st.secrets);
  if (st.stack.has(v)) return "[Circular]";
  const src = v;
  const keys =
    v instanceof Error ? new Set(["name", "message", "stack", ...Object.keys(v)]) : Object.keys(v);
  st.stack.add(v);
  try {
    if (Array.isArray(src)) return src.map((x) => walk(x, depth + 1, st));
    const out = {};
    for (const k of keys) {
      let val;
      try {
        val = src[k];
      } catch {
        continue; // throwing getter
      }
      const masked =
        isCredentialName(k) && val !== null && val !== undefined && val !== ""
          ? REDACTED
          : walk(val, depth + 1, st);
      if (k === "__proto__") {
        Object.defineProperty(out, k, { value: masked, enumerable: true, writable: true });
      } else {
        out[k] = masked;
      }
    }
    return out;
  } finally {
    st.stack.delete(v);
  }
}

/**
 * Deep copy with credential-named properties masked and every string leaf run
 * through redactText. Input is never mutated; cycles, depth and node count are
 * capped; never throws.
 */
export function redactDeep(value, { secrets, maxDepth = 16, maxNodes = 50000 } = {}) {
  try {
    return walk(value, 0, { secrets, maxDepth, maxNodes, nodes: 0, stack: new WeakSet() });
  } catch {
    return FAILED;
  }
}
