import { describe, it, expect, beforeEach } from "vitest";

import {
  getFastestModels,
  getRotatedModels,
  handleComboChat,
  recordComboLatency,
  resetComboRotation,
} from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from(
      { length: 4 },
      () => getRotatedModels(models, "code-xhigh", "round-robin")[0],
    );

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from(
      { length: 6 },
      () => getRotatedModels(models, "code-xhigh", "round-robin", 2)[0],
    );

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });
});

describe("combo fastest routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  const models = ["p/a", "p/b", "p/c"];
  const noExplore = () => 0.5;
  const ok = () => new Response("{}", { status: 200 });
  const rateLimited = () =>
    new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
      status: 429,
      headers: { "Retry-After": "5" },
    });

  it("tries unmeasured members first, in configured order", () => {
    recordComboLatency("f", "p/a", 100);
    expect(getFastestModels(models, "f", noExplore)).toEqual(["p/b", "p/c", "p/a"]);
  });

  it("orders measured members by median latency, ignoring outliers", () => {
    for (const ms of [300, 300, 300]) recordComboLatency("f", "p/a", ms);
    for (const ms of [100, 100, 5000]) recordComboLatency("f", "p/b", ms);
    for (const ms of [200, 200, 200]) recordComboLatency("f", "p/c", ms);
    expect(getFastestModels(models, "f", noExplore)).toEqual(["p/b", "p/c", "p/a"]);
  });

  it("explores by promoting a non-leader only when the roll hits", () => {
    recordComboLatency("f", "p/a", 100);
    recordComboLatency("f", "p/b", 200);
    recordComboLatency("f", "p/c", 300);
    const rolls = [0.05, 0.9];
    expect(getFastestModels(models, "f", () => rolls.shift())).toEqual(["p/c", "p/a", "p/b"]);
    expect(getFastestModels(models, "f", noExplore)).toEqual(models);
  });

  it("counts a failed attempt as slow so the member sinks", async () => {
    await handleComboChat({
      body: {},
      models: ["p/a", "p/b"],
      comboName: "f",
      comboStrategy: "fastest",
      handleSingleModel: async (_b, m) => (m === "p/a" ? rateLimited() : ok()),
      log,
    });
    expect(getFastestModels(["p/a", "p/b"], "f", noExplore)).toEqual(["p/b", "p/a"]);
  });

  it("does not penalize request-scoped 4xx or client aborts", async () => {
    const run = (handleSingleModel) =>
      handleComboChat({
        body: {},
        models: ["p/a", "p/b"],
        comboName: "f",
        comboStrategy: "fastest",
        handleSingleModel,
        log,
      });
    await run(
      async () =>
        new Response(JSON.stringify({ error: { message: "invalid request body" } }), {
          status: 400,
        }),
    );
    await run(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    expect(getFastestModels(["p/a", "p/b"], "f", noExplore)).toEqual(["p/a", "p/b"]);
    recordComboLatency("f", "p/b", 50);
    // p/a still unmeasured (cold), so it stays first.
    expect(getFastestModels(["p/a", "p/b"], "f", noExplore)).toEqual(["p/a", "p/b"]);
  });

  it("probes (onAttempt) do not record samples, and reset clears them", async () => {
    await handleComboChat({
      body: {},
      models: ["p/a", "p/b"],
      comboName: "f",
      comboStrategy: "fastest",
      handleSingleModel: async (_b, m) => (m === "p/a" ? rateLimited() : ok()),
      onAttempt: () => {},
      log,
    });
    expect(getFastestModels(["p/a", "p/b"], "f", noExplore)).toEqual(["p/a", "p/b"]);

    recordComboLatency("f", "p/a", 900);
    recordComboLatency("f", "p/b", 100);
    resetComboRotation("f");
    expect(getFastestModels(["p/a", "p/b"], "f", noExplore)).toEqual(["p/a", "p/b"]);
  });
});
