// YAN-915: an old openai-compatible-chat-<uuid> node switched to completions
// must route by the node's current stored apiType when the connection's
// providerSpecificData.apiType is missing/invalid.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { nodeLookup, connections } = vi.hoisted(() => ({
  nodeLookup: vi.fn(),
  connections: { list: [] },
}));

vi.mock("@/lib/db/repos/nodesRepo.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getProviderNodeMetadataByIdUnscoped: nodeLookup,
}));

vi.mock("@/lib/localDb", async (importOriginal) => ({
  ...(await importOriginal()),
  getProviderConnectionsUnscoped: vi.fn(async () => connections.list),
}));

import { resolveOpenAICompatibleConnectionApiType } from "@/sse/services/model.js";
import { getProviderCredentials } from "@/sse/services/auth.js";

const LEGACY_ID = "openai-compatible-chat-3d8d3de8-1206-47ee-a42f-22113a5f2387";
const conn = (psd, extra = {}) => ({
  id: "c1",
  provider: LEGACY_ID,
  authType: "apikey",
  apiKey: "sk-x",
  isActive: true,
  providerSpecificData: psd,
  ...extra,
});
const node = (extra = {}) => ({
  id: LEGACY_ID,
  type: "openai-compatible",
  apiType: "completions",
  ...extra,
});

beforeEach(() => {
  nodeLookup.mockReset();
  connections.list = [];
});

describe("resolveOpenAICompatibleConnectionApiType", () => {
  it("valid providerSpecificData.apiType wins without node lookup", async () => {
    nodeLookup.mockResolvedValue(node());
    await expect(
      resolveOpenAICompatibleConnectionApiType(conn({ apiType: "responses" })),
    ).resolves.toBe("responses");
    expect(nodeLookup).not.toHaveBeenCalled();
  });

  it("stored completions node overrides legacy chat id when PSD apiType missing", async () => {
    nodeLookup.mockResolvedValue(node());
    await expect(resolveOpenAICompatibleConnectionApiType(conn({}))).resolves.toBe("completions");
    await expect(
      resolveOpenAICompatibleConnectionApiType(conn({ apiType: "bogus" })),
    ).resolves.toBe("completions");
    expect(nodeLookup).toHaveBeenCalledWith(LEGACY_ID);
  });

  it("reads the changed node on the next call (no cache)", async () => {
    nodeLookup.mockResolvedValueOnce(node({ apiType: "completions" }));
    nodeLookup.mockResolvedValueOnce(node({ apiType: "responses" }));
    expect(await resolveOpenAICompatibleConnectionApiType(conn({}))).toBe("completions");
    expect(await resolveOpenAICompatibleConnectionApiType(conn({}))).toBe("responses");
  });

  it.each([
    ["missing node", null],
    ["wrong node type", node({ type: "anthropic-compatible" })],
    ["invalid node apiType", node({ apiType: "bogus" })],
    ["undefined node apiType", node({ apiType: undefined })],
    ["workspace mismatch", node({ workspaceId: "w2" })],
  ])("falls back to id-based resolution on %s", async (_name, n) => {
    nodeLookup.mockResolvedValue(n);
    await expect(
      resolveOpenAICompatibleConnectionApiType(conn({}, { workspaceId: "w1" })),
    ).resolves.toBe("chat");
  });

  it("matches null and undefined workspace as equal", async () => {
    nodeLookup.mockResolvedValue(node({ workspaceId: null }));
    await expect(resolveOpenAICompatibleConnectionApiType(conn({}))).resolves.toBe("completions");
  });

  it("matches equal workspaces", async () => {
    nodeLookup.mockResolvedValue(node({ workspaceId: "w1" }));
    await expect(
      resolveOpenAICompatibleConnectionApiType(conn({}, { workspaceId: "w1" })),
    ).resolves.toBe("completions");
  });

  it("propagates lookup errors", async () => {
    nodeLookup.mockRejectedValue(new Error("db down"));
    await expect(resolveOpenAICompatibleConnectionApiType(conn({}))).rejects.toThrow("db down");
  });
});

describe("getProviderCredentials apiType hydration", () => {
  it("returns stored node apiType, preserves siblings, does not mutate stored connection", async () => {
    nodeLookup.mockResolvedValue(node());
    const stored = conn({ baseUrl: "https://x/v1", keep: 1 });
    connections.list = [stored];

    const creds = await getProviderCredentials(LEGACY_ID);

    expect(creds.providerSpecificData.apiType).toBe("completions");
    expect(creds.providerSpecificData.baseUrl).toBe("https://x/v1");
    expect(creds.providerSpecificData.keep).toBe(1);
    expect(stored.providerSpecificData).toEqual({ baseUrl: "https://x/v1", keep: 1 });
    expect(creds._connection).toBe(stored);
  });

  it("keeps valid PSD apiType without lookup", async () => {
    connections.list = [conn({ apiType: "responses" })];
    const creds = await getProviderCredentials(LEGACY_ID);
    expect(creds.providerSpecificData.apiType).toBe("responses");
    expect(nodeLookup).not.toHaveBeenCalled();
  });

  it("propagates lookup failure", async () => {
    nodeLookup.mockRejectedValue(new Error("db down"));
    connections.list = [conn({})];
    await expect(getProviderCredentials(LEGACY_ID)).rejects.toThrow("db down");
  });

  it("skips lookup for non openai-compatible providers", async () => {
    connections.list = [conn({}, { provider: "openai" })];
    const creds = await getProviderCredentials("openai");
    expect(creds.providerSpecificData).not.toHaveProperty("apiType");
    expect(nodeLookup).not.toHaveBeenCalled();
  });
});
