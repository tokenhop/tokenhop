// YAN-378 tenant-isolation audit: credential-leak scanner for test surfaces.
//
//  - Primary: exact seeded sentinels (raw secrets, key hashes, hex/base64
//    digests, passwords). A hit anywhere in a response, persisted row, log
//    file or DB byte stream is a leak. `allow(value, key, name)` exempts one
//    sentinel at one path, for a narrow one-time-secret response (e.g. the
//    raw key in a key-creation 201 body); never blanket-allow a surface.
//  - Secondary, opt-in: `shapes: ["jwt"]` adds a JWT-shape heuristic. JWTs are
//    the only shape used: three base64url segments starting `eyJ` essentially
//    never occur in benign JSON, so false positives are negligible and it
//    catches session/OAuth tokens that were never seeded. Hex/base64/`sk-`
//    shapes are deliberately NOT heuristics (they match ids, ciphertext and
//    random binary); those secrets are covered by exact sentinels only.
import fs from "node:fs";
import path from "node:path";

/** Unique fake values; nothing here can authenticate anywhere. */
export function makeSentinels() {
  return Object.freeze({
    connectionApiKey: "sk-sent378-connkey-9f41ba",
    oauthAccessToken: "sk-sent378-oauth-access-d20c77",
    oauthRefreshToken: "sk-sent378-oauth-refresh-41c9e0",
    gatewayKey: "sk-sent378-gwkey-774afd",
    gatewayKeyHash: "3f9c1a7be5d24f068a1c2e3b4d5f60718293a4b5c6d7e8f90a1b2c3d4e5f607",
    password: "sk-sent378-password-0d3b62",
    bearerJwt:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzZW50Mzc4LWJlYXJlciJ9.sWq3r9xQ1nTlK0vZ8yHb2cD4eF6gA8iC0eU5oP7mN1s",
    hexHash: "a7f3c9e21b4d5f6789abcdef0123456789abcdef0123456789abcdef01234567",
    base64Hash: "QmFzZTY0UmVxdWVzdEhhc2hTZW50aW5lbDNNNzh0dGp4",
    refreshTokenShape: "rt-sent378-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
  });
}

const SHAPE_RULES = {
  jwt: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\b/g,
};

/** Opt-in shape matches (only the named shapes) in a text/buffer. */
export function findShapeMatches(text, shapes = []) {
  const s = Buffer.isBuffer(text) ? text.toString("latin1") : String(text ?? "");
  const hits = [];
  for (const name of shapes) {
    const re = SHAPE_RULES[name];
    if (!re) throw new Error(`unknown secret shape: ${name}`);
    for (const m of s.matchAll(re)) hits.push({ kind: "shape", name, matched: m[0], at: name });
  }
  return hits;
}

/**
 * Exact-sentinel scan over strings, Buffers, arrays and plain objects.
 * @param {string|Buffer|object} subject
 * @param {{sentinels?: object, allow?: (value: string, key: string|null, name: string) => boolean}} [opts]
 */
export function findExactSentinels(subject, { sentinels = makeSentinels(), allow } = {}) {
  const hits = [];
  const visit = (node, key) => {
    if (node === null || node === undefined) return;
    if (typeof node === "string" || Buffer.isBuffer(node)) {
      const text = Buffer.isBuffer(node) ? node.toString("latin1") : node;
      for (const [name, value] of Object.entries(sentinels)) {
        if (typeof value !== "string" || !value) continue;
        if (allow?.(value, key ?? null, name)) continue;
        if (text.includes(value)) {
          hits.push({ kind: "exact", name, matched: value, at: key ?? "<text>" });
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        visit(v, `${key ?? ""}[${i}]`);
      });
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) visit(v, key ? `${key}.${k}` : k);
    }
  };
  visit(subject, undefined);
  return hits;
}

/**
 * Combined scan. Exact sentinels always; `shapes` (default none) adds opt-in
 * heuristics. Non-string subjects are JSON-stringified for the shape pass.
 * @param {string|Buffer|object} subject
 * @param {{sentinels?: object, allow?: function, shapes?: string[]}} [opts]
 */
export function findSecretLeaks(subject, opts = {}) {
  const exact = findExactSentinels(subject, opts);
  if (!opts.shapes?.length) return exact;
  const text =
    typeof subject === "string" || Buffer.isBuffer(subject) ? subject : safeStringify(subject);
  return [...exact, ...findShapeMatches(text, opts.shapes)];
}

function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    });
  } catch {
    return String(value);
  }
}

/** Every file under `root` (recursive) as latin1 text: { path, name, text }. */
export function collectFilesText(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push({ path: p, name: e.name, text: fs.readFileSync(p, "latin1") });
    }
  };
  walk(root);
  return out;
}

/** Flatten captured console method args to one string list. */
export function captureConsole(...methods) {
  const lines = [];
  const spies = methods.map((m) => {
    const original = console[m].bind(console);
    const spy = (...args) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" "));
    };
    console[m] = spy;
    spy.restore = () => {
      console[m] = original;
    };
    return spy;
  });
  return {
    lines,
    restore: () => {
      for (const spy of spies) spy.restore();
    },
  };
}

/** Assertion helper: returns a printable leak summary for expect messages. */
export function leakSummary(leaks) {
  return leaks.map((l) => `${l.kind}:${l.name}@${l.at}`).join(", ");
}
