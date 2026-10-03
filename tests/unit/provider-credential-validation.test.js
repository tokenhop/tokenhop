import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getProviderConnectionByIdUnscoped: vi.fn(),
  updateProviderConnectionUnscoped: vi.fn(async (id, data) => ({ id, ...data })),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("@/models", () => ({
  getProviderNodeByIdUnscoped: vi.fn(),
  getProviderConnectionByIdUnscoped: mocks.getProviderConnectionByIdUnscoped,
  getProxyPoolById: vi.fn(),
  updateProviderConnectionUnscoped: mocks.updateProviderConnectionUnscoped,
  deleteProviderConnectionUnscoped: vi.fn(),
}));

function jsonRequest(url, method, body) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("OpenRouter key validation", () => {
  let POST;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    ({ POST } = await import("../../src/app/api/providers/validate/route.js"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function validate(status) {
    fetchMock.mockResolvedValue(new Response("{}", { status }));
    return POST(
      jsonRequest("https://tokenhop.local/api/providers/validate", "POST", {
        provider: "openrouter",
        apiKey: "garbage",
      }),
    );
  }

  it("probes the authenticated /auth/key endpoint and rejects a 401", async () => {
    const response = await validate(401);

    expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: "Bearer garbage" },
    });
    expect(response.body.valid).toBe(false);
  });

  it("accepts a 200 from /auth/key", async () => {
    const response = await validate(200);

    expect(response.body).toEqual({ valid: true, error: null });
  });
});

describe("cookie connection credential update", () => {
  it("stores the new cookie on PUT and redacts it from the response", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { PUT } = await import("../../src/app/api/providers/[id]/route.js");
    mocks.getProviderConnectionByIdUnscoped.mockResolvedValue({
      id: "c1",
      provider: "grok-web",
      authType: "cookie",
      apiKey: "old-cookie",
    });

    const response = await PUT(
      jsonRequest("https://tokenhop.local/api/providers/c1", "PUT", { apiKey: "new-cookie" }),
      { params: Promise.resolve({ id: "c1" }) },
    );

    expect(mocks.updateProviderConnectionUnscoped).toHaveBeenCalledWith("c1", {
      apiKey: "new-cookie",
    });
    expect(response.body.connection).not.toHaveProperty("apiKey");
  });
});
