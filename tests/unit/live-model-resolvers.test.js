// Shared live-model resolver (src/lib/providerModels/liveResolvers.js) as seen
// through both consumers: the dashboard's GET /api/providers/[id]/models and
// the gateway's GET /v1/models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Qoder's live catalog: one visible model plus one catalog key flagged
// enable:false, which chat still routes (see routableQoderModels).
const qoder = vi.hoisted(() => ({ resolveQoderModels: null }));
vi.mock("open-sse/services/qoderModels.js", async (importOriginal) => {
  const actual = await importOriginal();
  const { vi: vitest } = await import("vitest");
  qoder.resolveQoderModels = vitest.fn(async () => ({
    models: [{ id: "q-visible", name: "Qoder Visible", contextLength: 128000 }],
    rawConfigs: [["q-hidden", { display_name: "Qoder Hidden" }]],
  }));
  return { ...actual, resolveQoderModels: qoder.resolveQoderModels };
});

import { GET as getProviderModels } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import {
  createProviderConnectionUnscoped,
  deleteProviderConnectionsByProviderUnscoped,
} from "@/models/index.js";
import { getProviderAlias } from "@/shared/constants/providers";
import {
  clearLiveModelsCache,
  hasLiveModelResolver,
  resolveLiveModels,
} from "@/lib/providerModels/liveResolvers.js";

const CLAUDE_LIVE = {
  data: [{ id: "claude-live-9-9", display_name: "Claude Live 9.9" }],
  has_more: false,
};

let anthropicCalls;
let anthropicStatus;
beforeEach(async () => {
  clearLiveModelsCache();
  anthropicCalls = 0;
  anthropicStatus = 200;
  qoder.resolveQoderModels.mockClear();
  await deleteProviderConnectionsByProviderUnscoped("claude");
  await deleteProviderConnectionsByProviderUnscoped("qoder");
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (url, init) => {
    if (!String(url).startsWith("https://api.anthropic.com/v1/models"))
      return nativeFetch(url, init);
    anthropicCalls++;
    if (anthropicStatus !== 200) return new Response("down", { status: anthropicStatus });
    return Response.json(CLAUDE_LIVE);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function dashboardModels(connectionId, query = "") {
  const req = new Request(`http://localhost/api/providers/${connectionId}/models${query}`);
  return getProviderModels(req, { params: Promise.resolve({ id: connectionId }) });
}

const seedClaude = (providerSpecificData) =>
  createProviderConnectionUnscoped({
    provider: "claude",
    authType: "apikey",
    apiKey: `sk-ant-api03-${Date.now()}-${Math.random()}`,
    testStatus: "active",
    ...(providerSpecificData ? { providerSpecificData } : {}),
  });
const seedQoder = () =>
  createProviderConnectionUnscoped({
    provider: "qoder",
    authType: "oauth",
    accessToken: `qoder-${Date.now()}-${Math.random()}`,
    email: `qoder-${Date.now()}@example.com`,
    testStatus: "active",
  });

describe("resolver registry", () => {
  it("covers every provider moved out of the route files", () => {
    for (const id of [
      "claude",
      "codex",
      "zed",
      "kiro",
      "qoder",
      "grok-cli",
      "cursor",
      "kimchi",
      "github",
      "cline",
      "clinepass",
      "anthropic",
      "gemini",
      "gemini-cli",
      "antigravity",
      "xai",
      "openai",
      "openrouter",
      "deepseek",
      "mistral",
      "groq",
      "together",
      "fireworks",
      "cerebras",
      "perplexity-agent",
      "vercel-ai-gateway",
      "chutes",
      "nvidia",
      "nebius",
      "siliconflow",
      "hyperbolic",
      "opencode",
      "opencode-go",
      "ollama",
      "ollama-local",
      "venice",
      "bazaarlink",
      "llm7",
      "sambanova",
    ]) {
      expect(hasLiveModelResolver(id)).toBe(true);
    }
    expect(hasLiveModelResolver("cohere")).toBe(false);
    expect(hasLiveModelResolver("toString")).toBe(false);
  });

  it("never throws for an unknown provider", async () => {
    const result = await resolveLiveModels({ id: "x", provider: "nope" });
    expect(result.models).toEqual([]);
    expect(result.warning).toBeTruthy();
  });
});

describe("TTL cache", () => {
  it("serves a repeat call from cache and bypasses it on ?refresh=1", async () => {
    const conn = await seedClaude();

    expect((await (await dashboardModels(conn.id)).json()).models.map((m) => m.id)).toEqual([
      "claude-live-9-9",
    ]);
    await dashboardModels(conn.id);
    expect(anthropicCalls).toBe(1);

    const refreshed = await dashboardModels(conn.id, "?refresh=1");
    expect(refreshed.status).toBe(200);
    expect(anthropicCalls).toBe(2);
  });

  it("does not cache a failed fetch", async () => {
    const conn = await seedClaude();
    anthropicStatus = 500;
    const failed = await (await dashboardModels(conn.id)).json();
    expect(failed.models).toEqual([]);
    expect(failed.warning).toBeTruthy();

    anthropicStatus = 200;
    const recovered = await (await dashboardModels(conn.id)).json();
    expect(recovered.models.map((m) => m.id)).toEqual(["claude-live-9-9"]);
    expect(recovered.warning).toBeUndefined();
    expect(anthropicCalls).toBe(2);
  });
});

describe("Qoder hidden models", () => {
  it("are filtered from the dashboard route unless asked for, then flagged", async () => {
    const conn = await seedQoder();

    const res = await dashboardModels(conn.id);

    expect(res.status).toBe(200);
    const { models } = await res.json();
    expect(models.map((m) => m.id)).toEqual(["qoder/q-visible"]);
    expect(models[0]).toMatchObject({ name: "Qoder Visible", contextLength: 128000 });

    const all = await (await dashboardModels(conn.id, "?hidden=1")).json();
    expect(all.models.map((m) => m.id)).toEqual(["qoder/q-visible", "qoder/q-hidden"]);
    expect(all.models[0].hidden).toBeUndefined();
    expect(all.models[1]).toMatchObject({ hidden: true });
  });

  it("are still listed by /v1/models, without a doubled prefix", async () => {
    await seedQoder();
    const alias = getProviderAlias("qoder");

    const ids = (await buildModelsList(["llm"])).map((m) => m.id);

    expect(ids).toContain(`${alias}/q-visible`);
    expect(ids).toContain(`${alias}/q-hidden`);
    expect(ids.some((id) => id.includes("qoder/qoder/"))).toBe(false);
  });
});

describe("/v1/models with a live Claude catalog", () => {
  it("lists live Claude ids", async () => {
    await seedClaude();
    const alias = getProviderAlias("claude");

    const models = await buildModelsList(["llm"]);

    expect(models.map((m) => m.id)).toContain(`${alias}/claude-live-9-9`);
    expect(anthropicCalls).toBe(1);
  });

  it("respects explicit enabledModels and skips the live fetch", async () => {
    await seedClaude({ enabledModels: ["claude-opus-5"] });
    const alias = getProviderAlias("claude");

    const ids = (await buildModelsList(["llm"])).map((m) => m.id);

    expect(ids).toContain(`${alias}/claude-opus-5`);
    expect(ids).not.toContain(`${alias}/claude-live-9-9`);
    expect(anthropicCalls).toBe(0);
  });
});
