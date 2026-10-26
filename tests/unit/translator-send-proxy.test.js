// YAN-1251: the dev translator send route uses the connection's proxy policy for
// the executor calls and the 401 refresh, and fails closed when it cannot be resolved.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionsUnscoped: vi.fn(),
  updateProviderConnectionUnscoped: vi.fn(async () => {}),
  resolveConnectionProxyConfig: vi.fn(),
  execute: vi.fn(),
  refreshCredentials: vi.fn(),
}));

vi.mock("@/lib/localDb.js", () => ({
  getProviderConnectionsUnscoped: mocks.getProviderConnectionsUnscoped,
  updateProviderConnectionUnscoped: mocks.updateProviderConnectionUnscoped,
}));
vi.mock("@/lib/network/connectionProxy", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));
vi.mock("open-sse/index.js", () => ({
  getExecutor: () => ({ execute: mocks.execute, refreshCredentials: mocks.refreshCredentials }),
}));

import { POST } from "@/app/api/translator/send/route.js";

const EXPECTED_PROXY = expect.objectContaining({
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://pool.example:8080",
  strictProxy: true,
  connectionProxyPoolId: "pool-1",
});

const send = () =>
  POST(
    new Request("http://localhost/api/translator/send", {
      method: "POST",
      body: JSON.stringify({ provider: "codex", model: "gpt-x", body: { stream: false } }),
    }),
  );

describe("translator send route connection proxy", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getProviderConnectionsUnscoped.mockResolvedValue([
      {
        id: "conn-1",
        provider: "codex",
        accessToken: "at-old",
        refreshToken: "rt",
        providerSpecificData: { proxyPoolId: "pool-1" },
      },
    ]);
  });

  it("returns 503 without calling upstream when the proxy cannot be resolved", async () => {
    mocks.resolveConnectionProxyConfig.mockResolvedValue({ source: "error" });

    const response = await send();

    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.refreshCredentials).not.toHaveBeenCalled();
  });

  it("passes the proxy to both executions and the 401 refresh", async () => {
    mocks.resolveConnectionProxyConfig.mockResolvedValue({
      source: "pool",
      proxyPoolId: "pool-1",
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://pool.example:8080",
      connectionNoProxy: "",
      strictProxy: true,
    });
    mocks.execute
      .mockResolvedValueOnce({ response: new Response("expired", { status: 401 }) })
      .mockResolvedValueOnce({ response: new Response("data: ok\n\n", { status: 200 }) });
    mocks.refreshCredentials.mockResolvedValue({ accessToken: "at-new" });

    const response = await send();

    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    for (const [args] of mocks.execute.mock.calls) {
      expect(args.proxyOptions).toEqual(EXPECTED_PROXY);
    }
    expect(mocks.refreshCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "rt" }),
      expect.anything(),
      EXPECTED_PROXY,
    );
  });
});
