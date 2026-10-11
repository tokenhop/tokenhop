// YAN-1018: GET /v1/models/info reports compatible-node model metadata the same
// way GET /v1/models does (completions endpoint hint + FIM capabilities), never
// leaks node credentials, and honors disabled-model / key-scope filtering.
// Static registry hits keep the pre-existing static path untouched.
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOpenAICompatibleConnectionApiType: vi.fn(),
  resolveGatewayAuth: vi.fn(),
  buildModelsList: vi.fn(),
  actualBuildModelsList: null,
}));

vi.mock("@/sse/services/model.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveOpenAICompatibleConnectionApiType: mocks.resolveOpenAICompatibleConnectionApiType,
}));

vi.mock("@/lib/auth/gatewayAuth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveGatewayAuth: mocks.resolveGatewayAuth,
}));

// Delegates to the real builder unless a test overrides it.
vi.mock("@/app/api/v1/models/route.js", async (importOriginal) => {
  const actual = await importOriginal();
  mocks.actualBuildModelsList = actual.buildModelsList;
  mocks.buildModelsList.mockImplementation(actual.buildModelsList);
  return { ...actual, buildModelsList: mocks.buildModelsList };
});

import { GET } from "@/app/api/v1/models/info/route.js";
import { buildModelsList as realBuildModelsList } from "@/app/api/v1/models/route.js";
import {
  createProviderConnectionUnscoped,
  deleteProviderConnectionsByProviderUnscoped,
} from "@/models/index.js";
import { disableModels, enableModels } from "@/lib/disabledModelsDb";
import { getAdapter } from "@/lib/db/driver.js";

const NODE_ID = "openai-compatible-completions-11111111-2222-3333-4444-555555555555";
const API_KEY = "sk-secret-node-key-1018";
const BASE_URL = "http://localhost:9";
const NOW = "2026-10-11T00:00:00.000Z";
const info = (id) =>
  GET(new Request(`http://localhost/v1/models/info?id=${encodeURIComponent(id)}`));

beforeEach(async () => {
  mocks.buildModelsList.mockReset().mockImplementation(mocks.actualBuildModelsList);
  mocks.resolveOpenAICompatibleConnectionApiType.mockReset();
  mocks.resolveOpenAICompatibleConnectionApiType.mockResolvedValue("completions");
  mocks.resolveGatewayAuth.mockReset();
  // Legacy storage: principal=null intentionally serves the same unscoped
  // catalog /v1/models serves.
  mocks.resolveGatewayAuth.mockResolvedValue({ principal: null, legacy: true });
  await enableModels("fimnode", ["qwen3-4b"]);
  await deleteProviderConnectionsByProviderUnscoped(NODE_ID);
  await createProviderConnectionUnscoped({
    provider: NODE_ID,
    authType: "apikey",
    apiKey: API_KEY,
    testStatus: "active",
    providerSpecificData: { prefix: "fimnode", baseUrl: BASE_URL, enabledModels: ["qwen3-4b"] },
  });
});

describe("GET /v1/models/info for compatible nodes (YAN-1018)", () => {
  it("completions node model: 200 with /v1/completions endpoint and FIM capabilities", async () => {
    const res = await info("fimnode/qwen3-4b");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: "fimnode/qwen3-4b",
      name: "qwen3-4b",
      kind: "llm",
      owned_by: "fimnode",
      endpoint: "/v1/completions",
    });
    expect(body.capabilities).toMatchObject({ fim: true, tools: false, forcedToolChoice: false });
    // contextWindow maps from the catalog entry's context_length when present.
    const entry = (await realBuildModelsList(["llm"])).find((m) => m.id === "fimnode/qwen3-4b");
    if (Number.isFinite(entry?.context_length)) {
      expect(body.contextWindow).toBe(entry.context_length);
    } else {
      expect(body.contextWindow).toBeUndefined();
    }
  });

  it("never exposes node credentials or base URL", async () => {
    const text = await (await info("fimnode/qwen3-4b")).text();
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(BASE_URL);
    expect(text).not.toMatch(/apiKey|baseUrl/);
  });

  it("disabled node model: 404", async () => {
    await disableModels("fimnode", ["qwen3-4b"]);
    expect((await info("fimnode/qwen3-4b")).status).toBe(404);
  });

  it("static known id never builds the catalog: old static info even when it throws", async () => {
    mocks.buildModelsList.mockRejectedValueOnce(new Error("catalog down"));
    const res = await info("ag/gemini-3.1-flash-image");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("ag/gemini-3.1-flash-image");
    expect(body.endpoint).toBe("/v1/images/generations");
    // Static capabilities, not the catalog's shape.
    expect(body.capabilities).toEqual(["textToImage"]);
    expect(mocks.buildModelsList).not.toHaveBeenCalled();
  });

  it("catalog throw on a static-miss id fails closed (503)", async () => {
    mocks.buildModelsList.mockRejectedValueOnce(new Error("db down"));
    expect((await info("fimnode/qwen3-4b")).status).toBe(503);
  });
});

