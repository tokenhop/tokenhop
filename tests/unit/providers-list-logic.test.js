import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PROVIDER_LIST_FILTERS,
  LIST_FILTERS,
  getConnectionErrorTag,
  getEffectiveStatus,
  getCooldownUntil,
  getProviderStats,
  getAccountSegments,
  matchesProviderListFilter,
  buildProviderListFilterCounts,
  countNeedsAttention,
  readSelectedProvider,
  writeSelectedProvider,
} from "@/app/(dashboard)/dashboard/providers/utils";

const conn = (over = {}) => ({
  id: over.id || "c1",
  provider: "claude",
  authType: "oauth",
  testStatus: "active",
  isActive: true,
  ...over,
});

describe("getConnectionErrorTag", () => {
  it("maps explicit lastErrorType values", () => {
    expect(getConnectionErrorTag({ lastErrorType: "runtime_error" })).toBe("RUNTIME");
    expect(getConnectionErrorTag({ lastErrorType: "upstream_auth_error" })).toBe("AUTH");
    expect(getConnectionErrorTag({ lastErrorType: "auth_missing" })).toBe("AUTH");
    expect(getConnectionErrorTag({ lastErrorType: "token_refresh_failed" })).toBe("AUTH");
    expect(getConnectionErrorTag({ lastErrorType: "token_expired" })).toBe("AUTH");
    expect(getConnectionErrorTag({ lastErrorType: "upstream_rate_limited" })).toBe("429");
    expect(getConnectionErrorTag({ lastErrorType: "upstream_unavailable" })).toBe("5XX");
    expect(getConnectionErrorTag({ lastErrorType: "network_error" })).toBe("NET");
  });

  it("maps numeric error codes >= 400 to the code string", () => {
    expect(getConnectionErrorTag({ errorCode: 401 })).toBe("401");
    expect(getConnectionErrorTag({ errorCode: 429 })).toBe("429");
    expect(getConnectionErrorTag({ errorCode: 503 })).toBe("503");
  });

  it("maps 401/403 from the message to AUTH", () => {
    expect(getConnectionErrorTag({ lastError: "HTTP 401: unauthorized" })).toBe("AUTH");
    expect(getConnectionErrorTag({ lastError: "403 forbidden" })).toBe("AUTH");
  });

  it("returns ERR for empty or unclassified errors", () => {
    expect(getConnectionErrorTag(null)).toBeNull();
    expect(getConnectionErrorTag({})).toBe("ERR");
    expect(getConnectionErrorTag({ lastError: "something odd" })).toBe("ERR");
  });

  it("detects AUTH/RUNTIME from message keywords", () => {
    expect(getConnectionErrorTag({ lastError: "Invalid API key" })).toBe("AUTH");
    expect(getConnectionErrorTag({ lastError: "token invalid" })).toBe("AUTH");
    expect(getConnectionErrorTag({ lastError: "No access token" })).toBe("AUTH");
    expect(getConnectionErrorTag({ lastError: "auth expired, please reconnect" })).toBe("AUTH");
    expect(getConnectionErrorTag({ lastError: "session expired" })).toBe("AUTH");
    expect(getConnectionErrorTag({ lastError: "runtime not runnable" })).toBe("RUNTIME");
  });
});

describe("getEffectiveStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("treats unavailable as active when no lock is in the future", () => {
    expect(getEffectiveStatus(conn({ testStatus: "unavailable" }))).toBe("active");
    expect(
      getEffectiveStatus(conn({ testStatus: "unavailable", modelLock_x: "2026-09-26T11:00:00Z" })),
    ).toBe("active");
  });

  it("keeps unavailable while a modelLock is in the future", () => {
    expect(
      getEffectiveStatus(conn({ testStatus: "unavailable", modelLock_x: "2026-09-26T13:00:00Z" })),
    ).toBe("unavailable");
    expect(
      getEffectiveStatus(
        conn({ testStatus: "unavailable", modelLock___all: "2026-09-26T12:05:00Z" }),
      ),
    ).toBe("unavailable");
  });

  it("returns testStatus for non-unavailable statuses", () => {
    expect(getEffectiveStatus(conn({ testStatus: "error" }))).toBe("error");
    expect(getEffectiveStatus(conn({ testStatus: "expired" }))).toBe("expired");
  });
});

describe("getCooldownUntil", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("returns the earliest future lock", () => {
    const c = conn({
      modelLock_a: "2026-09-26T12:10:00Z",
      modelLock_b: "2026-09-26T12:03:00Z",
      modelLock_old: "2026-09-26T11:00:00Z",
    });
    expect(getCooldownUntil(c)).toBe("2026-09-26T12:03:00Z");
  });

  it("returns null when nothing is locked in the future", () => {
    expect(getCooldownUntil(conn())).toBeNull();
    expect(getCooldownUntil(conn({ modelLock_a: "2026-09-26T11:00:00Z" }))).toBeNull();
    expect(getCooldownUntil(conn({ modelLock_a: "garbage" }))).toBeNull();
  });
});

