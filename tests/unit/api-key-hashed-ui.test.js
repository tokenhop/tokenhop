// YAN-363 dashboard key UI contract: hashed-storage helpers, context bootstrap
// mapping (fail-closed), and the render contracts the hashed UI promises
// (prefix-only rows, no reveal/copy affordances, capability gating) plus the
// legacy paths that must stay unchanged.
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import {
  isHashedRow,
  formatPrefix,
  duplicateKeyLabel,
  isKeyExpired,
  formatExpiry,
  scopeSummary,
  parseModelScope,
  parseComboScope,
  expiryToIso,
  validateExpiry,
  maskKey,
} from "@/app/(dashboard)/dashboard/endpoint/endpointLogic";
import {
  loadKeyContext,
  loadKeyList,
  acknowledgeMigration,
} from "@/app/(dashboard)/dashboard/endpoint/hooks/useApiKeys";
import { groupKeys } from "@/app/(dashboard)/dashboard/endpoint/keyGroups";
import { parseKeyBudget } from "@/app/(dashboard)/dashboard/endpoint/keyBudget";
import { keyRowDisplay, maskApiKey } from "@/app/(dashboard)/dashboard/home/format";

const ROOT = new URL("../../", import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, ROOT), "utf8");

/** Queue of { status, body } responses; records every fetch URL. */
function mockFetch(responses) {
  const calls = [];
  global.fetch = vi.fn(async (url) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
  global.fetch = undefined;
});

describe("isHashedRow / formatPrefix", () => {
  it("detects prefix-only rows (hashed metadata, no raw key)", () => {
    expect(isHashedRow({ prefix: "th_abc12…wxyz" })).toBe(true);
    expect(isHashedRow({ prefix: "th_abc12…wxyz", key: "th_secret" })).toBe(false);
    expect(isHashedRow({ key: "sk-legacy" })).toBe(false);
    expect(isHashedRow(null)).toBe(false);
  });

  it("renders stored prefixes verbatim, never re-masks them", () => {
    expect(formatPrefix("th_abc12…wxyz")).toBe("th_abc12…wxyz");
    expect(formatPrefix("")).toBe("—");
    expect(formatPrefix(null)).toBe("—");
    expect(formatPrefix(undefined)).toBe("—");
  });
});

describe("duplicateKeyLabel keeps last-4 disambiguation", () => {
  const keys = [
    { name: "dup", key: "sk-aaaaaaaabbbb" },
    { name: "dup", prefix: "th_qqq11…9999" },
    { name: "unique" },
  ];

  it("uses the raw key last 4 for legacy rows", () => {
    expect(duplicateKeyLabel(keys[0], keys)).toBe("dup …bbbb");
  });

  it("falls back to the stored prefix last 4 for hashed rows", () => {
    expect(duplicateKeyLabel(keys[1], keys)).toBe("dup …9999");
  });

  it("leaves unique names untouched", () => {
    expect(duplicateKeyLabel(keys[2], keys)).toBe("unique");
  });
});

describe("expiry helpers (expire at equality)", () => {
  it("isKeyExpired: null never expires, equality expires, future does not", () => {
    expect(isKeyExpired(null)).toBe(false);
    expect(isKeyExpired(undefined)).toBe(false);
    const at = "2026-01-01T00:00:00.000Z";
    expect(isKeyExpired(at, Date.parse(at))).toBe(true);
    expect(isKeyExpired(at, Date.parse(at) - 1)).toBe(false);
    expect(isKeyExpired("2099-01-01T00:00:00.000Z", Date.parse(at))).toBe(false);
  });

  it("formatExpiry: Never for unrestricted, localized date otherwise", () => {
    expect(formatExpiry(null)).toBe("Never");
    expect(formatExpiry("")).toBe("Never");
    const iso = "2026-12-01T00:00:00.000Z";
    expect(formatExpiry(iso)).toBe(new Date(iso).toLocaleDateString());
    expect(formatExpiry("not-a-date")).toBe("—");
  });

  it("expiryToIso maps presets and custom dates to UTC instants", () => {
    const now = new Date("2026-10-04T00:00:00.000Z");
    expect(expiryToIso("never", "", now)).toBeNull();
    expect(expiryToIso("unknown", "", now)).toBeNull();
    expect(expiryToIso("custom", "", now)).toBeNull();
    expect(expiryToIso("7", "", now)).toBe("2026-10-11T00:00:00.000Z");
    expect(expiryToIso("30", "", now)).toBe("2026-11-03T00:00:00.000Z");
    expect(expiryToIso("90", "", now)).toBe("2027-01-02T00:00:00.000Z");
    expect(expiryToIso("custom", "2026-12-25", now)).toBe("2026-12-25T00:00:00.000Z");
  });

  it("validateExpiry rejects the past and garbage, accepts future and null", () => {
    expect(validateExpiry(null)).toBeNull();
    expect(validateExpiry("2999-01-01T00:00:00.000Z")).toBeNull();
    expect(validateExpiry("2000-01-01T00:00:00.000Z")).toBe("Expiry must be in the future");
    expect(validateExpiry("tomorrow")).toBe("Enter a valid date");
  });
});