describe("hashed principal: real catalog, real scope filtering", () => {
  const MASTER = crypto.randomBytes(32);

  // Gateway-only principal shape (apiKeyPrincipal): frozen, workspace-scoped.
  const principalOf = (allowedModels) =>
    Object.freeze({
      workspaceId: "w1",
      userId: null,
      apiKeyId: "key-info-1",
      scopes: Object.freeze({
        allowedModels: Object.freeze(allowedModels),
        allowedCombos: Object.freeze([]),
      }),
      via: "apiKey",
    });

  async function insertNodeConnection(workspaceId) {
    const data = JSON.stringify({
      apiKey: API_KEY,
      providerSpecificData: { prefix: "fimnode", baseUrl: BASE_URL, enabledModels: ["qwen3-4b"] },
    });
    (await getAdapter()).run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
       VALUES('conn-fim-${workspaceId}', ?, 'apikey', 'fim', NULL, 1, 1, ?, ?, ?, ?, NULL)`,
      [NODE_ID, data, NOW, NOW, workspaceId],
    );
  }

  beforeEach(async () => {
    process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
    const db = await getAdapter();
    db.run("DELETE FROM providerConnections WHERE provider = ?", [NODE_ID]);
    db.run("DELETE FROM providerNodes WHERE id = ?", [NODE_ID]);
    db.run("DELETE FROM workspaces");
    db.run("DELETE FROM memberships");
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES ('w1', 'w1', 'shared', ?, ?)`,
      [NOW, NOW],
    );
  });

  afterEach(() => {
    delete process.env.TOKENHOP_MASTER_KEY;
  });

  it("allowlist excluding the node model: 404; including it: 200 — via real buildModelsList", async () => {
    await insertNodeConnection("w1");
    const db = await getAdapter();
    db.run(
      `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt, workspaceId)
       VALUES(?, 'openai-compatible', 'fim', ?, ?, ?, 'w1')`,
      [NODE_ID, JSON.stringify({ prefix: "fimnode" }), NOW, NOW],
    );
    const deniedPrincipal = principalOf(["openai/gpt-4o"]);
    mocks.resolveGatewayAuth.mockResolvedValue({ principal: deniedPrincipal, legacy: false });

    const denied = await info("fimnode/qwen3-4b");
    expect(denied.status).toBe(404);
    expect(mocks.buildModelsList).toHaveBeenCalledWith(["llm"], { principal: deniedPrincipal });

    // Allowlist entries use the canonical node-id form, same as chat authorization.
    const allowedPrincipal = principalOf([`${NODE_ID}/qwen3-4b`]);
    mocks.resolveGatewayAuth.mockResolvedValue({ principal: allowedPrincipal, legacy: false });
    const ok = await info("fimnode/qwen3-4b");
    expect(ok.status).toBe(200);
    expect((await ok.json()).endpoint).toBe("/v1/completions");
  });

  it("workspace isolation: node connection in a foreign workspace is invisible", async () => {
    const db = await getAdapter();
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES ('w2', 'w2', 'shared', ?, ?)`,
      [NOW, NOW],
    );
    await insertNodeConnection("w2");
    mocks.resolveGatewayAuth.mockResolvedValue({ principal: principalOf([]), legacy: false });
    expect((await info("fimnode/qwen3-4b")).status).toBe(404);
  });
});
