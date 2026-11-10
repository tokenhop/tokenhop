import { describe, it, expect } from "vitest";

import { findComboCycle, handleComboChat } from "../../open-sse/services/combo.js";
import { createComboUnscoped, updateSettings } from "../../src/lib/db/index.js";
import { handleChat } from "../../src/sse/handlers/chat.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

function errResponse(status, message, headers = {}) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("combo cycles (YAN-54)", () => {
  it("findComboCycle detects self and indirect cycles, ignores provider/model members", () => {
    expect(findComboCycle("loopy", ["loopy"], [])).toEqual(["loopy", "loopy"]);
    expect(findComboCycle("a", ["p/x", "b"], [{ name: "b", models: ["a"] }])).toEqual([
      "a",
      "b",
      "a",
    ]);
    expect(findComboCycle("a", ["b", "p/x"], [{ name: "b", models: ["p/y"] }])).toBeNull();
  });

  it("rejects a cyclic combo at request time instead of recursing forever", async () => {
    await updateSettings({ requireApiKey: false });
    await createComboUnscoped({ name: "cyc-a", models: ["cyc-b"] });
    await createComboUnscoped({ name: "cyc-b", models: ["cyc-a"] });
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "cyc-a", messages: [{ role: "user", content: "hi" }] }),
    });

    const res = await handleChat(request);

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("Combo cycle detected");
  });
});

describe("combo final error (YAN-79, YAN-80)", () => {
  it("pairs the last model's status with its message", async () => {
    const replies = [errResponse(401, "invalid api key"), errResponse(429, "Rate limit exceeded")];
    const res = await handleComboChat({
      body: {},
      models: ["p/a", "p/b"],
      handleSingleModel: async () => replies.shift(),
      log,
    });

    expect(res.status).toBe(429);
    expect((await res.json()).error.message).toContain("Rate limit exceeded");
  });

  it("propagates the earliest Retry-After header", async () => {
    const replies = [
      errResponse(429, "all rate limited", { "Retry-After": "40" }),
      errResponse(429, "all rate limited", { "Retry-After": "10" }),
    ];
    const res = await handleComboChat({
      body: {},
      models: ["p/a", "p/b"],
      handleSingleModel: async () => replies.shift(),
      log,
    });

    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(9);
    expect(retryAfter).toBeLessThanOrEqual(10);
  });
});