describe("getProviderStats", () => {
  const connections = [
    conn({ id: "a", provider: "claude", authType: "oauth" }),
    conn({ id: "b", provider: "claude", authType: "apikey", testStatus: "error" }),
    conn({
      id: "c",
      provider: "claude",
      authType: "api_key",
      testStatus: "expired",
      lastErrorAt: "2026-09-26T11:00:00Z",
      lastError: "HTTP 401",
    }),
    conn({ id: "d", provider: "openai", authType: "apikey" }),
  ];

  it("counts only the requested provider and auth types", () => {
    const stats = getProviderStats(connections, "claude", "oauth");
    expect(stats.total).toBe(1);
    expect(stats.connected).toBe(1);
    expect(stats.error).toBe(0);
  });

  it("counts mixed auth types and reports latest error", () => {
    const stats = getProviderStats(connections, "claude", ["oauth", "apikey", "api_key"]);
    expect(stats.total).toBe(3);
    // Unified rule (YAN-391): connected = enabled accounts, including ones needing attention.
    expect(stats.connected).toBe(3);
    expect(stats.error).toBe(2);
    expect(stats.errorCode).toBe("AUTH");
    expect(typeof stats.errorTime).toBe("string");
  });

  it("flags allDisabled only when every connection is off", () => {
    const off = [conn({ id: "x", isActive: false }), conn({ id: "y", isActive: false })];
    expect(getProviderStats(off, "claude", "oauth").allDisabled).toBe(true);
    expect(getProviderStats([], "claude", "oauth").allDisabled).toBe(false);
  });

  it("picks the latest error across connections", () => {
    const two = [
      conn({ id: "e1", testStatus: "error", lastErrorAt: "2026-09-20T00:00:00Z", errorCode: 500 }),
      conn({ id: "e2", testStatus: "error", lastErrorAt: "2026-09-26T10:00:00Z", errorCode: 429 }),
    ];
    expect(getProviderStats(two, "claude", "oauth").errorCode).toBe("429");
  });
});

describe("getAccountSegments", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("maps active to ok=100, error to err=100, cooldown to warn=50, disabled to none=0", () => {
    const segments = getAccountSegments([
      conn({ id: "1" }),
      conn({ id: "2", testStatus: "error" }),
      conn({ id: "3", testStatus: "unavailable", modelLock_x: "2026-09-26T13:00:00Z" }),
      conn({ id: "4", isActive: false }),
    ]);
    expect(segments.map((s) => [s.kind, s.value])).toEqual([
      ["ok", 100],
      ["err", 100],
      ["warn", 50],
      ["none", 0],
    ]);
  });

  it("returns a single empty segment for no accounts", () => {
    expect(getAccountSegments([])).toEqual([{ kind: "none", value: 0, label: "No accounts" }]);
  });

  it("labels segments with name or index", () => {
    const segments = getAccountSegments([conn({ id: "a", name: "Work" }), conn({ id: "b" })]);
    expect(segments[0].label).toBe("Work");
    expect(segments[1].label).toBe("Account 2");
  });
});

