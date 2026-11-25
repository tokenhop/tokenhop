// Unit tests for pure remote quota helpers (YAN-2014) and quotaSnapshot
// count retention + globalThis sharing across module reloads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveRemoteQuotaAccounts,
  filterConnectionsByGatewayScope,
  formatRemoteQuotaWindow,
  normalizeProviderFilter,
} from "@/lib/quota/remoteQuota.js";
import {
  clearQuotaSnapshots,
  getSnapshot,
  recordHeaderWindows,
  recordProbeWindows,
} from "open-sse/services/quotaSnapshot.js";
import { QUOTA_SNAPSHOT } from "open-sse/config/quotaSnapshot.js";

const NOW_ISO = "2026-11-25T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const RESET_5H = "2026-11-25T17:00:00.000Z";
const RESET_7D = "2026-12-02T00:00:00.000Z";

beforeEach(() => {
  clearQuotaSnapshots();
});

afterEach(() => {
  clearQuotaSnapshots();
});

describe("normalizeProviderFilter", () => {
  it("normalizes canonical ids, aliases, whitespace, and empty values", () => {
    expect(normalizeProviderFilter("claude")).toBe("claude");
    expect(normalizeProviderFilter("  CC ")).toBe("claude");
    expect(normalizeProviderFilter("cx")).toBe("codex");
    expect(normalizeProviderFilter("")).toBeNull();
    expect(normalizeProviderFilter("   ")).toBeNull();
    expect(normalizeProviderFilter(null)).toBeNull();
    expect(normalizeProviderFilter(undefined)).toBeNull();
  });

  it("never resolves Object.prototype properties as provider aliases", () => {
    for (const key of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      const normalized = normalizeProviderFilter(key);
      expect(typeof normalized).toBe("string");
      expect(normalized).toBe(key.toLowerCase());
    }
  });
});

describe("filterConnectionsByGatewayScope", () => {
  const connections = [
    { id: "c1", provider: "claude" },
    { id: "c2", provider: "codex" },
    {
      id: "g1",
      provider: "claude",
      grantId: "grant-1",
      grantAllowedModels: ["claude/claude-opus-4-6"],
    },
    {
      id: "g2",
      provider: "claude",
      grantId: "grant-2",
      grantAllowedModels: null,
    },
  ];

  it("returns all connections when principal or allowedModels is empty (including combos-only keys)", () => {
    expect(filterConnectionsByGatewayScope(connections, null)).toEqual(connections);
    expect(
      filterConnectionsByGatewayScope(connections, {
        scopes: { allowedModels: [], allowedCombos: ["combo-1"] },
      }),
    ).toEqual(connections);
  });

  it("filters by canonical provider prefix, supports aliases, and checks grant model overlap", () => {
    const out = filterConnectionsByGatewayScope(connections, {
      scopes: { allowedModels: ["cc/claude-sonnet-4-6"], allowedCombos: [] },
    });
    expect(out.map((c) => c.id)).toEqual(["c1", "g2"]);
  });

  it("fails closed when all allowedModels entries are unparsable or prototype keys", () => {
    const out = filterConnectionsByGatewayScope(connections, {
      scopes: { allowedModels: ["no-slash", "constructor/foo", ""], allowedCombos: [] },
    });
    expect(out).toEqual([]);
  });
});

