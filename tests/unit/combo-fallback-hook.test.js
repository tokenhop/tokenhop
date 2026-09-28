// handleComboChat onFallback: the failed step is reported before the next
// model is tried, so live routes can record fallback hops (YAN-293).
import { describe, it, expect, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

describe("handleComboChat onFallback", () => {
  it("reports each failed step before trying the next model", async () => {
    const seen = [];
    const fail = (status) =>
      new Response(JSON.stringify({ error: { message: `boom ${status}` } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    const calls = [fail(404), fail(429)];
    const ok = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const handleSingleModel = vi.fn(async () => calls.shift() || ok);

    const result = await handleComboChat({
      body: {},
      models: ["fake-a/m", "fake-b/m", "fake-c/m"],
      handleSingleModel,
      log: { info: () => {}, warn: () => {} },
      onFallback: async (hop) => {
        seen.push(hop);
      },
    });

    expect(result.ok).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([
      { model: "fake-a/m", status: 404 },
      { model: "fake-b/m", status: 429 },
    ]);
  });

  it("stays fail-open: a throwing recorder never breaks failover", async () => {
    const fail = new Response(JSON.stringify({ error: { message: "nope" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
    const ok = new Response("{}", { status: 200 });
    const handleSingleModel = vi
      .fn()
      .mockResolvedValueOnce(fail)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(ok);
    const onFallback = vi.fn(async () => {
      throw new Error("recorder down");
    });

    const result = await handleComboChat({
      body: {},
      models: ["a/m", "b/m", "c/m"],
      handleSingleModel,
      log: { info: () => {}, warn: () => {} },
      onFallback,
    });

    expect(result.ok).toBe(true);
    expect(onFallback).toHaveBeenCalledWith({ model: "b/m", status: 500 });
  });
});