describe("scopeSummary / parseModelScope", () => {
  it("empty scope is unrestricted", () => {
    expect(scopeSummary([])).toBe("All models");
    expect(scopeSummary(null)).toBe("All models");
    expect(scopeSummary(undefined)).toBe("All models");
    expect(scopeSummary(["openai/gpt-4o"])).toBe("1 model");
    expect(scopeSummary(["a", "b", "c"])).toBe("3 models");
  });

  it("combo scope rides along in the summary only when present", () => {
    expect(scopeSummary([], [])).toBe("All models");
    expect(scopeSummary(["m"], ["c1"])).toBe("1 model · 1 combo");
    expect(scopeSummary(null, ["a", "b"])).toBe("All models · 2 combos");
  });

  it("parses comma/space separated model ids", () => {
    expect(parseModelScope("")).toEqual({ models: null, error: null });
    expect(parseModelScope("   ")).toEqual({ models: null, error: null });
    expect(parseModelScope("openai/gpt-4o, anthropic/claude")).toEqual({
      models: ["openai/gpt-4o", "anthropic/claude"],
      error: null,
    });
    expect(parseModelScope("a\nb c")).toEqual({ models: ["a", "b", "c"], error: null });
  });

  it("enforces the server bounds (128 entries, 256 chars)", () => {
    const tooMany = Array.from({ length: 129 }, (_, i) => `m${i}`).join(" ");
    expect(parseModelScope(tooMany).error).toBe("Limit to 128 models or fewer");
    expect(parseModelScope("x".repeat(257)).error).toBe(
      "Model names must be 256 characters or fewer",
    );
  });

  it("parseComboScope shares bounds and combo-named errors", () => {
    expect(parseComboScope("")).toEqual({ combos: null, error: null });
    expect(parseComboScope("fast-cheap, balanced")).toEqual({
      combos: ["fast-cheap", "balanced"],
      error: null,
    });
    const tooMany = Array.from({ length: 129 }, (_, i) => `c${i}`).join(" ");
    expect(parseComboScope(tooMany).error).toBe("Limit to 128 combos or fewer");
    expect(parseComboScope("x".repeat(257)).error).toBe(
      "Combo names must be 256 characters or fewer",
    );
  });
});

describe("maskKey stays legacy-exact", () => {
  it("masks long raw keys showing prefix and last 4", () => {
    expect(maskKey("sk-7d189a0934a299d0-59pm05-08db2e01")).toBe("sk-7d1••••2e01");
    expect(maskKey("short")).toBe("short");
  });
});

describe("loadKeyContext", () => {
  it("401 (pristine off, no principal) maps to the legacy context", async () => {
    mockFetch([{ status: 401, body: { error: "Unauthorized" } }]);
    await expect(loadKeyContext()).resolves.toEqual({
      storage: "legacy",
      workspaceId: null,
      canCreate: true,
      canManage: true,
      canCreateService: false,
    });
  });

  it("maps a hashed context with strict boolean capabilities + ack flag", async () => {
    mockFetch([
      {
        status: 200,
        body: {
          storage: "hashed",
          workspaceId: "ws_1",
          canCreate: true,
          canManage: false,
          canCreateService: false,
          migrationAcknowledged: false,
        },
      },
    ]);
    await expect(loadKeyContext()).resolves.toEqual({
      storage: "hashed",
      workspaceId: "ws_1",
      canCreate: true,
      canManage: false,
      canCreateService: false,
      migrationAcknowledged: false,
    });
    // Absent flag means unacknowledged — never undefined leaking into render.
    mockFetch([
      {
        status: 200,
        body: { storage: "hashed", workspaceId: "ws_1", canCreate: true, canManage: true },
      },
    ]);
    await expect(loadKeyContext()).resolves.toMatchObject({ migrationAcknowledged: false });
  });

  it("rejects hashed context without a workspaceId", async () => {
    mockFetch([{ status: 200, body: { storage: "hashed", workspaceId: null } }]);
    await expect(loadKeyContext()).rejects.toThrow();
  });

  it("server failure fails closed instead of guessing privileges", async () => {
    mockFetch([{ status: 500, body: { error: "boom" } }]);
    await expect(loadKeyContext()).rejects.toThrow();
  });
});

