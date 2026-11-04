import { describe, it, expect } from "vitest";
import {
  CONFIG_SCHEMA_VERSION,
  buildConfigDocument,
  validateConfigDocument,
  diffConfig,
} from "@/lib/settingsConfigDoc.js";

const LIVE = {
  settings: { requireLogin: true, stickyRoundRobinLimit: 3 },
  combos: [{ id: "db-id", name: "code", kind: null, models: ["a/b"] }],
  pricingOverrides: { anthropic: { opus: { input: 1 } } },
};

const KNOWN = new Set(["requireLogin", "stickyRoundRobinLimit"]);

describe("YAN-313 config doc pure logic", () => {
  it("exports the versioned shape, portable combos, no secrets or machine-local state", () => {
    const doc = buildConfigDocument({
      settings: {
        requireLogin: true,
        password: "hash",
        oidcClientSecret: "shh",
        tunnelUrl: "https://x.trycloudflare.com",
        tunnelProvider: "cloudflare",
      },
      combos: LIVE.combos,
      pricingOverrides: LIVE.pricingOverrides,
      version: "0.4.0-test",
    });
    expect(doc.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
    expect(typeof doc.exportedAt).toBe("string");
    expect(doc.app).toEqual({ version: "0.4.0-test" });
    expect(doc.settings).toEqual({ requireLogin: true });
    expect(doc.combos).toEqual([{ name: "code", kind: null, models: ["a/b"] }]);
    expect(doc.pricingOverrides).toEqual(LIVE.pricingOverrides);
  });

  it("round-trips with zero diff", () => {
    const doc = buildConfigDocument({ ...LIVE, version: "t" });
    const checked = validateConfigDocument(JSON.parse(JSON.stringify(doc)), KNOWN);
    expect(checked.valid).toBe(true);
    expect(checked.warnings).toEqual([]);
    const diff = diffConfig(checked.doc, {
      settings: { requireLogin: true, stickyRoundRobinLimit: 3 },
      combos: LIVE.combos,
      pricingOverrides: LIVE.pricingOverrides,
    });
    expect([diff.settings.changed, diff.settings.added]).toEqual([0, 0]);
    expect(diff.settings.unchanged).toBe(2);
    expect(diff.restartRequired).toBe(false);
  });

  it("derives known keys from schema, stored extras and the registry", async () => {
    const { deriveKnownSettingKeys } = await import("@/lib/settingsConfigDoc.js");
    const { SETTINGS_SECTIONS } = await import("@/app/(dashboard)/dashboard/settings/registry.js");
    const keys = deriveKnownSettingKeys({
      defaults: { requireLogin: true },
      stored: { tunnelEnabled: false, storedExtra: 1 },
      sections: SETTINGS_SECTIONS,
    });
    // Registry rows flow through: YAN-311/312 keys are importable after rebase.
    // Env-tagged rows (requestLogsEnabled/translatorEnabled) stay importable
    // via DEFAULT_SETTINGS; resolveFlagSetting keeps the env var winning.
    for (const key of [
      "fallbackStrategy",
      "tunnelEnabled",
      "startPage",
      "uiDensity",
      "requestLogsEnabled",
      "translatorEnabled",
    ]) {
      expect(keys.has(key)).toBe(true);
    }
    // UI actions, pseudo-rows and env pins are not importable settings.
    for (const key of [
      "theme",
      "language",
      "password",
      "ssoRedirect",
      "ssoTest",
      "pricingEdit",
      "backup",
      "logout",
      "shutdown",
      "SEARXNG_URL",
    ]) {
      expect(keys.has(key)).toBe(false);
    }
    // Unknown keys still warn instead of storing.
    const checked = validateConfigDocument(
      {
        schemaVersion: 1,
        settings: { storedExtra: 1, bogus: 2 },
        combos: [],
        pricingOverrides: {},
      },
      keys,
    );
    expect(checked.valid).toBe(true);
    expect(checked.doc.settings).toEqual({ storedExtra: 1 });
    expect(checked.warnings).toEqual(['Unknown setting "bogus" ignored']);
  });

  it("redacts credentials from all URL keys and records redactedSettings", () => {
    const doc = buildConfigDocument({
      settings: {
        outboundProxyUrl: "http://alice:secret123@proxy.corp:8080",
        headroomUrl: "http://bot:token999@localhost:8787/v1",
        oidcIssuerUrl: "https://idp.corp/auth?client_secret=shh&access_token=tok123",
        samlEntryPoint: "https://idp.corp/sso?api_key=key123&password=pass",
        mitmRouterBaseUrl: "http://mitm:secret@localhost:20128",
        safeUrl: "https://safe.example.com/endpoint?search=term",
      },
      combos: [],
      pricingOverrides: {},
      version: "0.4.0",
    });
    // None of the exported URLs may carry real userinfo or secret params.
    for (const val of Object.values(doc.settings)) {
      expect(val).not.toContain("alice");
      expect(val).not.toContain("secret123");
      expect(val).not.toContain("token999");
      expect(val).not.toContain("shh");
      expect(val).not.toContain("tok123");
      expect(val).not.toContain("key123");
    }
    expect(doc.settings.outboundProxyUrl).toBe("http://***@proxy.corp:8080");
    expect(doc.settings.headroomUrl).toBe("http://***@localhost:8787/v1");
    expect(doc.settings.oidcIssuerUrl).toBe(
      "https://idp.corp/auth?client_secret=***&access_token=***",
    );
    expect(doc.settings.samlEntryPoint).toBe("https://idp.corp/sso?api_key=***&password=***");
    expect(doc.settings.mitmRouterBaseUrl).toBe("http://***@localhost:20128");
    expect(doc.settings.safeUrl).toBe("https://safe.example.com/endpoint?search=term");
    expect(doc.redactedSettings).toEqual([
      "headroomUrl",
      "mitmRouterBaseUrl",
      "oidcIssuerUrl",
      "outboundProxyUrl",
      "samlEntryPoint",
    ]);
  });

  it("round-trips masked URLs without diff or losing credentials", () => {
    const live = {
      settings: {
        outboundProxyUrl: "http://alice:secret123@proxy.corp:8080",
        oidcIssuerUrl: "https://idp.corp/auth?client_secret=shh",
      },
      combos: [],
      pricingOverrides: {},
    };
    const exported = buildConfigDocument({ ...live, version: "0.4.0" });
    const validated = validateConfigDocument(
      exported,
      new Set(["outboundProxyUrl", "oidcIssuerUrl"]),
    );
    expect(validated.valid).toBe(true);
    expect(validated.warnings).toHaveLength(2);
    // Tombstoned URLs keep the stored value: skipped on import, so the
    // validated doc carries no settings entries at all.
    expect(validated.doc.settings).toEqual({});
    // And the exported (masked) document diffs cleanly against stored values.
    const diff = diffConfig(exported, live);
    expect(diff.settings.changed).toBe(0);
    expect(diff.settings.unchanged).toBe(2);
  });

  it("rejects secrets, versions, shapes; warns unknown and machine-local", () => {
    for (const secret of ["password", "oidcClientSecret"]) {
      const bad = validateConfigDocument(
        { schemaVersion: 1, settings: { [secret]: "x" }, combos: [], pricingOverrides: {} },
        KNOWN,
      );
      expect(bad.valid).toBe(false);
    }
    expect(
      validateConfigDocument(
        { schemaVersion: 999, settings: {}, combos: [], pricingOverrides: {} },
        KNOWN,
      ).valid,
    ).toBe(false);
    expect(
      validateConfigDocument(
        { schemaVersion: 1, settings: "no", combos: [], pricingOverrides: {} },
        KNOWN,
      ).valid,
    ).toBe(false);
    expect(
      validateConfigDocument(
        {
          schemaVersion: 1,
          settings: { tunnelUrl: "x", futureKey: 1 },
          combos: [{ name: "dup", models: [] }],
          pricingOverrides: {},
        },
        KNOWN,
      ),
    ).toMatchObject({ valid: true, warnings: expect.any(Array) });
  });

  it("flags added/changed groups and restart-required settings", () => {
    const checked = validateConfigDocument(
      {
        schemaVersion: 1,
        settings: { requireLogin: false, stickyRoundRobinLimit: 3 },
        combos: [
          { name: "code", kind: null, models: ["a/c"] },
          { name: "fresh", models: [] },
        ],
        pricingOverrides: { anthropic: { opus: { input: 2 } } },
      },
      new Set(["requireLogin", "stickyRoundRobinLimit", "tunnelEnabled"]),
    );
    expect(checked.valid).toBe(true);
    const diff = diffConfig(checked.doc, {
      settings: { requireLogin: true, stickyRoundRobinLimit: 3 },
      combos: LIVE.combos,
      pricingOverrides: LIVE.pricingOverrides,
    });
    expect(diff.settings.changed).toBe(1);
    expect(diff.combos.changed).toBe(1);
    expect(diff.combos.added).toBe(1);
    expect(diff.pricing.changed).toBe(1);
  });

  it("rejects invalid combos and pricing entries", () => {
    for (const combos of [
      [{ name: "__proto__" }],
      [
        { name: "dup", models: [] },
        { name: "dup", models: [] },
      ],
      [{ name: "bad models", models: "no" }],
    ]) {
      expect(
        validateConfigDocument(
          { schemaVersion: 1, settings: {}, combos, pricingOverrides: {} },
          KNOWN,
        ).valid,
      ).toBe(false);
    }
    for (const pricingOverrides of [
      { p: { m: { input: -1 } } },
      { p: { m: { bogus: 1 } } },
      { p: "no" },
    ]) {
      expect(
        validateConfigDocument(
          { schemaVersion: 1, settings: {}, combos: [], pricingOverrides },
          KNOWN,
        ).valid,
      ).toBe(false);
    }
  });
});

// YAN-1834: budgets section (shape only; values are checked server-side).
describe("config doc budgets section", () => {
  const BUDGET = {
    scopeType: "key",
    scopeId: "k1",
    window: "day",
    limitUsd: 5,
    limitTokens: null,
    limitRequests: null,
    softLimitPct: 80,
  };

  it("projects stored budget rows onto the portable keys only", () => {
    const row = {
      ...BUDGET,
      id: "budget-1",
      workspaceId: "ws-1",
      createdByUserId: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      resetAt: "2026-01-02T00:00:00.000Z",
    };
    const doc = buildConfigDocument({ ...LIVE, budgets: [row], version: "t" });
    expect(doc.budgets).toEqual([BUDGET]);
  });

  it("an older document without budgets validates to an empty list", () => {
    const checked = validateConfigDocument({ schemaVersion: 1, settings: {} }, KNOWN);
    expect(checked.valid).toBe(true);
    expect(checked.doc.budgets).toEqual([]);
  });

  it("ignores unknown budget fields with a warning", () => {
    const checked = validateConfigDocument(
      { schemaVersion: 1, settings: {}, budgets: [{ ...BUDGET, id: "smuggled" }] },
      KNOWN,
    );
    expect(checked.valid).toBe(true);
    expect(checked.warnings).toEqual(["budgets[0]: unknown fields ignored"]);
    expect(checked.doc.budgets).toEqual([BUDGET]);
  });

  it("rejects a non-array, a non-object entry and a duplicate scope + window", () => {
    for (const budgets of [{}, ["x"], [BUDGET, { ...BUDGET, limitUsd: 1 }]]) {
      const checked = validateConfigDocument({ schemaVersion: 1, settings: {}, budgets }, KNOWN);
      expect(checked.valid).toBe(false);
    }
  });
});
