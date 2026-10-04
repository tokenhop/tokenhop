import { NextResponse } from "next/server";
import { readApiKeyStorageState } from "@/lib/db/apiKeyState.js";
import { getAdapter } from "@/lib/db/driver.js";
import { withV1 } from "./shared";

// YAN-363: hashed durable mode gates credential handling on the host-tool
// Apply routes. Legacy storage keeps today's exact behavior; an unreadable
// durable marker is surfaced by the caller as 503, never silently legacy.
export async function hashedStorageMode() {
  return readApiKeyStorageState(await getAdapter()).storage === "hashed";
}

// Destination identity for credential-reuse checks: scheme + host + explicit
// port + collapsed pathname, after the client config's own normalization
// (trailing slash trimmed, /v1 suffix when the builder applies it). Userinfo,
// query, fragment, or a malformed URL are never a "same destination" — they
// throw. `localhost` and `127.0.0.1` stay different hosts.
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

export function destinationIdentity(raw, { applyV1 = true, normalize } = {}) {
  let url;
  try {
    if (typeof raw !== "string" || !raw.trim()) throw new Error("invalid");
    const value = normalize ? normalize(raw) : raw;
    url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw badRequest("baseUrl must be a plain http(s) URL without userinfo, query, or fragment");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${applyV1 ? withV1(pathname) : pathname}`;
}

// Resolve the credential a POST may persist: an explicit key passes through
// (validated); an omitted one is reused ONLY from a stored secret bound to the
// SAME normalized destination. Missing or ambiguous stored secrets are an
// actionable 400 — never a first raw/default placeholder fallback.
export function resolveCredential({ provided, baseUrl, existing, ...identity }) {
  const target = destinationIdentity(baseUrl, identity);
  if (provided !== undefined) {
    if (typeof provided !== "string" || !provided.trim() || /[\r\n]/.test(provided)) {
      throw badRequest("apiKey must be a non-empty single-line string");
    }
    return provided;
  }
  const keys = new Set();
  for (const entry of Array.isArray(existing) ? existing : [existing]) {
    if (!entry || typeof entry.key !== "string" || !entry.key.trim()) continue;
    // A stored key that can't round-trip a config/env file can't authorize reuse.
    if (/[\r\n"]/.test(entry.key)) continue;
    try {
      if (destinationIdentity(entry.url, identity) === target) keys.add(entry.key);
    } catch {
      /* an unusable stored destination cannot authorize reuse */
    }
  }
  if (keys.size === 1) return [...keys][0];
  throw badRequest(
    "apiKey is required for a new or changed destination; paste a gateway key or re-apply with one",
  );
}

// Hashed-mode error path: 400 stays actionable, ConfigParseError stays 422,
// everything else is a withheld 500 (no values, no echo).
export function boundaryError(error) {
  if (error?.status === 400) return NextResponse.json({ error: error.message }, { status: 400 });
  if (error?.name === "ConfigParseError") {
    return NextResponse.json({ error: error.message }, { status: 422 });
  }
  return NextResponse.json(
    { error: "Failed to read or update tool settings; values withheld" },
    { status: 500 },
  );
}

// Deep copy of a parsed on-disk config for sanitized GET responses.
export const configCopy = (value) => (value == null ? value : structuredClone(value));
