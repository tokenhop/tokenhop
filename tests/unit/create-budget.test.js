import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBudget } from "../../src/shared/utils/createBudget.js";

const base = {
  workspaceId: "ws/1 a",
  scopeType: "key",
  scopeId: "key-1",
  window: "month",
  limitUsd: "12.5",
};

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("createBudget", () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the encoded workspace budgets URL with the exact body", async () => {
    fetchMock.mockResolvedValue(reply(201, { budget: { id: "b1" } }));
    const out = await createBudget(base);
    expect(out).toEqual({ budget: { id: "b1" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/workspaces/ws%2F1%20a/budgets");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      scopeType: "key",
      scopeId: "key-1",
      window: "month",
      limitUsd: 12.5,
    });
  });

  it("accepts grant scope", async () => {
    fetchMock.mockResolvedValue(reply(201, { budget: {} }));
    await createBudget({ ...base, scopeType: "grant", scopeId: "g1", limitUsd: 3 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).scopeType).toBe("grant");
  });

  it.each([
    ["scope type", { scopeType: "workspace" }],
    ["window", { window: "year" }],
    ["workspaceId", { workspaceId: "" }],
    ["scopeId", { scopeId: " " }],
    ["zero limit", { limitUsd: 0 }],
    ["negative limit", { limitUsd: -1 }],
    ["NaN limit", { limitUsd: "abc" }],
    ["Infinity limit", { limitUsd: Infinity }],
    ["empty limit", { limitUsd: "" }],
  ])("rejects invalid %s without calling fetch", async (_n, patch) => {
    await expect(createBudget({ ...base, ...patch })).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the server message and status without echoing the payload", async () => {
    fetchMock.mockResolvedValue(
      reply(409, { error: "A budget already exists", code: "budget_exists" }),
    );
    await expect(createBudget(base)).rejects.toMatchObject({
      message: "A budget already exists",
      status: 409,
      code: "budget_exists",
    });
  });

  it("falls back to a fixed message on a non-JSON error body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("html");
      },
    });
    await expect(createBudget(base)).rejects.toThrow("Could not save the budget. Try again.");
  });
});
