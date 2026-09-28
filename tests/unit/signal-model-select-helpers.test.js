import { describe, expect, it } from "vitest";
import {
  filterActiveProviders,
  filterCombos,
  filterGroupedModels,
  filterModelsByKind,
  groupModels,
  kindFilteredNoAuthIds,
  liveCatalogRequestKey,
  modelChoiceValue,
  sortModels,
  sortProviderIds,
} from "../../src/shared/components/modelSelect/modelSelectHelpers.js";

const getModelKind = (model) => model?.kind || model?.type || null;

const aiProviders = {
  searchy: { serviceKinds: ["webSearch"] },
  talky: { serviceKinds: ["llm"] },
  voicy: { serviceKinds: ["llm", "tts"] },
};

describe("model select helpers", () => {
  it("keeps providers whose service kind matches", () => {
    const active = [{ provider: "searchy" }, { provider: "talky" }];
    expect(filterActiveProviders(active, null, aiProviders)).toEqual(active);
    expect(filterActiveProviders(active, "webSearch", aiProviders)).toEqual([
      { provider: "searchy" },
    ]);
    expect(filterActiveProviders([{ provider: "missing" }], "llm", aiProviders)).toEqual([
      { provider: "missing" },
    ]);
  });

  it("filters no-auth ids by kind and sorts unknown providers last", () => {
    expect(kindFilteredNoAuthIds(["talky", "searchy"], "webSearch", aiProviders)).toEqual([
      "searchy",
    ]);
    expect(kindFilteredNoAuthIds(["talky"], null, aiProviders)).toEqual(["talky"]);
    expect(sortProviderIds(["zed", "talky", "searchy"], ["searchy", "talky"])).toEqual([
      "searchy",
      "talky",
      "zed",
    ]);
  });

  it("keeps llm and custom models unless a typed kind is requested", () => {
    const models = [
      { id: "a", kind: "llm" },
      { id: "b", kind: "image" },
      { id: "c", isCustom: true, kind: "imageToText" },
      { id: "d", isPlaceholder: true, kind: "tts" },
      { id: "e" },
    ];
    expect(filterModelsByKind(models, null, getModelKind).map((m) => m.id)).toEqual([
      "a",
      "c",
      "d",
      "e",
    ]);
    expect(filterModelsByKind(models, "image", getModelKind).map((m) => m.id)).toEqual(["b", "d"]);
    expect(filterModelsByKind(models, "webSearch", getModelKind)).toEqual(models);
  });

  it("hides combos for typed or capability pickers and matches names", () => {
    const combos = [{ name: "Alpha" }, { name: "beta-mix" }];
    expect(filterCombos(combos, "", "image", null)).toEqual([]);
    expect(filterCombos(combos, "", null, "vision")).toEqual([]);
    expect(filterCombos(combos, "bet", null, null)).toEqual([{ name: "beta-mix" }]);
    expect(filterCombos(combos, "  BET", null, null)).toEqual([]);
    expect(filterCombos(combos, " ", null, null)).toEqual(combos);
  });

  it("floats added models then sorts each side by name", () => {
    const models = [
      { name: "zeta", value: "z" },
      { name: "alpha", value: "a" },
      { name: "mid", value: "m" },
    ];
    expect(sortModels(models, ["z", "m"]).map((m) => m.value)).toEqual(["m", "z", "a"]);
  });

  it("filters groups by capability and search, keeping a name-matched empty group", () => {
    const grouped = {
      acme: {
        name: "Acme",
        models: [
          { id: "see", name: "See", value: "acme/see" },
          { id: "hear", name: "Hear", value: "acme/hear" },
        ],
      },
    };
    const caps = { "acme/see": { vision: true } };
    const seen = filterGroupedModels(grouped, {
      searchQuery: "",
      capFilter: "vision",
      getCaps: (value) => caps[value],
      addedModelValues: [],
    });
    expect(seen.acme.models.map((m) => m.id)).toEqual(["see"]);

    const named = filterGroupedModels(grouped, {
      searchQuery: "acme",
      capFilter: null,
      getCaps: () => null,
      addedModelValues: ["acme/hear"],
    });
    expect(named.acme.models).toEqual([]);

    const byId = filterGroupedModels(grouped, {
      searchQuery: "hear",
      capFilter: null,
      getCaps: () => null,
      addedModelValues: ["acme/hear"],
    });
    expect(byId.acme.models.map((m) => m.id)).toEqual(["hear"]);

    const missed = filterGroupedModels(grouped, {
      searchQuery: "nope",
      capFilter: null,
      getCaps: () => null,
      addedModelValues: [],
    });
    expect(missed).toEqual({});
  });

  it("builds a provider-as-model group and drops disabled ids", () => {
    const groups = groupModels({
      filteredActiveProviders: [{ provider: "searchy" }],
      activeProviders: [{ provider: "searchy" }],
      kindFilter: "webSearch",
      modelAliases: {},
      allProviders: { searchy: { name: "Searchy", color: "#111" } },
      providerNodes: [],
      customModels: [],
      disabledModels: {},
      liveCatalogs: {},
      providerOrder: ["searchy"],
      noAuthIds: [],
      getModelKind,
      getModelsByProviderId: () => [],
      getProviderAlias: (id) => id,
      isOpenAICompatibleProvider: () => false,
      isAnthropicCompatibleProvider: () => false,
      mergeLiveWithStatic: (_id, live) => live || [],
    });
    expect(groups.searchy.models).toEqual([{ id: "searchy", name: "Searchy", value: "searchy" }]);

    const disabled = groupModels({
      filteredActiveProviders: [{ provider: "talky" }],
      activeProviders: [{ provider: "talky" }],
      kindFilter: null,
      modelAliases: {},
      allProviders: { talky: { name: "Talky", color: "#222" } },
      providerNodes: [],
      customModels: [],
      disabledModels: { talky: ["gone"] },
      liveCatalogs: {},
      providerOrder: ["talky"],
      noAuthIds: [],
      getModelKind,
      getModelsByProviderId: () => [
        { id: "keep", name: "Keep" },
        { id: "gone", name: "Gone" },
      ],
      getProviderAlias: (id) => id,
      isOpenAICompatibleProvider: () => false,
      isAnthropicCompatibleProvider: () => false,
      mergeLiveWithStatic: (_id, live, staticModels) => (live?.length ? live : staticModels),
    });
    expect(disabled.talky.models.map((m) => m.id)).toEqual(["keep"]);
  });

  it("shows a placeholder for a connected compatible provider with no models", () => {
    const groups = groupModels({
      filteredActiveProviders: [{ provider: "openai-compatible-x", name: "Mine" }],
      activeProviders: [
        {
          provider: "openai-compatible-x",
          name: "Mine",
          providerSpecificData: { prefix: "mine" },
        },
      ],
      kindFilter: null,
      modelAliases: {},
      allProviders: { "openai-compatible-x": { name: "Compatible", color: "#333" } },
      providerNodes: [],
      customModels: [],
      disabledModels: {},
      liveCatalogs: {},
      providerOrder: [],
      noAuthIds: [],
      getModelKind,
      getModelsByProviderId: () => [],
      getProviderAlias: (id) => id,
      isOpenAICompatibleProvider: (id) => id.startsWith("openai-compatible"),
      isAnthropicCompatibleProvider: () => false,
      mergeLiveWithStatic: () => [],
    });
    expect(groups["openai-compatible-x"].models[0].isPlaceholder).toBe(true);
    expect(groups["openai-compatible-x"].alias).toBe("mine");
    expect(groups["openai-compatible-x"].name).toBe("Mine");
  });

  it("skips compatible providers for typed media kinds", () => {
    const groups = groupModels({
      filteredActiveProviders: [{ provider: "openai-compatible-x" }],
      activeProviders: [{ provider: "openai-compatible-x" }],
      kindFilter: "image",
      modelAliases: {},
      allProviders: { "openai-compatible-x": { name: "Compatible" } },
      providerNodes: [],
      customModels: [],
      disabledModels: {},
      liveCatalogs: {},
      providerOrder: [],
      noAuthIds: [],
      getModelKind,
      getModelsByProviderId: () => [],
      getProviderAlias: (id) => id,
      isOpenAICompatibleProvider: () => true,
      isAnthropicCompatibleProvider: () => false,
      mergeLiveWithStatic: () => [],
    });
    expect(groups).toEqual({});
  });

  it("falls back to the provider alias for tts when no models match", () => {
    const groups = groupModels({
      filteredActiveProviders: [{ provider: "voicy" }],
      activeProviders: [{ provider: "voicy" }],
      kindFilter: "tts",
      modelAliases: {},
      allProviders: { voicy: { name: "Voicy", serviceKinds: ["llm", "tts"], color: "#444" } },
      providerNodes: [],
      customModels: [],
      disabledModels: {},
      liveCatalogs: {},
      providerOrder: ["voicy"],
      noAuthIds: [],
      getModelKind,
      getModelsByProviderId: () => [{ id: "chat", name: "Chat", kind: "llm" }],
      getProviderAlias: () => "vc",
      isOpenAICompatibleProvider: () => false,
      isAnthropicCompatibleProvider: () => false,
      mergeLiveWithStatic: (_id, live, staticModels) => (live?.length ? live : staticModels),
    });
    expect(groups.voicy.models).toEqual([{ id: "voicy", name: "Voicy", value: "vc" }]);
  });

  it("builds the live catalog request key only for flagged connections", () => {
    const key = liveCatalogRequestKey(
      [
        { id: "c1", provider: "live" },
        { provider: "live" },
        { id: "c2", provider: "static" },
        { id: "c3", provider: "live" },
      ],
      ["live"],
    );
    expect(JSON.parse(key)).toEqual([["live", ["c1", "c3"]]]);
    expect(liveCatalogRequestKey([{ provider: "live" }], ["live"])).toBeNull();
  });

  it("reads a model choice value", () => {
    expect(modelChoiceValue({ value: "a/b", name: "n" })).toBe("a/b");
    expect(modelChoiceValue({ name: "n" })).toBe("n");
    expect(modelChoiceValue("raw")).toBe("raw");
  });
});
