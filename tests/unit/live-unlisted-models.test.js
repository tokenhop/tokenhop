// Registry `liveUnlisted` models are kept for every live-catalog provider
// after a non-empty live fetch (YAN-1244), not just GLM.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  proxyAwareFetch: (url, options) => globalThis.fetch(url, options),
}));

vi.mock("open-sse/config/providerModels.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    getModelsByProviderId: (id) =>
      id === "deepseek"
        ? [
            { id: "deepseek-chat", name: "DeepSeek Chat" },
            { id: "ds-hidden", name: "DS Hidden", liveUnlisted: true, contextLength: 64000 },
            { id: "ds-static-only", name: "DS Static" },
          ]
        : original.getModelsByProviderId(id),
  };
});

import {
  clearLiveModelsCache,
  resolveLiveModels,
  withLiveUnlistedModels,
} from "@/lib/providerModels/liveResolvers.js";

let respond;
const connection = { id: "ds-1", provider: "deepseek", apiKey: "sk-ds" };

beforeEach(() => {
  clearLiveModelsCache();
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (url, init = {}) =>
    String(url).startsWith("https://api.deepseek.com/") ? respond() : nativeFetch(url, init),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("withLiveUnlistedModels", () => {
  const statics = [
    { id: "a", name: "A" },
    { id: "u", name: "U", liveUnlisted: true, kind: "llm" },
  ];

  it("appends flagged registry models once, with their metadata", () => {
    expect(withLiveUnlistedModels("x", [{ id: "a", name: "A" }], statics)).toEqual([
      { id: "a", name: "A" },
      { id: "u", name: "U", liveUnlisted: true, kind: "llm" },
    ]);
  });

  it("does not duplicate a flagged model the live list already has", () => {
    const live = [{ id: "u", name: "Live U" }];
    expect(withLiveUnlistedModels("x", live, statics)).toEqual(live);
  });

  it("matches a prefixed live id (qoder/<key>) to its bare registry id", () => {
    const live = [{ id: "qoder/u", name: "U" }];
    expect(withLiveUnlistedModels("qoder", live, statics)).toEqual(live);
  });

  it("leaves an empty live list empty", () => {
    expect(withLiveUnlistedModels("x", [], statics)).toEqual([]);
  });
});

describe("resolveLiveModels", () => {
  it("keeps a liveUnlisted model for a non-GLM provider; unflagged statics drop", async () => {
    respond = () => Response.json({ data: [{ id: "deepseek-chat" }, { id: "ds-new" }] });
    const { models, warning } = await resolveLiveModels(connection);
    expect(warning).toBeUndefined();
    expect(models.map((m) => m.id)).toEqual(["deepseek-chat", "ds-new", "ds-hidden"]);
    expect(models[2]).toEqual({
      id: "ds-hidden",
      name: "DS Hidden",
      liveUnlisted: true,
      contextLength: 64000,
    });
  });

  it("empty and failed live lists keep the warning and add nothing", async () => {
    respond = () => Response.json({ data: [] });
    expect(await resolveLiveModels(connection)).toEqual({
      models: [],
      warning: "DeepSeek returned no live models.",
    });
    respond = () => new Response("nope", { status: 500 });
    const failed = await resolveLiveModels(connection);
    expect(failed.models).toEqual([]);
    expect(failed.warning).toMatch(/500/);
  });
});
