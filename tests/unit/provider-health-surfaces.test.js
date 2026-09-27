import { describe, expect, it } from "vitest";
import { summarizeProviders } from "@/shared/utils/providerHealth.js";
import { PROVIDER_SECTIONS } from "@/app/(dashboard)/dashboard/providers/sections.js";
import {
  LIST_FILTERS,
  buildProviderListFilterCounts,
  getProviderStats,
  needsLookLabel,
} from "@/app/(dashboard)/dashboard/providers/utils.js";
import { repairTarget } from "@/app/(dashboard)/dashboard/providers/repairAction.js";

const conn = (id, provider, authType, fields = {}) => ({
  id,
  provider,
  authType,
  isActive: true,
  testStatus: "active",
  ...fields,
});

// Shapes from the real writers: codex import-token (access_token),
// iflow cookie route (cookie), kiro/xiaomi api-key routes (api_key),
// POST /api/providers (apikey), OAuth callbacks (oauth).
const connections = [
  conn("c1", "claude", "oauth"),
  conn("c2", "codex", "access_token", {
    testStatus: "error",
    lastError: "Token invalid or revoked",
  }),
  conn("c3", "iflow", "cookie"),
  conn("c4", "kiro", "api_key", { testStatus: "error", lastError: "Token expired" }),
  conn("c5", "openai", "apikey", { testStatus: "unknown" }),
];

function providersPage(list) {
  const sections = PROVIDER_SECTIONS({
    connections: list,
    providerNodes: [],
    statsFor: (id, types) => getProviderStats(list, id, types),
  });
  const entries = sections.flatMap((s) => s.entries);
  return { entries, counts: buildProviderListFilterCounts(entries) };
}

describe("provider health across surfaces", () => {
  it("Providers counts equal summarizeProviders for mixed auth types", () => {
    const summary = summarizeProviders([], connections);
    const { entries, counts } = providersPage(connections);

    expect(summary).toMatchObject({ connected: 5, needsAttention: 2 });
    expect(counts[LIST_FILTERS.CONNECTED]).toBe(summary.connected);
    expect(counts[LIST_FILTERS.NEEDS_ATTENTION]).toBe(summary.needsAttention);
    for (const id of ["claude", "codex", "iflow", "kiro", "openai"]) {
      expect(entries.find((e) => e.id === id)?.stats.total, id).toBe(1);
    }
  });

  it("includes a stored provider missing from the registry", () => {
    const list = [
      conn("orphan", "retired-provider", "apikey", {
        testStatus: "error",
        lastError: "Invalid API key",
      }),
    ];
    const summary = summarizeProviders([], list);
    const { entries, counts } = providersPage(list);
    expect(entries.find((e) => e.id === "retired-provider")?.stats.total).toBe(1);
    expect(counts[LIST_FILTERS.CONNECTED]).toBe(summary.connected);
    expect(counts[LIST_FILTERS.NEEDS_ATTENTION]).toBe(summary.needsAttention);
  });

  it("keeps no-auth providers ready, not connected", () => {
    const { entries, counts } = providersPage([]);
    expect(entries.some((e) => e.isNoAuth)).toBe(true);
    expect(counts[LIST_FILTERS.CONNECTED]).toBe(0);
    expect(counts[LIST_FILTERS.NEEDS_ATTENTION]).toBe(0);
  });

  it("routes repair to a flow that replaces the credential", () => {
    const failed = { testStatus: "error", lastError: "Token invalid or revoked" };
    expect(repairTarget(conn("a", "claude", "oauth", failed))).toBe("reauthorize");
    expect(repairTarget(conn("b", "openai", "apikey", failed))).toBe("edit");
    // iFlow cookie requires provider-specific cookie exchange, not a PUT key edit.
    expect(repairTarget(conn("c", "iflow", "cookie", failed))).toBe("open");
    expect(repairTarget(conn("cw", "grok-web", "cookie", failed))).toBe("edit");
    expect(repairTarget(conn("cp", "perplexity-web", "cookie", failed))).toBe("edit");
    // PUT /api/providers/[id] ignores new keys for these, so no in-place edit.
    expect(repairTarget(conn("d", "kiro", "api_key", failed))).toBe("open");
    expect(repairTarget(conn("e", "xiaomi-mimo", "api_key", failed))).toBe("open");
    expect(repairTarget(conn("f", "codex", "access_token", failed))).toBe("open");
    expect(repairTarget(conn("g", "openai", "apikey"))).toBe("open");
  });

  it("pluralises the needs-a-look count", () => {
    expect(needsLookLabel(0)).toBe("0 need a look");
    expect(needsLookLabel(1)).toBe("1 needs a look");
    expect(needsLookLabel(3)).toBe("3 need a look");
  });
});
