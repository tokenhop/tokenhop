// YAN-363: usage key-identity conversion helpers (pure prep, no sinks).
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  convertUsageDailyKeys,
  normalizeUsageKeyEntry,
  usageKeyId,
} from "@/lib/db/helpers/usageKeyIdentity.js";
import { deriveApiKeyHashKey } from "@/lib/security/masterKey.js";

const master = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const hashKey = deriveApiKeyHashKey(master);
const RAW_A = "th_0123456789ABCDEFGHIJKLMNOPQRSTUV";
const RAW_B = "th_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const RAW_C = "th_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";
const known = new Map();
const byDigest = (raw) => createHmac("sha256", hashKey).update(raw, "utf8").digest("hex");
known.set(byDigest(RAW_A), "key-id-A");

const expectedPseudo = (raw) =>
  `historical:${createHmac("sha256", hashKey).update("tokenhop/usage-key-id/v1\0", "utf8").update(raw, "utf8").digest("hex")}`;

const counterBucket = (over = {}) => ({
  requests: 1,
  promptTokens: 10,
  completionTokens: 5,
  cachedTokens: 2,
  cost: 0.5,
  rawModel: "gpt-4o",
  provider: "openai",
  ...over,
});

describe("usageKeyId", () => {
  it("returns null for null/empty/non-string", () => {
    expect(usageKeyId(null, { keyIdByHash: known, hashKey })).toBeNull();
    expect(usageKeyId("", { keyIdByHash: known, hashKey })).toBeNull();
    expect(usageKeyId(42, { keyIdByHash: known, hashKey })).toBeNull();
    expect(usageKeyId(undefined, { keyIdByHash: known, hashKey })).toBeNull();
  });
  it("resolves known raw via HMAC digest to id", () => {
    expect(usageKeyId(RAW_A, { keyIdByHash: known, hashKey })).toBe("key-id-A");
  });
  it("maps unknown historical raw to domain-separated keyed pseudonym", () => {
    const id = usageKeyId(RAW_B, { keyIdByHash: known, hashKey });
    expect(id).toBe(expectedPseudo(RAW_B));
    expect(id).not.toBe(
      `key-${createHmac("sha256", hashKey).update(RAW_B).digest("hex").slice(0, 12)}`,
    );
    expect(usageKeyId(RAW_B, { keyIdByHash: known, hashKey })).toBe(id);
  });
  it("never infers id from string shape; raw-looking-like-ID still converts; bad hashKey throws", () => {
    expect(usageKeyId("key-id-A", { keyIdByHash: known, hashKey })).toBe(
      expectedPseudo("key-id-A"),
    );
    expect(usageKeyId("historical:deadbeef", { keyIdByHash: known, hashKey })).toBe(
      expectedPseudo("historical:deadbeef"),
    );
    expect(() => usageKeyId(RAW_A, { keyIdByHash: known })).toThrow();
    expect(() => usageKeyId(RAW_A, { keyIdByHash: known, hashKey: Buffer.alloc(16) })).toThrow();
  });
  it("keeps the local-no-key sentinel as explicit historical contract", () => {
    expect(usageKeyId("local-no-key", { keyIdByHash: known, hashKey })).toBe("local-no-key");
  });
});

