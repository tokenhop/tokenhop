// YAN-916: completions-node models stay in /v1/models with an additive
// `endpoint: '/v1/completions'` hint and cloned capabilities
// (`fim: true, tools: false, forcedToolChoice: false`); chat/responses entries
// are unchanged. Lane A owns `resolveOpenAICompatibleConnectionApiType` in
// src/sse/services/model.js, so it is mocked here to the same contract.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOpenAICompatibleConnectionApiType: vi.fn(),
}));

vi.mock("@/sse/services/model.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveOpenAICompatibleConnectionApiType: mocks.resolveOpenAICompatibleConnectionApiType,
}));

import { buildModelsList } from "@/app/api/v1/models/route.js";
import {
  createProviderConnectionUnscoped,
  deleteProviderConnectionsByProviderUnscoped,
  addCustomModelUnscoped,
} from "@/models/index.js";

const NODE_ID = "openai-compatible-completions-11111111-2222-3333-4444-555555555555";

beforeEach(async () => {
  mocks.resolveOpenAICompatibleConnectionApiType.mockReset();
  await deleteProviderConnectionsByProviderUnscoped(NODE_ID);
});

async function createNodeConn() {
  await createProviderConnectionUnscoped({
    provider: NODE_ID,
    authType: "apikey",
    apiKey: "k",
    testStatus: "active",
    providerSpecificData: {
      prefix: "fimnode",
      baseUrl: "http://localhost:9",
      enabledModels: ["qwen3-4b"],
    },
  });
}

function findEntry(models) {
  return models.find((m) => m.owned_by === "fimnode" && m.id === "fimnode/qwen3-4b");
}

describe("completions-node models hints (YAN-916)", () => {
  it("stays listed with endpoint hint and cloned FIM capabilities", async () => {
    mocks.resolveOpenAICompatibleConnectionApiType.mockResolvedValue("completions");
    await createNodeConn();
    const entry = findEntry(await buildModelsList(["llm"]));
    expect(entry).toBeTruthy();
    expect(entry.endpoint).toBe("/v1/completions");
    expect(entry.capabilities).toMatchObject({
      fim: true,
      tools: false,
      forcedToolChoice: false,
    });
  });

  it("keeps image-to-text entries in the LLM list with completions hints", async () => {
    mocks.resolveOpenAICompatibleConnectionApiType.mockResolvedValue("completions");
    await createNodeConn();
    await addCustomModelUnscoped({
      id: "vision-fim",
      providerAlias: "fimnode",
      kind: "imageToText",
    });
    const entry = (await buildModelsList(["llm"])).find((m) => m.id === "fimnode/vision-fim");
    expect(entry).toBeTruthy();
    expect(entry.endpoint).toBe("/v1/completions");
    expect(entry.capabilities).toMatchObject({ fim: true, tools: false });
  });

  it("chat entries stay unchanged when the node is not completions", async () => {
    mocks.resolveOpenAICompatibleConnectionApiType.mockResolvedValue("chat");
    await createNodeConn();
    const entry = findEntry(await buildModelsList(["llm"]));
    expect(entry).toBeTruthy();
    expect(entry).not.toHaveProperty("endpoint");
    expect(entry.capabilities?.fim).not.toBe(true);
  });
});