describe("loadKeyList", () => {
  it("hashed viewers never probe the key list", async () => {
    const calls = mockFetch([]);
    await expect(
      loadKeyList({ storage: "hashed", workspaceId: "ws_1", canManage: false }),
    ).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("hashed members list their own keys and treat 403 as empty", async () => {
    const calls = mockFetch([
      { status: 200, body: { keys: [{ id: "mine", prefix: "th_m…e" }], storage: "hashed" } },
      { status: 403, body: { error: "Not allowed to list keys" } },
    ]);
    const ctx = { storage: "hashed", workspaceId: "ws_1", canCreate: true, canManage: false };
    await expect(loadKeyList(ctx)).resolves.toEqual([{ id: "mine", prefix: "th_m…e" }]);
    await expect(loadKeyList(ctx)).resolves.toEqual([]);
    expect(calls).toEqual(["/api/keys?workspaceId=ws_1", "/api/keys?workspaceId=ws_1"]);
  });

  it("hashed managers list through the scoped URL", async () => {
    const calls = mockFetch([
      { status: 200, body: { keys: [{ id: "k1", prefix: "th_a…b" }], storage: "hashed" } },
    ]);
    const rows = await loadKeyList({
      storage: "hashed",
      workspaceId: "ws 1",
      canManage: true,
    });
    expect(rows).toEqual([{ id: "k1", prefix: "th_a…b" }]);
    expect(calls).toEqual(["/api/keys?workspaceId=ws%201"]);
  });

  it("legacy uses the unchanged unscoped URL", async () => {
    const calls = mockFetch([{ status: 200, body: { keys: [{ id: "k1", key: "sk-x" }] } }]);
    const rows = await loadKeyList({ storage: "legacy", canManage: true });
    expect(rows).toEqual([{ id: "k1", key: "sk-x" }]);
    expect(calls).toEqual(["/api/keys"]);
  });

  it("never renders hashed metadata through the legacy fallback", async () => {
    mockFetch([
      { status: 200, body: { keys: [{ id: "k1", prefix: "th_a…b" }], storage: "hashed" } },
    ]);
    await expect(loadKeyList({ storage: "legacy", canManage: true })).rejects.toThrow();
  });
});

describe("acknowledgeMigration (spec214)", () => {
  const manager = {
    storage: "hashed",
    workspaceId: "ws 1",
    canManage: true,
  };
  const member = { storage: "hashed", workspaceId: "ws 1", canManage: false };

  it("sends the exact scoped PATCH and resolves only on the full success shape", async () => {
    const calls = mockFetch([
      {
        status: 200,
        body: { success: true, migrationAcknowledged: true, storage: "hashed" },
      },
    ]);
    await expect(acknowledgeMigration(manager)).resolves.toBeUndefined();
    expect(calls).toEqual(["/api/keys?workspaceId=ws%201"]);
  });

  it("retains the notice on non-success: members blocked client-side, failures throw", async () => {
    // Member/viewer: refused before any network call.
    const calls = mockFetch([]);
    await expect(acknowledgeMigration(member)).rejects.toThrow(
      "Only workspace managers can dismiss this notice.",
    );
    expect(calls).toHaveLength(0);
    // Server failure: nonsecret literal, no flag change implied.
    mockFetch([{ status: 403, body: { error: "Forbidden" } }]);
    await expect(acknowledgeMigration(manager)).rejects.toThrow(
      "Could not dismiss the notice. Try again.",
    );
    // Incomplete success shape (missing success/storage) also throws.
    mockFetch([{ status: 200, body: { migrationAcknowledged: true } }]);
    await expect(acknowledgeMigration(manager)).rejects.toThrow(
      "Could not dismiss the notice. Try again.",
    );
  });

  it("hydrates from a fresh context across reloads: ack persists without local state", async () => {
    mockFetch([
      {
        status: 200,
        body: {
          storage: "hashed",
          workspaceId: "ws_1",
          canCreate: true,
          canManage: true,
          migrationAcknowledged: true,
        },
      },
    ]);
    const ctx = await loadKeyContext();
    expect(ctx.migrationAcknowledged).toBe(true);
    // Notice descriptor authority: visible only while the flag is false.
    expect(ctx.migrationAcknowledged !== true).toBe(false);
  });
});

describe("home keyRowDisplay", () => {
  it("masks raw legacy keys exactly like maskApiKey", () => {
    const raw = "sk-7d189a0934a299d0-59pm05-08db2e01";
    expect(keyRowDisplay({ key: raw })).toBe(maskApiKey(raw));
  });

  it("shows the stored prefix verbatim for hashed rows", () => {
    expect(keyRowDisplay({ prefix: "th_abc12…wxyz" })).toBe("th_abc12…wxyz");
  });

  it("degrades to a dash when neither exists", () => {
    expect(keyRowDisplay({})).toBe("—");
    expect(keyRowDisplay(null)).toBe("—");
  });
});

describe("UI source contracts", () => {
  const card = [
    "src/app/(dashboard)/dashboard/endpoint/components/ApiKeysCard.js",
    "src/app/(dashboard)/dashboard/endpoint/components/ApiKeyDetails.js",
  ]
    .map(read)
    .join("\n");
  const page = [
    "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js",
    "src/app/(dashboard)/dashboard/endpoint/components/KeyCreateDialog.js",
  ]
    .map(read)
    .join("\n");
  const hook = [
    "src/app/(dashboard)/dashboard/endpoint/hooks/useApiKeys.js",
    "src/app/(dashboard)/dashboard/endpoint/hooks/keyApi.js",
  ]
    .map(read)
    .join("\n");
  const quick = read("src/app/(dashboard)/dashboard/endpoint/components/QuickConnectCard.js");
  const home = read("src/app/(dashboard)/dashboard/home/KeysSummary.js");

  it("ApiKeysCard renders stored prefixes through formatPrefix", () => {
    expect(card).toContain("formatPrefix(apiKey.prefix)");
  });

  it("ApiKeysCard keeps eye/copy affordances legacy-only (table and mobile)", () => {
    expect(card.match(/!hashedMode &&/g)?.length).toBeGreaterThanOrEqual(2);
    expect(card).toContain('visibleIds.has(apiKey.id) ? "visibility_off" : "visibility"');
  });

  it("ApiKeysCard carries the server-flag migration notice and rotation callout", () => {
    expect(card).not.toContain("localStorage");
    expect(card).toContain("notice.visible");
    expect(card).toContain("Legacy keys still work but are weaker");
    expect(card).toContain("This key expired");
  });

  it("dismissal is manager-only, hide-on-success, noninteractive for others", () => {
    // Only the manage capability may even attempt the request — helpers and
    // the hook both refuse for members/viewers before any network call.
    expect(hook).toContain('context?.storage !== "hashed" || context.canManage !== true');
    expect(hook).toContain('"Only workspace managers can dismiss this notice."');
    // Exact spec214 request shape: scoped URL + exact body + full success shape.
    expect(hook).toContain("body: JSON.stringify({ acknowledgeMigration: true })");
    expect(hook).toContain("data?.success !== true");
    expect(hook).toContain("data?.migrationAcknowledged !== true");
    // Failure retains the notice with a nonsecret literal (no raw echo).
    expect(hook).toContain('"Could not dismiss the notice. Try again."');
    // Context flag is the single authority after success.
    expect(hook).toContain("migrationAcknowledged: true");
    expect(hook).toContain("migrationAcknowledged: data.migrationAcknowledged === true");
    // Notice descriptor: members/viewers get no dismiss action.
    expect(hook).toContain("canDismiss: context?.canManage === true");
    expect(card).toContain("notice.canDismiss &&");
    expect(card).toContain("notice.dismissing");
    expect(page).toContain("migrationNotice={apiKeys.migrationNotice}");
  });

  it("EndpointPageClient gates the create flow and adds the hashed form fields", () => {
    expect(page).toContain("hashedMode={apiKeys.hashedMode}");
    expect(page).toContain("canCreate={apiKeys.capabilities.canCreate}");
    expect(page).toContain("don&apos;t have permission to create keys");
    expect(page).toContain("Key owner");
    expect(page).toContain("Limit models (optional)");
    expect(page).toContain("Limit combos (optional)");
    expect(page).toContain("apiKeys.contextReady");
  });

  it("hook fails closed before context proves itself", () => {
    const hook = read("src/app/(dashboard)/dashboard/endpoint/hooks/useApiKeys.js");
    expect(hook).toContain("context?.canCreate ?? false");
    expect(hook).toContain("context?.canManage ?? false");
  });

  it("Home create posts a name-only body with in-flight guard and reveal parsing", () => {
    expect(home).toContain("body: JSON.stringify({ name }),");
    expect(home).toContain("setSaving(true)");
    expect(home).toContain('payload?.key === "string" ? payload.key : payload?.plain || ""');
  });

  it("QuickConnectCard explains why copy is disabled in hashed mode", () => {
    expect(quick).toContain("full keys aren&apos;t stored");
    expect(quick).toContain("hashedMode && !canCopy");
  });

  it("KeysSummary consumes the shared context loader and prefix display", () => {
    expect(home).toContain('loadKeyContext, loadKeyList } from "../endpoint/hooks/useApiKeys"');
    expect(home).toContain("{keyRowDisplay(key)}");
  });

  it("KeysSummary fails closed on context error, never a silent legacy fallback", () => {
    expect(home).toContain('setCtxError("Could not load key permissions. Reload to try again.")');
  });

  it("create form state carries the combo allowlist next to models", () => {
    const hook = read("src/app/(dashboard)/dashboard/endpoint/hooks/useApiKeys.js");
    expect(hook).toContain("createCombos");
    expect(hook).toContain("parseComboScope(createCombos)");
    expect(hook).toContain("allowedCombos: comboParsed.combos ?? []");
    expect(hook).toContain("existing = await loadKeyList(ctx)");
    expect(hook).toContain('if (ctx.storage === "legacy" && existing.length === 0)');
  });

  it("key create wires an optional key-scoped budget POST with a reveal-preserving retry", () => {
    const hook = read("src/app/(dashboard)/dashboard/endpoint/hooks/useApiKeys.js");
    const budget = read("src/app/(dashboard)/dashboard/endpoint/hooks/useKeyBudget.js");
    expect(budget).toContain('import { createBudget } from "@/shared/utils/createBudget"');
    expect(budget).toContain('scopeType: "key"');
    // Partial success: reveal is set before the budget POST, which never throws.
    expect(hook).toMatch(
      /setRevealed\(\{[\s\S]*?keyBudget\.saveBudget\(keyId, budget, workspaceId\)/,
    );
    // Retry re-posts only the budget for the stored key id and its original workspace.
    expect(budget).toContain("postKeyBudget(f.keyId, f.budget, f.workspaceId)");
    expect(hook).toContain("keyBudget.resetBudgetForm()");
    expect(page).toContain("Key created, but budget was not saved");
    expect(page).toContain("Retry budget save");
    expect(page).toContain("apiKeys.budgetFailure");
    expect(page).toContain("apiKeys.retryBudget");
    expect(page).toContain("Spend limit (USD, optional)");
    expect(page).toContain("Spend window");
  });
});

describe("parseKeyBudget (key-create budget fields)", () => {
  it("empty limit means no budget POST regardless of window", () => {
    expect(parseKeyBudget("", "month")).toEqual({ budget: null, error: null });
    expect(parseKeyBudget(null, "day")).toEqual({ budget: null, error: null });
    expect(parseKeyBudget(undefined, "total")).toEqual({ budget: null, error: null });
  });

  it("accepts numeric strings and numbers as a positive finite USD limit", () => {
    expect(parseKeyBudget("12.50", "week")).toEqual({
      budget: { limitUsd: 12.5, window: "week" },
      error: null,
    });
    expect(parseKeyBudget(3, "total")).toEqual({
      budget: { limitUsd: 3, window: "total" },
      error: null,
    });
  });

  it("rejects non-positive or non-numeric limits before any key POST", () => {
    for (const bad of ["0", "-1", "abc", "  "]) {
      expect(parseKeyBudget(bad, "month").error).toBe("Enter a spend limit greater than 0.");
      expect(parseKeyBudget(bad, "month").budget).toBeNull();
    }
  });

  it("rejects unknown windows only when a limit is present", () => {
    expect(parseKeyBudget("", "year")).toEqual({ budget: null, error: null });
    expect(parseKeyBudget("5", "year").error).toBe("Unsupported budget window.");
  });
});

describe("groupKeys", () => {
  const keys = [
    { id: "a", userId: "me", type: "user" },
    { id: "b", userId: null, type: "service" },
    { id: "c", userId: "bob", type: "user" },
  ];

  it("splits hashed multi-user keys into mine, service and other users", () => {
    expect(groupKeys(keys, "me").map((g) => [g.label, g.rows.map((k) => k.id)])).toEqual([
      ["My keys", ["a"]],
      ["Workspace service keys", ["b"]],
      ["Other users' keys", ["c"]],
    ]);
  });

  it("keeps one unlabelled group without a known user and drops empty groups", () => {
    expect(groupKeys(keys, null)).toEqual([{ id: "all", label: null, rows: keys }]);
    expect(groupKeys([keys[0]], "me").map((g) => g.id)).toEqual(["mine"]);
  });
});
