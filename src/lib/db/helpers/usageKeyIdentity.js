import { createHmac } from "node:crypto";
import { hashApiKey } from "../../security/masterKey.js";

// Domain separating deleted/unknown-key pseudonyms from live keyHash
// digests: HMAC(hashKey, domain + raw). Never the unkeyed sha256(raw)
// fallback, and never inferred from key string shape.
const PSEUDONYM_DOMAIN = "tokenhop/usage-key-id/v1\0";
// Explicit historical sentinel: the pre-hashing "no API key" bucket key.
// Passed through verbatim wherever it appears; never hashed, never invented.
const NO_KEY = "local-no-key";
// Exact source/storage enums. Anything else fails closed.
const STORAGE_LEGACY = "legacy";
const STORAGE_HASHED = "hashed";

function validHashKey(hashKey) {
  return Buffer.isBuffer(hashKey) && hashKey.length === 32 ? hashKey : null;
}

function requireHashKey(hashKey) {
  const key = validHashKey(hashKey);
  if (!key) throw new Error("[usage-key-identity] hash key must be a 32-byte Buffer");
  return key;
}

function assertStorage(value, label) {
  if (value !== STORAGE_LEGACY && value !== STORAGE_HASHED) {
    throw new Error(`[usage-key-identity] invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function lookupId(digest, keyIdByHash) {
  if (typeof digest !== "string" || digest === "") return null;
  if (keyIdByHash instanceof Map) {
    const id = keyIdByHash.get(digest);
    return typeof id === "string" && id !== "" ? id : null;
  }
  if (keyIdByHash && typeof keyIdByHash === "object") {
    const id = keyIdByHash[digest];
    return typeof id === "string" && id !== "" ? id : null;
  }
  return null;
}

function pseudonymId(raw, hashKey) {
  const key = requireHashKey(hashKey);
  const hex = createHmac("sha256", key)
    .update(PSEUDONYM_DOMAIN, "utf8")
    .update(raw, "utf8")
    .digest("hex");
  return `historical:${hex}`;
}

/**
 * Stable non-secret identity for a gateway raw key. Known raws resolve via
 * their HMAC digest to the keys-table id; unknown historical raws get a
 * full domain-separated HMAC pseudonym. Null/empty/non-string map to null.
 * The `local-no-key` sentinel passes through untouched (explicit historical
 * contract). Invalid hash keys throw; no unkeyed fallback. Identity is never
 * inferred from the key's string shape: a raw that merely looks like an id or
 * a `historical:` pseudonym is still treated as raw.
 */
export function usageKeyId(raw, { keyIdByHash = null, hashKey = null } = {}) {
  if (typeof raw !== "string" || raw === "") return null;
  if (raw === NO_KEY) return NO_KEY;
  const key = requireHashKey(hashKey);
  const known = lookupId(hashApiKey(raw, key), keyIdByHash);
  if (known) return known;
  return pseudonymId(raw, key);
}

/**
 * Normalize one usage-history entry's credential slot. Immutable (input never
 * mutated). `storage` is the exact durable security state ('legacy' or
 * 'hashed'); anything else throws. Legacy storage returns an unchanged copy.
 * In hashed storage the raw `apiKey` field is derived to its id/pseudonym and
 * `apiKeyId` is aligned to the same derived value, so the compatibility
 * `apiKey` slot and the explicit id never disagree. An explicit trusted
 * `apiKeyId` alone (no raw) is accepted verbatim; when both are present they
 * must already agree (mismatch throws). Workspace/user ownership, counters,
 * and all other fields are preserved verbatim.
 */
export function normalizeUsageKeyEntry(
  entry,
  { storage = STORAGE_LEGACY, keyIdByHash = null, hashKey = null } = {},
) {
  assertStorage(storage, "storage");
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  if (storage === STORAGE_LEGACY) return { ...entry };
  const out = { ...entry };
  const hasRaw = typeof out.apiKey === "string" && out.apiKey !== "";
  const hasExplicit = typeof out.apiKeyId === "string" && out.apiKeyId !== "";
  if (hasRaw) {
    const derived = usageKeyId(out.apiKey, { keyIdByHash, hashKey });
    if (derived == null) {
      // A present, non-empty, non-null credential that derives to nothing is
      // malformed; reject explicitly instead of silently keeping or clobbering it.
      throw new Error("[usage-key-identity] malformed apiKey credential");
    }
    if (hasExplicit && out.apiKeyId !== derived) {
      throw new Error("[usage-key-identity] apiKey/apiKeyId mismatch");
    }
    out.apiKey = derived;
    out.apiKeyId = derived;
  } else if (out.apiKey != null && typeof out.apiKey !== "string") {
    throw new Error("[usage-key-identity] malformed apiKey credential");
  } else if (hasExplicit) {
    out.apiKey = out.apiKeyId;
  } else {
    out.apiKey = null;
  }
  return out;
}

const COUNTER_FIELDS = ["requests", "promptTokens", "completionTokens", "cachedTokens", "cost"];

function mergeBucket(into, from) {
  for (const field of COUNTER_FIELDS) into[field] = (into[field] || 0) + (from[field] || 0);
}

/**
 * Split one byApiKey dict key into its credential component.
 * `cred|model|provider` (the only shape aggregateEntryToDay ever writes) uses
 * the first component. A bare key with no pipe is treated as a bare
 * credential and converted whole — no raw secret may survive conversion.
 * A single-pipe key is ambiguous (writer never produces one), so it fails
 * closed before anything is output. An empty credential component also fails
 * closed.
 * @returns {[string, string, string]} [credential, modelSuffix, providerSuffix]
 */
function splitApiKeyDictKey(dictKey) {
  const first = dictKey.indexOf("|");
  if (first < 0) return [dictKey, "", ""];
  const last = dictKey.lastIndexOf("|");
  if (last === first) {
    throw new Error(
      `[usage-key-identity] malformed byApiKey key (single pipe): cannot locate credential`,
    );
  }
  const cred = dictKey.slice(0, first);
  if (cred === "")
    throw new Error("[usage-key-identity] malformed byApiKey key (empty credential)");
  return [cred, dictKey.slice(first, last), dictKey.slice(last)];
}

function readEmbeddedCredential(bucket) {
  const value = bucket.apiKey;
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value === "") {
    throw new Error("[usage-key-identity] malformed embedded apiKey");
  }
  return value;
}

/**
 * Rekey a parsed usageDaily day's `byApiKey` section from raw credentials to
 * key IDs/pseudonyms, keeping the exact existing bucket structure.
 *
 * Conversion state is EXPLICIT, never inferred from the data:
 * - `sourceStorage: 'legacy'` (default): every credential component is treated
 *   as a raw gateway key (known digest → keys-table id, otherwise a keyed
 *   `historical:` pseudonym). A raw that merely looks like an id or pseudonym
 *   is still converted as raw. Malformed shapes fail closed or convert whole
 *   (see splitApiKeyDictKey); counters are always preserved. Rows colliding
 *   on one identity merge by summing counters (first row's metadata wins).
 * - `sourceStorage: 'hashed'`: the day is already converted. Structural
 *   validation only, then an unchanged copy — nothing is hashed again, so an
 *   unknown-key pseudonym can never be double-hashed even if the id map has
 *   since changed.
 *
 * The caller runs the 'legacy' pass exactly once inside the migration
 * transaction that stamps the durable security marker (atomic once-only
 * conversion); any rerun must pass `sourceStorage: 'hashed'`.
 *
 * Only the credential component of each dict key and the bucket's own
 * embedded `apiKey` field change; counters, day totals, byProvider/byModel/
 * byAccount/byEndpoint and arbitrary bucket metadata are preserved. Immutable:
 * the input day and its buckets are never mutated. Malformed non-string
 * credentials throw explicitly; nothing is silently clobbered or kept.
 */
export function convertUsageDailyKeys(
  day,
  { sourceStorage = STORAGE_LEGACY, keyIdByHash = null, hashKey = null } = {},
) {
  assertStorage(sourceStorage, "sourceStorage");
  if (!day || typeof day !== "object" || Array.isArray(day)) {
    throw new Error("[usage-key-identity] malformed day");
  }
  const out = { ...day };
  const src = day.byApiKey;
  if (src === undefined) return out;
  if (!src || typeof src !== "object" || Array.isArray(src)) {
    throw new Error("[usage-key-identity] malformed byApiKey section");
  }
  const next = {};
  for (const [dictKey, bucket] of Object.entries(src)) {
    const [cred, modelSuffix, providerSuffix] = splitApiKeyDictKey(dictKey);
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
      throw new Error("[usage-key-identity] malformed byApiKey bucket");
    }
    const copy = { ...bucket };
    const embedded = readEmbeddedCredential(bucket);
    if (sourceStorage === STORAGE_HASHED) {
      // Already converted: identity must not be re-derived (double-hash risk).
      // Validation happened above; pass the bucket through unchanged.
      next[`${cred}${modelSuffix}${providerSuffix}`] = copy;
      continue;
    }
    const convert = (value) =>
      value === NO_KEY ? NO_KEY : usageKeyId(value, { keyIdByHash, hashKey });
    const mapped = convert(cred);
    if (mapped == null) {
      throw new Error("[usage-key-identity] malformed credential");
    }
    if (embedded !== null) {
      const embeddedId = convert(embedded);
      if (embeddedId == null) {
        throw new Error("[usage-key-identity] malformed embedded apiKey");
      }
      copy.apiKey = embeddedId;
    }
    const rekeyed = `${mapped}${modelSuffix}${providerSuffix}`;
    if (next[rekeyed]) mergeBucket(next[rekeyed], copy);
    else next[rekeyed] = copy;
  }
  out.byApiKey = next;
  return out;
}