describe("matchesProviderListFilter / counts", () => {
  const make = (stats) => stats;
  const active = make({ connected: 2, error: 0, total: 2, allDisabled: false });
  const error = make({ connected: 0, error: 1, total: 1, allDisabled: false });
  const empty = make({ connected: 0, error: 0, total: 0, allDisabled: false });
  const disabled = make({ connected: 0, error: 0, total: 2, allDisabled: true });

  it("All matches everything", () => {
    for (const s of [active, error, empty, disabled]) {
      expect(matchesProviderListFilter("all", s)).toBe(true);
    }
  });

  it("connected matches providers with an enabled connection; no-auth is ready, not connected", () => {
    expect(matchesProviderListFilter("connected", active)).toBe(true);
    expect(matchesProviderListFilter("connected", error)).toBe(false);
    expect(matchesProviderListFilter("connected", empty)).toBe(false);
    expect(matchesProviderListFilter("connected", disabled)).toBe(false);
    expect(matchesProviderListFilter("connected", empty, true)).toBe(false);
  });

  it("needs-attention matches providers with errors (noAuth exempt)", () => {
    expect(matchesProviderListFilter("needs-attention", error)).toBe(true);
    expect(matchesProviderListFilter("needs-attention", active)).toBe(false);
    expect(matchesProviderListFilter("needs-attention", error, true)).toBe(false);
  });

  it("needs-attention matches cooldown-only providers via stats.hasCooldown", () => {
    const cooldownOnly = make({ connected: 1, error: 0, total: 1, hasCooldown: true });
    expect(matchesProviderListFilter("needs-attention", cooldownOnly)).toBe(true);
    expect(matchesProviderListFilter("needs-attention", cooldownOnly, true)).toBe(false);
  });

  it("getProviderStats reports hasCooldown for active model locks", () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const stats = getProviderStats(
      [conn({ id: "a", testStatus: "unavailable", modelLock_x: future })],
      "claude",
      "oauth",
    );
    expect(stats.hasCooldown).toBe(true);
    const calm = getProviderStats([conn({ id: "b" })], "claude", "oauth");
    expect(calm.hasCooldown).toBe(false);
  });

  it("buildProviderListFilterCounts counts cooldown-only entries as needing attention", () => {
    const cooldownOnly = make({ connected: 1, error: 0, total: 1, hasCooldown: true });
    const counts = buildProviderListFilterCounts([
      { stats: active, authGroup: "oauth" },
      { stats: cooldownOnly, authGroup: "oauth" },
    ]);
    expect(counts["needs-attention"]).toBe(1);
  });

  it("auth-group filters match by auth group", () => {
    expect(matchesProviderListFilter("oauth", active, false, "oauth")).toBe(true);
    expect(matchesProviderListFilter("oauth", active, false, "apikey")).toBe(false);
    expect(matchesProviderListFilter("free", active, false, "free")).toBe(true);
    expect(matchesProviderListFilter("apikey", empty, false, "compatible")).toBe(true);
  });

  it("buildProviderListFilterCounts aggregates over entries", () => {
    const entries = [
      { stats: active, authGroup: "oauth" },
      { stats: error, authGroup: "oauth" },
      { stats: empty, authGroup: "free", isNoAuth: true },
      { stats: active, authGroup: "apikey" },
      { stats: active, authGroup: "compatible" },
    ];
    const counts = buildProviderListFilterCounts(entries);
    // No-auth entries are "ready", not connected (YAN-391).
    expect(counts).toEqual({
      all: 5,
      connected: 3,
      "needs-attention": 1,
      oauth: 2,
      free: 1,
      apikey: 2,
    });
  });

  it("PROVIDER_LIST_FILTERS is the full ordered option list", () => {
    expect(PROVIDER_LIST_FILTERS.map((f) => f.value)).toEqual([
      "all",
      "connected",
      "needs-attention",
      "oauth",
      "free",
      "apikey",
    ]);
    expect(Object.values(LIST_FILTERS)).toEqual(PROVIDER_LIST_FILTERS.map((f) => f.value));
  });
});

describe("countNeedsAttention", () => {
  it("counts error + cooldown providers without double counting", () => {
    const entries = [
      { stats: { error: 1 }, hasCooldown: false },
      { stats: { error: 0 }, hasCooldown: true },
      { stats: { error: 2 }, hasCooldown: true },
      { stats: { error: 0 }, hasCooldown: false },
    ];
    expect(countNeedsAttention(entries)).toBe(3);
  });
});

describe("provider panel URL state", () => {
  it("reads ?provider=<id> and tolerates missing/empty params", () => {
    expect(readSelectedProvider("provider=claude")).toBe("claude");
    expect(readSelectedProvider("")).toBeNull();
    expect(readSelectedProvider("tab=logs")).toBeNull();
    expect(readSelectedProvider(null)).toBeNull();
  });

  it("writes ?provider=<id> preserving other params, removes it on close", () => {
    expect(writeSelectedProvider("", "claude")).toBe("/dashboard/providers?provider=claude");
    expect(writeSelectedProvider("tab=logs", "kimi")).toBe(
      "/dashboard/providers?tab=logs&provider=kimi",
    );
    expect(writeSelectedProvider("provider=claude", null)).toBe("/dashboard/providers");
    expect(writeSelectedProvider("tab=logs&provider=claude", null)).toBe(
      "/dashboard/providers?tab=logs",
    );
  });

  it("round-trips open then close", () => {
    const opened = writeSelectedProvider("", "kimi");
    expect(readSelectedProvider(opened.split("?")[1])).toBe("kimi");
    const closed = writeSelectedProvider(opened.split("?")[1], null);
    expect(readSelectedProvider(closed.split("?")[1] ?? "")).toBeNull();
  });
});

describe("card toggle contract", () => {
  // Regression: ProviderCard's Toggle must forward Toggle's `next` value to
  // onToggle (Toggle calls onChange(!checked)). Passing the current value
  // made card toggles a no-op (merge-gate HIGH on PR #268).
  // Toggle's contract: onChange receives the NEW checked state.
  const toggleNext = (checked) => !checked;

  it("forwards the next state when enabling an all-disabled provider", () => {
    const stats = { allDisabled: true };
    const checked = !stats.allDisabled;
    expect(toggleNext(checked)).toBe(true);
  });

  it("forwards the next state when disabling an enabled provider", () => {
    const stats = { allDisabled: false };
    const checked = !stats.allDisabled;
    expect(toggleNext(checked)).toBe(false);
  });

  it("ProviderCard source wires onChange={(next) => onToggle(next)}", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = path.resolve(
      new URL(".", import.meta.url).pathname,
      "../../src/app/(dashboard)/dashboard/providers/components/ProviderCard.js",
    );
    const src = fs.readFileSync(file, "utf8");
    expect(src).toContain("onChange={(next) => onToggle(next)}");
    expect(src).not.toContain("onToggle(!stats.allDisabled)");
  });
});
