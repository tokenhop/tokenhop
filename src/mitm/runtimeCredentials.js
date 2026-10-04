const { createHash, randomBytes, timingSafeEqual } = require("crypto");
const { open } = require("fs/promises");
const { TextDecoder } = require("util");

const MAX_CREDENTIAL_BYTES = 4096;
const INVALID_BASE_URL = "Invalid MITM router base URL";
const INVALID_CREDENTIAL = "Invalid MITM remote credential";
// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in credentials and router URLs.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function normalizeRouterBaseUrl(input) {
  try {
    if (typeof input !== "string" || CONTROL_RE.test(input) || /[?#]/.test(input)) {
      throw new Error();
    }
    const trimmed = input.trim();
    const url = new URL(trimmed);
    if (
      !/^https?:\/\//i.test(trimmed) ||
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      /^https?:\/\/[^/]*@/i.test(trimmed)
    )
      throw new Error();
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    throw new Error(INVALID_BASE_URL);
  }
}

function checkSecret(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_CREDENTIAL_BYTES &&
    !CONTROL_RE.test(value)
  );
}

// Operator-only input: never expose source selection to browser requests.
// Reads are bounded, read-only, and uncached; caller owns startup/restart memory.
async function readRemoteCredential({ routerBaseUrl, source, env = process.env } = {}) {
  const base = normalizeRouterBaseUrl(routerBaseUrl);
  try {
    let apiKey;
    if (
      source?.type === "env" &&
      typeof source.name === "string" &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(source.name)
    ) {
      apiKey = env[source.name];
    } else if (source?.type === "file" && typeof source.path === "string" && source.path) {
      const file = await open(source.path, "r");
      try {
        if (!(await file.stat()).isFile()) throw new Error();
        const bytes = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > MAX_CREDENTIAL_BYTES) throw new Error();
        apiKey = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
        apiKey = apiKey.replace(/\r?\n$/, "");
      } finally {
        await file.close();
      }
    } else {
      throw new Error();
    }
    if (!checkSecret(apiKey)) throw new Error();
    return { routerBaseUrl: base, apiKey };
  } catch {
    // Never expose OS errors, source paths, env names, or secret values.
    throw new Error(INVALID_CREDENTIAL);
  }
}

function createLocalCredential() {
  const apiKey = randomBytes(32).toString("base64url");
  return { apiKey, verifierHash: createHash("sha256").update(apiKey).digest("hex") };
}

function matchesLocalCredential(apiKey, verifierHash) {
  if (
    !checkSecret(apiKey) ||
    typeof verifierHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(verifierHash)
  ) {
    return false;
  }
  return timingSafeEqual(
    createHash("sha256").update(apiKey).digest(),
    Buffer.from(verifierHash, "hex"),
  );
}

module.exports = {
  normalizeRouterBaseUrl,
  readRemoteCredential,
  createLocalCredential,
  matchesLocalCredential,
};
