// YAN-1106 round 2: revokedKeyTarget reuses the digest minted at auth time, but
// the live eligibility join still runs on every call, and the digest is never
// reachable through the principal itself (JSON, spread, clone, logs, redaction).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { savedEnv } = vi.hoisted(() => {
  const saved = {
    TOKENHOP_MULTI_USER: process.env.TOKENHOP_MULTI_USER,
    TOKENHOP_MASTER_KEY: process.env.TOKENHOP_MASTER_KEY,
  };
  process.env.TOKENHOP_MULTI_USER = "on";
  return { savedEnv: saved };
});

import { resolveGatewayAuth } from "@/lib/auth/gatewayAuth.js";
import { revokedKeyTarget } from "@/sse/handlers/chatRevocation.js";
import { gatewayKeyDigestOf, attachGatewayKeyDigest } from "@/lib/security/gatewayKeyDigest.js";
import { sanitizeGatewayCapture } from "@/lib/auth/gatewayAuth.js";
import {
  TOKEN_B,
  req,
  restoreEnv,
  seedGatewayWorld,
} from "../helpers/tenantIsolation/gatewayWorld.js";

let world;
let principal;
beforeEach(async () => {
  world = await seedGatewayWorld();
  const auth = await resolveGatewayAuth(req("http://localhost/v1/models", TOKEN_B));
  principal = auth.principal;
});
afterAll(() => restoreEnv(savedEnv));

const digestOf = () => world.db.get("SELECT keyHash FROM apiKeys WHERE id = 'keyB'").keyHash;

describe("digest slot", () => {
  it("a live key passes; an unrestricted model is allowed", async () => {
    expect(await revokedKeyTarget(principal, "anthropic/claude")).toBeNull();
  });

  it("does not re-read the key row when the digest was minted with the principal", async () => {
    const reads = [];
    const get = world.db.get;
    world.db.get = (sql, ...r) => {
      if (String(sql).includes("SELECT keyHash FROM apiKeys")) reads.push(sql);
      return get.call(world.db, sql, ...r);
    };
    try {
      expect(await revokedKeyTarget(principal, "anthropic/claude")).toBeNull();
    } finally {
      world.db.get = get;
    }
    expect(reads).toEqual([]);
  });

  it.each([
    ["revoked", "UPDATE apiKeys SET revokedAt = '2026-01-01T00:00:00.000Z' WHERE id='keyB'"],
    ["paused", "UPDATE apiKeys SET isActive = 0 WHERE id='keyB'"],
    ["expired", "UPDATE apiKeys SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE id='keyB'"],
    ["member removed", "DELETE FROM memberships WHERE userId = 'uB'"],
    ["user disabled", "UPDATE users SET status = 'disabled' WHERE id = 'uB'"],
    ["row deleted", "DELETE FROM apiKeys WHERE id='keyB'"],
  ])("a %s key is 403 immediately after auth", async (_n, sql) => {
    expect(await revokedKeyTarget(principal, "anthropic/claude")).toBeNull();
    world.db.run(sql);
    const denied = await revokedKeyTarget(principal, "anthropic/claude");
    expect(denied).toBeInstanceOf(Response);
    expect(denied.status).toBe(403);
  });

  it("a key whose digest was rotated after auth is denied (digest participates in the join)", async () => {
    world.db.run(`UPDATE apiKeys SET keyHash = ? WHERE id='keyB'`, ["f".repeat(64)]);
    const denied = await revokedKeyTarget(principal, "anthropic/claude");
    expect(denied?.status).toBe(403);
  });

  it("scope pins are re-read live, not taken from the frozen principal", async () => {
    world.db.run(`UPDATE apiKeys SET allowedModels = '["only/this"]' WHERE id='keyB'`);
    expect((await revokedKeyTarget(principal, "anthropic/claude"))?.status).toBe(403);
    expect(await revokedKeyTarget(principal, "only/this")).toBeNull();
  });

  it("falls back to the row query for a principal without a digest, still live", async () => {
    const copy = Object.freeze({ ...principal }); // spread/copy carries no slot
    expect(gatewayKeyDigestOf(copy)).toBeNull();
    expect(await revokedKeyTarget(copy, "anthropic/claude")).toBeNull();
    world.db.run("UPDATE apiKeys SET isActive = 0 WHERE id='keyB'");
    expect((await revokedKeyTarget(copy, "anthropic/claude"))?.status).toBe(403);
  });

  it("another principal's digest cannot be attached to a forged object", () => {
    const forged = Object.freeze({ workspaceId: "wB", apiKeyId: "keyB", via: "apiKey" });
    expect(gatewayKeyDigestOf(forged)).toBeNull();
    attachGatewayKeyDigest(forged, "not-a-digest");
    expect(gatewayKeyDigestOf(forged)).toBeNull();
  });

  it("an owner/keyless principal never carries a digest", async () => {
    expect(gatewayKeyDigestOf(null)).toBeNull();
    expect(gatewayKeyDigestOf(undefined)).toBeNull();
    expect(await revokedKeyTarget(null, "m")).toBeNull();
  });
});

describe("the digest never appears on any read path", () => {
  const surfaces = (p) => [
    JSON.stringify(p),
    JSON.stringify({ nested: { p } }),
    JSON.stringify(Object.getOwnPropertyDescriptors(p), (_k, v) =>
      typeof v === "function" ? "fn" : v,
    ),
    Object.keys(p).join(","),
    Object.getOwnPropertyNames(p).join(","),
    Object.getOwnPropertySymbols(p).map(String).join(","),
    JSON.stringify(structuredClone(p)),
    JSON.stringify({ ...p }),
    String(Object.entries(p)),
    JSON.stringify(sanitizeGatewayCapture({ url: `http://x/v1?key=${digestOf()}` })),
  ];

  it("is absent from JSON, enumeration, clone, spread and entries", () => {
    const digest = digestOf();
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(gatewayKeyDigestOf(principal)).toBe(digest); // the slot works...
    for (const text of surfaces(principal).slice(0, 9)) {
      expect(text).not.toContain(digest); // ...but is invisible everywhere else
    }
    expect(Object.keys(principal)).not.toContain("keyHash");
    expect("keyHash" in principal).toBe(false);
  });

  it("is absent from the bearer too (principal never holds the raw key)", () => {
    for (const text of surfaces(principal)) expect(text).not.toContain(TOKEN_B);
  });

  it("console and capture redaction paths see no digest", () => {
    const digest = digestOf();
    const out = sanitizeGatewayCapture({
      headers: new Headers({ authorization: `Bearer ${TOKEN_B}` }),
      url: `http://x/v1/models?key=${TOKEN_B}`,
    });
    const text = JSON.stringify([...out.headers.entries()]) + out.url;
    expect(text).not.toContain(TOKEN_B);
    expect(text).not.toContain(digest);
  });
});
