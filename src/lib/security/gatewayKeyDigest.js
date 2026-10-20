// YAN-1106 per-principal gateway key digest slot. The digest is the keyed HMAC of
// the presented bearer (never the bearer itself). It is kept in a WeakMap keyed by
// the minted principal object, off the principal entirely: JSON, logging, spreads,
// structuredClone and redaction paths never see it, and a copied or forged
// principal carries none. It exists only so the live eligibility join can be
// re-run later in the same request without re-reading the key row; the join
// itself (id + digest + active/expiry/membership) is always executed live.
const digests = new WeakMap();
const HASH_RE = /^[0-9a-f]{64}$/;

/** Server-only: bind the digest to the principal object the resolver just minted. */
export function attachGatewayKeyDigest(principal, digest) {
  if (principal && typeof principal === "object" && HASH_RE.test(String(digest))) {
    digests.set(principal, digest);
  }
  return principal;
}

/** The digest the server minted this exact principal with, else null. */
export function gatewayKeyDigestOf(principal) {
  return (principal && typeof principal === "object" && digests.get(principal)) || null;
}
