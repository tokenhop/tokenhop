import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionByIdUnscoped: vi.fn(),
  getApiKeys: vi.fn(),
  getConsistentMachineId: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionByIdUnscoped: mocks.getProviderConnectionByIdUnscoped,
  getApiKeys: mocks.getApiKeys,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const originalFetch = global.fetch;
// Importing the route loads proxyFetch, which patches global fetch; import first so
// per-test fetch mocks stay in place.
const { POST } = await import("../../src/app/api/providers/[id]/test-models/route.js");

describe("provider test-models route kind routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnectionByIdUnscoped.mockResolvedValue({
      id: "conn-hf",
      provider: "huggingface",
    });
    mocks.getApiKeys.mockResolvedValue([{ key: "sk-internal", isActive: true }]);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    global.fetch = vi.fn((url) => {
      if (String(url).includes("/api/v1/images/generations")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              created: 1,
              data: [{ b64_json: "abc" }],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("routes huggingface image models to /api/v1/images/generations", async () => {
    const req = new Request("http://localhost/api/providers/conn-hf/test-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req, { params: Promise.resolve({ id: "conn-hf" }) });
    const body = await res.json();

    expect(body.provider).toBe("huggingface");
    expect(body.results.some((r) => r.modelId === "black-forest-labs/FLUX.1-schnell" && r.ok)).toBe(
      true,
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/images/generations"),
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  // YAN-107: the login-gated /api/providers/:id/models route must not be self-fetched.
  it("lists compatible node models in-process instead of an unauthenticated self-fetch", async () => {
    mocks.getProviderConnectionByIdUnscoped.mockResolvedValue({
      id: "conn-oc",
      provider: "openai-compatible-node1",
      apiKey: "sk-node",
      providerSpecificData: { baseUrl: "https://node.example/v1" },
    });
    const fetchMock = global.fetch;
    global.fetch = vi.fn((url, init) =>
      String(url) === "https://node.example/v1/models"
        ? Promise.resolve(Response.json({ data: [{ id: "m1" }] }))
        : fetchMock(url, init),
    );

    const res = await POST(new Request("http://localhost/x", { method: "POST" }), {
      params: Promise.resolve({ id: "conn-oc" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results.map((r) => r.modelId)).toEqual(["m1"]);
    const urls = global.fetch.mock.calls.map(([url]) => String(url));
    expect(urls).not.toContainEqual(expect.stringContaining("/api/providers/"));
    expect(global.fetch).toHaveBeenCalledWith(
      "https://node.example/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-node" }),
      }),
    );
  });
});