describe("normalizeUsageKeyEntry", () => {
  it("leaves legacy storage entries unchanged in value", () => {
    const entry = { apiKey: RAW_A, provider: "openai", workspaceId: "w1", n: 1 };
    const out = normalizeUsageKeyEntry(entry, { storage: "legacy", keyIdByHash: known, hashKey });
    expect(out).toEqual(entry);
    expect(out).not.toBe(entry);
  });
  it("converts known raw to id, aligns apiKeyId, preserves ownership and other fields", () => {
    const entry = {
      apiKey: RAW_A,
      provider: "openai",
      workspaceId: "w1",
      userId: "u1",
      x: { y: 1 },
    };
    const out = normalizeUsageKeyEntry(entry, { storage: "hashed", keyIdByHash: known, hashKey });
    expect(out.apiKey).toBe("key-id-A");
    expect(out.apiKeyId).toBe("key-id-A");
    expect(out.workspaceId).toBe("w1");
    expect(out.userId).toBe("u1");
    expect(out.provider).toBe("openai");
    expect(entry.apiKey).toBe(RAW_A);
  });
  it("converts unknown raw to pseudonym and accepts explicit apiKeyId alone", () => {
    const out = normalizeUsageKeyEntry(
      { apiKey: RAW_B },
      { storage: "hashed", keyIdByHash: known, hashKey },
    );
    expect(out.apiKey).toBe(expectedPseudo(RAW_B));
    expect(out.apiKeyId).toBe(expectedPseudo(RAW_B));
    const explicit = normalizeUsageKeyEntry(
      { apiKeyId: "key-id-A", workspaceId: "w1" },
      { storage: "hashed", keyIdByHash: known, hashKey },
    );
    expect(explicit.apiKey).toBe("key-id-A");
    expect(explicit.workspaceId).toBe("w1");
  });
  it("accepts matching explicit id, throws on mismatch; null/absent apiKey stays null", () => {
    const ok = normalizeUsageKeyEntry(
      { apiKey: RAW_A, apiKeyId: "key-id-A" },
      { storage: "hashed", keyIdByHash: known, hashKey },
    );
    expect(ok.apiKey).toBe("key-id-A");
    expect(() =>
      normalizeUsageKeyEntry(
        { apiKey: RAW_A, apiKeyId: "other" },
        { storage: "hashed", keyIdByHash: known, hashKey },
      ),
    ).toThrow(/mismatch/);
    expect(
      normalizeUsageKeyEntry({}, { storage: "hashed", keyIdByHash: known, hashKey }).apiKey,
    ).toBeNull();
  });
  it("rejects invalid storage enum and malformed non-string credential", () => {
    expect(() =>
      normalizeUsageKeyEntry(
        { apiKey: RAW_A },
        { storage: "hashed-enabled", keyIdByHash: known, hashKey },
      ),
    ).toThrow(/invalid storage/);
    expect(() =>
      normalizeUsageKeyEntry({ apiKey: RAW_A }, { storage: "bogus", keyIdByHash: known, hashKey }),
    ).toThrow(/invalid storage/);
    expect(() =>
      normalizeUsageKeyEntry({ apiKey: 42 }, { storage: "hashed", keyIdByHash: known, hashKey }),
    ).toThrow(/malformed/);
  });
});

