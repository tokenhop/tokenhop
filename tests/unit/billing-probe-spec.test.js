// YAN-1041 probe target coverage: max_tokens:1 is documented-safe ONLY for
// anthropic/openai/deepseek/openrouter. Selection is registry-driven (cheapest
// priced non-reasoning chat model); everything else is excluded explicitly.
import { describe, expect, it } from "vitest";

// Real pricing/capabilities maps (model-id keyed): gpt-4o-mini is the cheapest
// priced non-reasoning chat model; gpt-4o costs more; o3-mini reasons; "zzz"
// is unpriced.
const openrouterish = [
  {
    id: "openrouter",
    category: "apikey",
    transport: { format: "openai" },
    models: [
      { id: "gpt-4o" },
      { id: "gpt-4o-mini" },
      { id: "o3-mini" },
      { id: "t-1", kind: "tts" },
      { id: "zzz" },
    ],
  },
];
const entry = (extra) => [{ id: "openrouter", category: "apikey", ...extra }];

const { explainBillingProbe, resolveBillingProbeSpec, apikeyRegistryEntries, PROBE_EXCLUDED } =
  await import("../../open-sse/services/billingProbeSpec.js");
const { default: REAL } = await import("../../open-sse/providers/registry/index.js");
const { buildProbeBody } = await import("../../src/shared/services/billingProbe.js");

describe("billing probe target coverage", () => {
  it("resolves the pinned anthropic + deepseek specs and registry-driven openai", () => {
    expect(explainBillingProbe("anthropic", REAL).spec).toMatchObject({
      format: "claude",
      model: "claude-haiku-4-5-20251001",
      maxTokens: 1,
      maxTokensField: "max_tokens",
      source: "override",
    });
    expect(explainBillingProbe("deepseek", REAL)).toMatchObject({
      spec: { model: "deepseek-chat", disableThinking: true, maxTokens: 1 },
      reason: null,
    });
    const o = explainBillingProbe("openai", REAL);
    expect(o.reason).toBeNull();
    expect(o.spec).toMatchObject({
      model: "gpt-4o-mini", // cheapest priced non-reasoning
      maxTokens: 1,
      maxTokensField: "max_tokens",
      source: "registry",
    });
  });

  it("every other real registry provider is excluded with a stable reason", () => {
    const supported = new Set(["anthropic", "openai", "deepseek"]);
    const excluded = [];
    for (const e of apikeyRegistryEntries(REAL)) {
      const r = explainBillingProbe(e.id, REAL);
      if (supported.has(e.id)) expect(r.spec, e.id).toBeTruthy();
      else {
        expect(r.spec, e.id).toBeNull();
        expect(Object.values(PROBE_EXCLUDED), e.id).toContain(r.reason);
        excluded.push(e.id);
      }
    }
    // openrouter has no registry chat models (live catalog) — explicitly excluded.
    expect(explainBillingProbe("openrouter", REAL).reason).toBe(PROBE_EXCLUDED.noRegistryModels);
    // Representative non-allowlisted apikey providers (transport alone never enables min1).
    for (const id of ["groq", "mistral", "glm", "minimax", "commandcode", "perplexity-agent"]) {
      expect(excluded, id).toContain(id);
      expect(explainBillingProbe(id, REAL).reason, id).toBe(PROBE_EXCLUDED.notAllowlisted);
    }
    // OAuth/subscription claude never probes.
    expect(explainBillingProbe("claude", REAL).spec).toBeNull();
    expect(resolveBillingProbeSpec("claude", REAL)).toBeNull();
  });

  it("registry-driven selection: cheapest priced non-reasoning chat model wins", () => {
    const { spec, reason } = explainBillingProbe("openrouter", openrouterish);
    expect(reason).toBeNull();
    expect(spec.model).toBe("gpt-4o-mini");
    expect(spec.source).toBe("registry");
    // DeepSeek-style catalog without the override: never the thinking siblings.
    const ds = explainBillingProbe("openai", [
      {
        id: "openai",
        category: "apikey",
        models: [{ id: "o3-mini" }, { id: "gpt-4o" }, { id: "gpt-4o-mini" }],
      },
    ]);
    expect(ds.spec.model).toBe("gpt-4o-mini");
  });

  it("explicit exclusions per gate", () => {
    expect(
      explainBillingProbe("openrouter", [{ id: "openrouter", category: "oauth" }]).reason,
    ).toBe(PROBE_EXCLUDED.notApikey);
    expect(
      explainBillingProbe(
        "openrouter",
        openrouterish.map((r) => ({ ...r, transport: { format: "heimdall" } })),
      ).reason,
    ).toBe(PROBE_EXCLUDED.unsupportedFormat);
    expect(
      explainBillingProbe("openrouter", entry({ models: [{ id: "t-1", kind: "tts" }] })).reason,
    ).toBe(PROBE_EXCLUDED.noRegistryModels);
    expect(explainBillingProbe("openrouter", entry({ models: [{ id: "zzz" }] })).reason).toBe(
      PROBE_EXCLUDED.noPricedModel,
    );
    expect(explainBillingProbe("openrouter", entry({ models: [{ id: "o3-mini" }] })).reason).toBe(
      PROBE_EXCLUDED.noPricedModel,
    ); // reasoning-only catalog
    expect(
      explainBillingProbe("not-allowlisted", entry({ models: [{ id: "gpt-4o-mini" }] })).reason,
    ).toBe(PROBE_EXCLUDED.notAllowlisted);
  });

  it("inherited Object.prototype names never resolve as pinned overrides", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      const r = explainBillingProbe(name, REAL);
      expect(r.spec, name).toBeNull();
      expect(r.reason, name).toBe(PROBE_EXCLUDED.notAllowlisted);
    }
  });

  it("apikey-capable detection covers category + authType + authModes", () => {
    const entries = apikeyRegistryEntries([
      { id: "a" },
      { id: "b", category: "apikey" },
      { id: "c", authType: "apikey" },
      { id: "d", authModes: ["oauth", "apikey"] },
    ]);
    expect(entries.map((e) => e.id)).toEqual(["b", "c", "d"]);
  });

  it("probe bodies: min1, user-only, no tools; deepseek disables thinking", () => {
    expect(
      buildProbeBody({
        model: "deepseek-chat",
        maxTokens: 1,
        maxTokensField: "max_tokens",
        disableThinking: true,
      }),
    ).toEqual({
      model: "deepseek-chat",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      thinking: { type: "disabled" },
    });
    const body = buildProbeBody({
      model: "gpt-4o-mini",
      maxTokens: 1,
      maxTokensField: "max_tokens",
    });
    expect(body.thinking).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.messages.every((m) => m.role === "user")).toBe(true);
  });
});
