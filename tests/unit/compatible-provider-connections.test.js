import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setupTestContext(nodeData) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-compatible-provider-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));

  const { POST } = await import("@/app/api/providers/route.js");
  const { createProviderNode, getProviderConnections } = await import("@/models/index.js");

  const node = await createProviderNode(nodeData);

  return {
    node,
    POST,
    getProviderConnections,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function makeRequest(provider, name = "Test Connection", apiKey = "test-key") {
  return new Request("https://9router.local/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      apiKey,
      name,
      defaultModel: "test-model",
    }),
  });
}

function expectCompatibleConnection(connection, node, { apiType } = {}) {
  expect(connection.provider).toBe(node.id);
  expect(connection.authType).toBe("apikey");
  expect(connection.defaultModel).toBe("test-model");
  expect(connection.providerSpecificData).toMatchObject({
    prefix: node.prefix,
    baseUrl: node.baseUrl,
    nodeName: node.name,
  });

  if (apiType !== undefined) {
    expect(connection.providerSpecificData.apiType).toBe(apiType);
  }
}

describe("compatible provider connections API", () => {
  let cleanup = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("creates one API-key connection for an OpenAI-compatible node", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-test",
      type: "openai-compatible",
      name: "OpenAI Compatible Test Node",
      prefix: "oct",
      apiType: "chat",
      baseUrl: "https://openai-compatible.test/v1",
    });
    cleanup = ctx.cleanup;

    const response = await ctx.POST(makeRequest(ctx.node.id));
    const body = await response.json();
    const connection = body.connection;
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(response.status).toBe(201);
    expect(storedConnections).toHaveLength(1);
    expectCompatibleConnection(connection, ctx.node, { apiType: "chat" });
    expect(storedConnections[0]).toMatchObject({
      provider: ctx.node.id,
      authType: "apikey",
      defaultModel: "test-model",
      providerSpecificData: {
        prefix: ctx.node.prefix,
        apiType: "chat",
        baseUrl: ctx.node.baseUrl,
        nodeName: ctx.node.name,
      },
    });
  });

  it("creates one API-key connection for an Anthropic-compatible node", async () => {
    const ctx = await setupTestContext({
      id: "anthropic-compatible-test",
      type: "anthropic-compatible",
      name: "Anthropic Compatible Test Node",
      prefix: "act",
      baseUrl: "https://anthropic-compatible.test/v1",
    });
    cleanup = ctx.cleanup;

    const response = await ctx.POST(makeRequest(ctx.node.id));
    const body = await response.json();
    const connection = body.connection;
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(response.status).toBe(201);
    expect(storedConnections).toHaveLength(1);
    expectCompatibleConnection(connection, ctx.node);
    expect(storedConnections[0]).toMatchObject({
      provider: ctx.node.id,
      authType: "apikey",
      defaultModel: "test-model",
      providerSpecificData: {
        prefix: ctx.node.prefix,
        baseUrl: ctx.node.baseUrl,
        nodeName: ctx.node.name,
      },
    });
  });

  it("allows multiple connections on the same compatible node", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-multiple-test",
      type: "openai-compatible",
      name: "Multiple Connections Node",
      prefix: "mul",
      apiType: "chat",
      baseUrl: "https://multiple-connections.test/v1",
    });
    cleanup = ctx.cleanup;

    const firstResponse = await ctx.POST(makeRequest(ctx.node.id, "Key A"));
    const secondResponse = await ctx.POST(makeRequest(ctx.node.id, "Key B"));
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    expect(storedConnections).toHaveLength(2);
    expectCompatibleConnection(storedConnections[0], ctx.node, { apiType: "chat" });
    expectCompatibleConnection(storedConnections[1], ctx.node, { apiType: "chat" });
  });

  it("rejects a duplicate connection name without overwriting the existing key", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-duplicate-test",
      type: "openai-compatible",
      name: "Duplicate Name Node",
      prefix: "dup",
      apiType: "chat",
      baseUrl: "https://duplicate-name.test/v1",
    });
    cleanup = ctx.cleanup;

    const firstResponse = await ctx.POST(makeRequest(ctx.node.id, "Key A", "original-key"));
    const secondResponse = await ctx.POST(makeRequest(ctx.node.id, "Key A", "replacement-key"));
    const body = await secondResponse.json();
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(409);
    expect(body.error).toContain('"Key A"');
    expect(storedConnections).toHaveLength(1);
    expect(storedConnections[0].apiKey).toBe("original-key");
  });

  it("rejects one of two concurrent same-name creates (YAN-273)", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-race-test",
      type: "openai-compatible",
      name: "Race Node",
      prefix: "race",
      apiType: "chat",
      baseUrl: "https://race.test/v1",
    });
    cleanup = ctx.cleanup;

    const responses = await Promise.all([
      ctx.POST(makeRequest(ctx.node.id, "Key A", "key-1")),
      ctx.POST(makeRequest(ctx.node.id, "Key A", "key-2")),
    ]);
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });
    const created = await responses.find((r) => r.status === 201).json();

    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(storedConnections).toHaveLength(1);
    expect(storedConnections[0].id).toBe(created.connection.id);
  });
});