describe("convertUsageDailyKeys (sourceStorage: legacy)", () => {
  const day = () => ({
    requests: 3,
    promptTokens: 30,
    cost: 1.5,
    byProvider: { openai: { requests: 3 } },
    byModel: { "gpt-4o|openai": { requests: 3, provider: "openai", rawModel: "gpt-4o" } },
    byApiKey: {
      [`${RAW_A}|gpt-4o|openai`]: counterBucket({ apiKey: RAW_A }),
      [`${RAW_B}|gpt-4o|openai`]: counterBucket({
        requests: 2,
        promptTokens: 20,
        completionTokens: 1,
        cachedTokens: 0,
        cost: 1,
        apiKey: RAW_B,
        custom: "kept",
      }),
      "local-no-key|gpt-4o-mini|openai": {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        cost: 0,
        rawModel: "gpt-4o-mini",
        provider: "openai",
        apiKey: null,
      },
    },
  });

  it("rekeys credential component and embedded apiKey, preserves totals and unrelated metadata", () => {
    const src = day();
    const out = convertUsageDailyKeys(src, { keyIdByHash: known, hashKey });
    expect(out.byApiKey["key-id-A|gpt-4o|openai"].apiKey).toBe("key-id-A");
    expect(out.byApiKey[`${expectedPseudo(RAW_B)}|gpt-4o|openai`].apiKey).toBe(
      expectedPseudo(RAW_B),
    );
    expect(out.byApiKey[`${expectedPseudo(RAW_B)}|gpt-4o|openai`].custom).toBe("kept");
    expect(out.byApiKey["local-no-key|gpt-4o-mini|openai"]).toEqual(
      src.byApiKey["local-no-key|gpt-4o-mini|openai"],
    );
    expect(out.requests).toBe(3);
    expect(out.promptTokens).toBe(30);
    expect(out.cost).toBe(1.5);
    expect(out.byProvider).toEqual(src.byProvider);
    expect(out.byModel).toEqual(src.byModel);
    expect(JSON.stringify(out)).not.toContain(RAW_A);
    expect(JSON.stringify(out)).not.toContain(RAW_B);
    expect(src.byApiKey[`${RAW_A}|gpt-4o|openai`].apiKey).toBe(RAW_A);
  });

  it("converts a bare credential dict key whole; counters preserved, secret gone", () => {
    const bare = {
      requests: 1,
      byApiKey: {
        [RAW_B]: counterBucket({ apiKey: RAW_B }),
      },
    };
    const out = convertUsageDailyKeys(bare, { keyIdByHash: known, hashKey });
    expect(Object.keys(out.byApiKey)).toEqual([expectedPseudo(RAW_B)]);
    expect(out.byApiKey[expectedPseudo(RAW_B)]).toMatchObject({ requests: 1, promptTokens: 10 });
    expect(JSON.stringify(out)).not.toContain(RAW_B);
  });

  it("fails closed on single-pipe keys before any output; input untouched", () => {
    const single = {
      requests: 1,
      byApiKey: { [`${RAW_B}|gpt-4o`]: counterBucket({ apiKey: RAW_B }) },
    };
    expect(() => convertUsageDailyKeys(single, { keyIdByHash: known, hashKey })).toThrow(
      /single pipe/,
    );
    expect(single.byApiKey[`${RAW_B}|gpt-4o`].apiKey).toBe(RAW_B);
  });

  it("fails closed on empty credential component and malformed embedded credential", () => {
    expect(() =>
      convertUsageDailyKeys(
        { byApiKey: { "|gpt-4o|openai": counterBucket() } },
        { keyIdByHash: known, hashKey },
      ),
    ).toThrow(/empty credential/);
    // Regression: the error must be static — the raw dict key (credential
    // carrier) must never be interpolated into the thrown message.
    const sentinelRaw = "th_usage_error_secret_9e8b47c261";
    const sentinelKey = `${sentinelRaw}|gpt-4o|openai`;
    let thrown = null;
    try {
      convertUsageDailyKeys(
        { byApiKey: { [sentinelKey]: counterBucket({ apiKey: 42 }) } },
        { keyIdByHash: known, hashKey },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.message).toBe("[usage-key-identity] malformed embedded apiKey");
    expect(thrown?.message).not.toContain(sentinelRaw);
    expect(thrown?.message).not.toContain(sentinelKey);
  });

  it("converts raws that merely look like known IDs or historical pseudonyms", () => {
    const lookalike = {
      byApiKey: {
        "key-id-A|gpt-4o|openai": counterBucket({ apiKey: "key-id-A" }),
        [`${expectedPseudo(RAW_B)}|gpt-4o|openai`]: counterBucket({
          apiKey: expectedPseudo(RAW_B),
        }),
      },
    };
    const out = convertUsageDailyKeys(lookalike, { keyIdByHash: known, hashKey });
    // Both creds were raw strings in legacy source: re-derived, never passed
    // through by shape. key-id-A is not a digest-known raw, so it pseudonymizes.
    expect(Object.keys(out.byApiKey).sort()).toEqual(
      [
        `${expectedPseudo("key-id-A")}|gpt-4o|openai`,
        `${expectedPseudo(expectedPseudo(RAW_B))}|gpt-4o|openai`,
      ].sort(),
    );
    expect(out.byApiKey[`${expectedPseudo("key-id-A")}|gpt-4o|openai`].apiKey).toBe(
      expectedPseudo("key-id-A"),
    );
  });

  it("merges colliding rekeyed rows by summing counters", () => {
    const bothToA = new Map(known);
    bothToA.set(byDigest(RAW_C), "key-id-A");
    const dupe = {
      requests: 2,
      byApiKey: {
        [`${RAW_A}|gpt-4o|openai`]: counterBucket({ apiKey: RAW_A }),
        [`${RAW_C}|gpt-4o|openai`]: counterBucket({
          requests: 4,
          promptTokens: 40,
          completionTokens: 4,
          cachedTokens: 1,
          cost: 2,
          apiKey: RAW_C,
        }),
      },
    };
    const out = convertUsageDailyKeys(dupe, { keyIdByHash: bothToA, hashKey });
    expect(Object.keys(out.byApiKey)).toEqual(["key-id-A|gpt-4o|openai"]);
    expect(out.byApiKey["key-id-A|gpt-4o|openai"]).toMatchObject({
      requests: 5,
      promptTokens: 50,
      completionTokens: 9,
      cachedTokens: 3,
      cost: 2.5,
    });
  });

  it("fails closed on malformed day/byApiKey shapes and non-object buckets", () => {
    expect(() => convertUsageDailyKeys(null, { keyIdByHash: known, hashKey })).toThrow(
      /malformed day/,
    );
    expect(() =>
      convertUsageDailyKeys({ byApiKey: "oops" }, { keyIdByHash: known, hashKey }),
    ).toThrow(/malformed byApiKey/);
    expect(() =>
      convertUsageDailyKeys(
        { byApiKey: { [`${RAW_B}|gpt-4o|openai`]: "junk" } },
        { keyIdByHash: known, hashKey },
      ),
    ).toThrow(/malformed byApiKey bucket/);
    // Missing byApiKey section on a well-formed day is not malformed.
    expect(convertUsageDailyKeys({ requests: 1 }, { keyIdByHash: known, hashKey })).toEqual({
      requests: 1,
    });
  });

  it("throws on invalid sourceStorage enum and invalid hashKey without mutating input", () => {
    const src = day();
    expect(() =>
      convertUsageDailyKeys(src, { sourceStorage: "bogus", keyIdByHash: known, hashKey }),
    ).toThrow(/invalid sourceStorage/);
    expect(() => convertUsageDailyKeys(src, { keyIdByHash: known })).toThrow(/32-byte/);
    expect(src.byApiKey[`${RAW_A}|gpt-4o|openai`].apiKey).toBe(RAW_A);
  });
});

describe("convertUsageDailyKeys (sourceStorage: hashed)", () => {
  it("passes already-converted data through unchanged, even with a changed/empty id map", () => {
    const converted = convertUsageDailyKeys(
      {
        byApiKey: {
          [`${RAW_A}|gpt-4o|openai`]: counterBucket({ apiKey: RAW_A }),
          [`${RAW_B}|gpt-4o|openai`]: counterBucket({ apiKey: RAW_B }),
          "local-no-key|gpt-4o-mini|openai": counterBucket({
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            cost: 0,
            rawModel: "gpt-4o-mini",
            apiKey: null,
          }),
        },
      },
      { keyIdByHash: known, hashKey },
    );
    const idB = expectedPseudo(RAW_B);
    // Rerun with a completely different (empty) map: no double-hash, no drift.
    const rerun = convertUsageDailyKeys(converted, { sourceStorage: "hashed", hashKey });
    expect(rerun).toEqual(converted);
    expect(rerun.byApiKey[`${idB}|gpt-4o|openai`].apiKey).toBe(idB);
    // And the explicit rerun must not hash even when map/hashKey would resolve.
    const rerun2 = convertUsageDailyKeys(converted, {
      sourceStorage: "hashed",
      keyIdByHash: known,
      hashKey,
    });
    expect(rerun2).toEqual(converted);
  });

  it("still validates structure in hashed mode: single-pipe and malformed credentials throw", () => {
    expect(() =>
      convertUsageDailyKeys(
        { byApiKey: { [`${RAW_B}|gpt-4o`]: counterBucket({ apiKey: RAW_B }) } },
        { sourceStorage: "hashed", keyIdByHash: known, hashKey },
      ),
    ).toThrow(/single pipe/);
    expect(() =>
      convertUsageDailyKeys(
        { byApiKey: { [`${expectedPseudo(RAW_B)}|gpt-4o|openai`]: counterBucket({ apiKey: 7 }) } },
        { sourceStorage: "hashed", keyIdByHash: known, hashKey },
      ),
    ).toThrow(/malformed embedded apiKey/);
  });

  it("does not mutate the input day in hashed mode", () => {
    const converted = convertUsageDailyKeys(
      { byApiKey: { [`${RAW_A}|gpt-4o|openai`]: counterBucket({ apiKey: RAW_A }) } },
      { keyIdByHash: known, hashKey },
    );
    const before = JSON.stringify(converted);
    convertUsageDailyKeys(converted, { sourceStorage: "hashed", hashKey });
    expect(JSON.stringify(converted)).toBe(before);
  });
});