describe("formatRemoteQuotaWindow", () => {
  it("preserves provider counts with unit='provider' and handles overage clamping", () => {
    expect(
      formatRemoteQuotaWindow({
        usedFraction: 1,
        used: 550000,
        limit: 500000,
        resetsAt: RESET_5H,
        observedAt: NOW_MS,
      }),
    ).toEqual({
      used: 550000,
      limit: 500000,
      unit: "provider",
      percentage: 100,
      remainingPercentage: 0,
      nextReset: RESET_5H,
      observedAt: NOW_ISO,
    });
  });

  it("falls back to 0..100 percentage scale with unit='percentage' when counts are absent or invalid", () => {
    for (const invalidCounts of [
      {},
      { used: 0, limit: 0 },
      { used: -5, limit: 100 },
      { used: Number.NaN, limit: 100 },
      { used: 10, limit: -1 },
    ]) {
      expect(
        formatRemoteQuotaWindow({
          usedFraction: 0.425,
          resetsAt: Date.parse(RESET_5H),
          observedAt: NOW_MS,
          ...invalidCounts,
        }),
      ).toEqual({
        used: 42.5,
        limit: 100,
        unit: "percentage",
        percentage: 42.5,
        remainingPercentage: 57.5,
        nextReset: RESET_5H,
        observedAt: NOW_ISO,
      });
    }
  });

  it("clamps out-of-range usedFraction and rejects non-finite values", () => {
    expect(formatRemoteQuotaWindow({ usedFraction: 1.4 })).toMatchObject({
      percentage: 100,
      remainingPercentage: 0,
    });
    expect(formatRemoteQuotaWindow({ usedFraction: -0.2 })).toMatchObject({
      percentage: 0,
      remainingPercentage: 100,
    });
    expect(formatRemoteQuotaWindow({ usedFraction: Number.NaN })).toBeNull();
    expect(formatRemoteQuotaWindow(null)).toBeNull();
  });
});

describe("deriveRemoteQuotaAccounts", () => {
  it("marks tier-only and empty-window snapshots as stale: true", () => {
    recordProbeWindows("c-tier", "claude", [], { planTier: "pro" }, NOW_MS);
    const [account] = deriveRemoteQuotaAccounts(
      [{ id: "c-tier", provider: "claude", name: "claude_apple" }],
      (id) => getSnapshot(id, NOW_MS),
      NOW_MS,
    );
    expect(account).toEqual({
      id: "c-tier",
      name: "claude_apple",
      provider: "claude",
      planTier: "pro",
      fiveHour: null,
      weekly: null,
      windows: [],
      updatedAt: NOW_ISO,
      stale: true,
    });
  });

  it("enforces the exact 15-minute stale threshold using newest window observedAt", () => {
    recordHeaderWindows(
      "c-edge",
      "claude",
      [{ kind: "5h", usedFraction: 0.2, resetsAt: RESET_5H }],
      NOW_MS,
    );
    const staleMs = QUOTA_SNAPSHOT.poller.staleMs;
    const [fresh] = deriveRemoteQuotaAccounts(
      [{ id: "c-edge", provider: "claude", name: "claude_iot" }],
      (id) => getSnapshot(id, NOW_MS + staleMs - 1),
      NOW_MS + staleMs - 1,
    );
    expect(fresh.stale).toBe(false);

    const [stale] = deriveRemoteQuotaAccounts(
      [{ id: "c-edge", provider: "claude", name: "claude_iot" }],
      (id) => getSnapshot(id, NOW_MS + staleMs),
      NOW_MS + staleMs,
    );
    expect(stale.stale).toBe(true);
  });

  it("redacts email-shaped names on granted connections and keeps own-workspace email fallback", () => {
    const accounts = deriveRemoteQuotaAccounts(
      [
        { id: "own-1", provider: "claude", name: null, email: "owner@example.com" },
        {
          id: "grant-email-name",
          provider: "claude",
          name: "grantor@example.com",
          email: "grantor@example.com",
          grantId: "g1",
        },
        {
          id: "grant-label",
          provider: "claude",
          name: "Team Claude",
          email: null,
          grantId: "g2",
        },
      ],
      () => null,
      NOW_MS,
    );
    expect(accounts.map((a) => [a.id, a.name])).toEqual([
      ["own-1", "owner@example.com"],
      ["grant-email-name", "grant-email-name"],
      ["grant-label", "Team Claude"],
    ]);
  });

  it("shares the quota snapshot store via globalThis across module reloads", async () => {
    recordProbeWindows(
      "c-shared",
      "claude",
      [{ kind: "7d", usedFraction: 0.3, used: 30, limit: 100, resetsAt: RESET_7D }],
      {},
      NOW_MS,
    );
    vi.resetModules();
    const reloaded = await import("open-sse/services/quotaSnapshot.js");
    const snap = reloaded.getSnapshot("c-shared", NOW_MS);
    expect(snap).not.toBeNull();
    expect(snap.windows[0]).toMatchObject({ kind: "7d", used: 30, limit: 100 });
    reloaded.clearQuotaSnapshots();
  });
});
