// YAN-1041 manual probe route: auth/scoping statuses, rate limit, and a
// response that can never contain credentials or upstream free text.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  loadScoped: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("@/lib/users/workspaceScope.js", () => ({
  loadScoped: (...a) => mocks.loadScoped(...a),
  redactConnection: (s, c) => c,
}));
vi.mock("@/lib/db/index.js", () => ({ getConnection: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionByIdUnscoped: vi.fn() }));
vi.mock("@/shared/services/billingProbe.js", async (importOriginal) => ({
  ...(await importOriginal()),
  probeBillingConnection: (...a) => mocks.probe(...a),
}));

const { POST } = await import("../../src/app/api/providers/[id]/billing-probe/route.js");

const lock = {
  reason: "credit_exhausted",
  code: "insufficient_quota",
  message: "Upstream reported exhausted credit or spend limit",
  lockedAt: "2026-01-01T00:00:00.000Z",
  nextProbeAt: "2026-01-01T03:00:00.000Z",
  lastProbeAt: null,
  lastProbeError: null,
  generation: 42,
};

const post = (id) =>
  POST(new Request("http://localhost/api/providers/x/billing-probe", { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadScoped.mockResolvedValue({ scope: null, row: { id: "x" } });
  mocks.probe.mockResolvedValue({ result: "still_locked", billingLock: lock });
});

describe("POST /api/providers/[id]/billing-probe", () => {
  it("uses the connection MANAGE capability for scoping", async () => {
    await post("x");
    expect(mocks.loadScoped.mock.calls[0][0]).toBe("workspace.connections.manage");
    expect(mocks.probe).toHaveBeenCalledWith("x", { manual: true });
  });

  it("passes through auth/scoping failures (404 not found, 403 denied)", async () => {
    mocks.loadScoped.mockResolvedValueOnce(
      NextResponse.json({ error: "Connection not found" }, { status: 404 }),
    );
    expect((await post("x")).status).toBe(404);
    mocks.loadScoped.mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    );
    expect((await post("x")).status).toBe(403);
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it("409 when the connection is disabled", async () => {
    mocks.probe.mockResolvedValueOnce({ result: "disabled", billingLock: lock });
    const res = await post("x");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "Connection is disabled", result: "disabled" });
  });

  it("404 when the connection is gone", async () => {
    mocks.probe.mockResolvedValueOnce({ result: "not_found", billingLock: null });
    const res = await post("x");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "Connection not found" });
  });

  it("429 rate limited with retryAfterMs and Retry-After", async () => {
    mocks.probe.mockResolvedValueOnce({
      result: "rate_limited",
      billingLock: lock,
      retryAfterMs: 61_000,
    });
    const res = await post("x");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("61");
    expect(await res.json()).toEqual({
      result: "rate_limited",
      billingLock: lock,
      retryAfterMs: 61_000,
    });
  });

  it("200 contract: { result, billingLock|null }; never credentials or upstream text", async () => {
    for (const result of ["cleared", "still_locked", "error", "not_locked", "in_flight"]) {
      mocks.probe.mockResolvedValueOnce({
        result,
        billingLock: result === "cleared" ? null : lock,
      });
      const res = await post("x");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Object.keys(body).sort()).toEqual(["billingLock", "result"]);
      expect(body.result).toBe(result);
      const raw = JSON.stringify(body);
      expect(raw).not.toMatch(/sk-|Bearer|apiKey|accessToken|refreshToken/i);
    }
  });

  it("500 on an unexpected probe error", async () => {
    mocks.probe.mockRejectedValueOnce(new Error("db down"));
    const res = await post("x");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "Billing probe failed" });
  });
});
