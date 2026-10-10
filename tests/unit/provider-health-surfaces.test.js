import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { providerHealth, summarizeProviders } from "@/shared/utils/providerHealth.js";
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

describe("out of credit across provider surfaces (YAN-1041)", () => {
  const lock = {
    reason: "credit_exhausted",
    nextProbeAt: "2999-01-01T00:00:00Z",
    lastProbeAt: null,
    lastProbeError: null,
  };
  const locked = (id, fields = {}) =>
    conn(id, "openai", "apikey", { billingLock: lock, ...fields });

  it("relabels a locked provider but keeps status err for ranking and counts", () => {
    const health = providerHealth([locked("a")]);
    expect(health).toMatchObject({
      status: "err",
      reason: "Out of credit",
      connected: true,
      needsAttention: true,
      outOfCredit: true,
      counts: { err: 1 },
    });
  });

  it("does not relabel a provider that mixes a lock with another error", () => {
    const mixed = providerHealth([
      locked("a"),
      conn("b", "openai", "apikey", { testStatus: "error", lastError: "Invalid API key" }),
    ]);
    expect(mixed).toMatchObject({ status: "err", outOfCredit: false, counts: { err: 2 } });
  });

  it("lets disabled win; a healthy sibling does not hide the label", () => {
    expect(providerHealth([locked("a", { isActive: false })])).toMatchObject({
      status: "off",
      outOfCredit: false,
      connected: false,
    });
    expect(providerHealth([locked("a"), conn("b", "openai", "apikey")])).toMatchObject({
      status: "err",
      outOfCredit: true,
    });
  });

  it("counts locked providers as needing attention on the list and shell", () => {
    const list = [locked("a"), conn("c", "claude", "oauth")];
    const summary = summarizeProviders([], list);
    const { counts } = providersPage(list);
    expect(summary).toMatchObject({ connected: 2, needsAttention: 1 });
    expect(counts[LIST_FILTERS.NEEDS_ATTENTION]).toBe(summary.needsAttention);
    expect(summary.providers.find((p) => p.id === "openai")).toMatchObject({ status: "err" });
  });

  it("renders Out of credit on the list pill, provider card and side panel", () => {
    const read = (rel) =>
      readFileSync(
        resolve(__dirname, "../../src/app/(dashboard)/dashboard/providers/components", rel),
        "utf8",
      );
    for (const file of ["YourProviders.js", "ProviderCard.js"]) {
      expect(read(file), file).toMatch(
        /if \(health\.outOfCredit\) return \{ variant: "err", label: "Out of credit", dot: true \}/,
      );
    }
    const panel = read("ProviderDetailSidePanel.js");
    expect(panel).toContain('health.state === "out_of_credit"');
    expect(panel).toMatch(/\? "Out of credit"/);
  });
});
