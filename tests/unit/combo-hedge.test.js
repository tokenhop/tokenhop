// YAN-763: per-combo fastest hedging.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getFastestModels,
  handleComboChat,
  resetComboRotation,
} from "../../open-sse/services/combo.js";
import {
  resolveComboStrategy,
  validateComboStrategySettings,
} from "../../open-sse/services/comboStrategy.js";
import { probeStreamHead } from "../../open-sse/utils/streamProbe.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { applyComboStrategyPatch } from "../../src/app/api/settings/comboStrategyPatch.js";
import {
  releaseGrantReservation,
  checkAndReserveGrant,
} from "../../src/sse/services/grantRateLimiter.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (text = "{}") => new Response(text, { status: 200 });
const fail = (status = 503) =>
  new Response(JSON.stringify({ error: { message: "boom" } }), { status });
const sse = (frames) =>
  new Response(`${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const token = { choices: [{ delta: { content: "hi" } }] };

// Resolves after `ms` unless its attempt signal aborts first.
const delayed = (attempt, ms, make) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(make()), ms);
    attempt?.signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    });
  });

// Non-fallback 4xx whose body.cancel we own: Response.clone() tees the real
// body, which would leave a spy on the stale pre-clone stream.
const terminal400 = () => {
  const cancel = vi.fn(async () => {});
  const json = { error: { message: "boom" } };
  const res = {
    ok: false,
    status: 400,
    statusText: "Bad Request",
    headers: new Headers(),
    body: { cancel },
    clone: () => new Response(JSON.stringify(json), { status: 400 }),
    json: async () => json,
  };
  return { res, cancel };
};

const run = (handleSingleModel, extra = {}) =>
  handleComboChat({
    body: { messages: [{ role: "user", content: "x" }] },
    models: ["p/a", "p/b", "p/c"],
    comboName: "h",
    comboStrategy: "fastest",
    hedgeDelayMs: 30,
    handleSingleModel,
    log,
    ...extra,
  });

beforeEach(() => {
  resetComboRotation();
  // Fixed order: all cold => configured order p/a, p/b, p/c.
});

describe("hedge config", () => {
  it("resolves, validates and defaults off", () => {
    const settings = { comboStrategies: { c: { fallbackStrategy: "fastest", hedgeDelayMs: 250 } } };
    expect(resolveComboStrategy(settings, "c").hedgeDelayMs).toBe(250);
    expect(resolveComboStrategy({}, "c").hedgeDelayMs).toBe(0);
    for (const bad of [-1, 10001, 1.5, "5", NaN, null]) {
      expect(
        validateComboStrategySettings({ comboStrategies: { c: { hedgeDelayMs: bad } } }),
      ).toMatch(/hedgeDelayMs/);
    }
    for (const good of [0, 1, 10000]) {
      expect(
        validateComboStrategySettings({ comboStrategies: { c: { hedgeDelayMs: good } } }),
      ).toBeNull();
    }
  });
});

describe("hedged fastest race", () => {
  it("off by default: sequential call order and 2-arg arity for non-fastest", async () => {
    const calls = [];
    await handleComboChat({
      body: {},
      models: ["p/a", "p/b"],
      comboName: "h",
      comboStrategy: "fallback",
      hedgeDelayMs: 30,
      handleSingleModel: async (...args) => {
        calls.push(args);
        return calls.length === 1 ? fail() : ok();
      },
      log,
    });
    expect(calls.map((c) => c[1])).toEqual(["p/a", "p/b"]);
    expect(calls.every((c) => c.length === 2)).toBe(true);
  });

  it("hedgeDelayMs 0 keeps fastest sequential", async () => {
    const calls = [];
    await run(
      async (_b, m) => {
        calls.push(m);
        return m === "p/a" ? fail() : ok();
      },
      { hedgeDelayMs: 0 },
    );
    expect(calls).toEqual(["p/a", "p/b"]);
  });

  it("leader answering before the delay never starts the backup", async () => {
    const calls = [];
    const res = await run(async (_b, m) => {
      calls.push(m);
      return ok("leader");
    });
    expect(await res.text()).toBe("leader");
    await sleep(60);
    expect(calls).toEqual(["p/a"]);
  });

  it("holds backup terminal 400 while leader is pending; leader 200 wins and cancels backup", async () => {
    let resolveLeader;
    let leaderAttempt;
    const { res: backup, cancel: cancelBackup } = terminal400();
    const calls = [];
    const pending = run((_b, model, attempt) => {
      calls.push(model);
      if (model === "p/a") {
        leaderAttempt = attempt;
        return new Promise((resolve) => {
          resolveLeader = resolve;
        });
      }
      return backup;
    });
    await vi.waitFor(() => expect(calls).toEqual(["p/a", "p/b"]));
    await sleep(20); // allow backup's error classification to finish
    expect(leaderAttempt.signal.aborted).toBe(false);
    resolveLeader(ok("leader"));
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("leader");
    expect(cancelBackup).toHaveBeenCalledTimes(1);
    expect(cancelBackup).toHaveBeenCalledWith("hedge loser");
  });

  it("returns held backup terminal 400 once leader fails fallback-eligible", async () => {
    let resolveLeader;
    const { res: backup, cancel: cancelBackup } = terminal400();
    const calls = [];
    const pending = run((_b, model) => {
      calls.push(model);
      return model === "p/a"
        ? new Promise((resolve) => {
            resolveLeader = resolve;
          })
        : backup;
    });
    await vi.waitFor(() => expect(calls).toEqual(["p/a", "p/b"]));
    await sleep(20);
    resolveLeader(fail(503));
    const response = await pending;
    expect(response).toBe(backup);
    expect(response.status).toBe(400);
    expect(cancelBackup).not.toHaveBeenCalled();
    expect(calls).toEqual(["p/a", "p/b"]); // terminal: no rank2 fallback
  });

  it("delayed backup wins; slow leader is aborted with no sample, cooldown or fallback hop", async () => {
    const fallback = vi.fn();
    const seen = {};
    const res = await run(
      async (_b, m, attempt) => {
        seen[m] = attempt;
        if (m === "p/a") return delayed(attempt, 500, () => ok("slow"));
        return ok("backup");
      },
      { onFallback: fallback },
    );
    expect(await res.text()).toBe("backup");
    expect(seen["p/a"].isHedged).toBe(true);
    expect(seen["p/a"].signal.aborted).toBe(true);
    expect(seen["p/b"].signal.aborted).toBe(false);
    await sleep(20);
    expect(fallback).not.toHaveBeenCalled();
    // Loser left no latency sample: p/a is still cold, so it still ranks first.
    expect(getFastestModels(["p/a", "p/b"], "h", () => 0.5)[0]).toBe("p/a");
  });

  it("leader failing before the timer still starts rank1 immediately", async () => {
    const calls = [];
    const res = await run(
      async (_b, m) => {
        calls.push(m);
        return m === "p/a" ? fail() : ok("b");
      },
      { hedgeDelayMs: 5000 },
    );
    expect(await res.text()).toBe("b");
    expect(calls).toEqual(["p/a", "p/b"]);
  });

  it("both raced members failing falls through sequentially to rank2", async () => {
    const calls = [];
    const res = await run(async (_b, m) => {
      calls.push(m);
      return m === "p/c" ? ok("c") : fail();
    });
    expect(await res.text()).toBe("c");
    expect(calls).toEqual(["p/a", "p/b", "p/c"]);
  });

  it.each([200, 503])("rank2 sequential with clientSignal: %s", async (status) => {
    const ctrl = new AbortController();
    const seen = [];
    const res = await run(
      async (_b, m, attempt) => {
        seen.push(m);
        if (m === "p/c") {
          expect(attempt.isHedged).toBe(false);
          expect(attempt.signal).toBe(ctrl.signal);
          return status === 200 ? ok("rank2") : fail(status);
        }
        return fail();
      },
      { clientSignal: ctrl.signal },
    );
    expect(res.status).toBe(status);
    expect(seen).toEqual(["p/a", "p/b", "p/c"]);
  });

  it("rank2 client cancel aborts the attempt and releases its hold (C1)", async () => {
    const ctrl = new AbortController();
    const signals = [];
    const releases = [];
    const res = await run(
      async (_b, m, attempt) => {
        signals.push(attempt.signal);
        if (m === "p/c") {
          releases.push(attempt.signal);
          const pending = new Promise((_, reject) =>
            attempt.signal.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            ),
          );
          ctrl.abort();
          return pending;
        }
        return fail();
      },
      { clientSignal: ctrl.signal },
    );
    expect(res.status).toBe(499);
    expect(releases[0].aborted).toBe(true);
  });

  it("slot rejection outside member catch settles instead of hanging", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      // Logging happens outside runMember's try: force a rejected slot.
      const throwingLog = {
        ...log,
        info: (_tag, message) => {
          if (message.includes("Trying model 1/")) throw new Error("slot rejected");
        },
      };
      const res = await run(async () => ok("backup"), { log: throwingLog });
      expect(await res.text()).toBe("backup");
      await sleep(10);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", unhandled);
    }
  });

  it("same-tick served slots leave exactly one live body", async () => {
    const resolvers = [];
    const cancelled = [];
    const p = run(
      (_b, model) =>
        new Promise((resolve) => {
          resolvers.push(() =>
            resolve(
              new Response(
                new ReadableStream({
                  cancel() {
                    cancelled.push(model);
                  },
                }),
              ),
            ),
          );
        }),
    );
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    for (const resolve of resolvers) resolve();
    const res = await p;
    await sleep(10);
    expect(cancelled).toHaveLength(1);
    await res.body.cancel();
    expect(cancelled).toHaveLength(2);
  });

  it("winner stream stall after the race still records a failure sample", async () => {
    let settle;
    const res = await run(async (_b, m, attempt) => {
      if (m === "p/a") return delayed(attempt, 500, () => ok());
      settle = attempt.registerStream();
      return sse([token]);
    });
    await res.text();
    // Stall watchdog fires mid-stream: stream error settles the winner
    // (hedge signal is NOT aborted, so it is a real failure, not a cancel).
    settle({ error: new Error("stream stall timeout") });
    const ranked = getFastestModels(["p/a", "p/b"], "h", () => 0.5);
    expect(ranked).toEqual(["p/a", "p/b"].sort((x) => (x === "p/b" ? 1 : -1)));
    expect(ranked[0]).toBe("p/a"); // cold leader first, failed winner sunk behind
  });

  it("winner detaches client abort listener", async () => {
    const ctrl = new AbortController();
    const remove = vi.spyOn(ctrl.signal, "removeEventListener");
    const res = await run(async () => ok(), { clientSignal: ctrl.signal });
    expect(res.ok).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("all failing keeps existing aggregation (last status/message)", async () => {
    const res = await run(async () => fail(503));
    expect(res.status).toBe(503);
  });

  it("an empty stream cannot win the race", async () => {
    const res = await run(async (_b, m) =>
      m === "p/a" ? sse([{ choices: [{ delta: { role: "assistant" } }] }]) : sse([token]),
    );
    expect(await res.text()).toContain("hi");
  });

  it("each raced member gets a distinct cloned body", async () => {
    const bodies = [];
    await run(async (b, m, attempt) => {
      bodies.push(b);
      b.mutated = m;
      return m === "p/a" ? delayed(attempt, 300, () => ok()) : ok();
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toBe(bodies[1]);
    expect(bodies[1].mutated).toBe("p/b");
    expect(bodies[0].mutated).toBe("p/a");
  });

  it("client disconnect aborts both raced attempts", async () => {
    const ctrl = new AbortController();
    const signals = [];
    const p = run(
      async (_b, _m, attempt) => {
        signals.push(attempt.signal);
        return delayed(attempt, 1000, () => ok());
      },
      { clientSignal: ctrl.signal },
    );
    await sleep(60);
    ctrl.abort();
    const res = await p;
    expect(res.status).toBe(499);
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("nested/inherited attempts never hedge and keep fanout at 2", async () => {
    const calls = [];
    await run(
      async (_b, m) => {
        calls.push(m);
        return ok();
      },
      { parentAttempt: { registerStream: () => null, signal: null } },
    );
    expect(calls).toEqual(["p/a"]);
  });

  it("rejection inside the slot chain (not runMember) settles the race", async () => {
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      // runMember resolves; the slot's own chain then throws (e.g. a bad
      // onFallback). The race must still settle and rank1 must run.
      const calls = [];
      const explodingFallback = async ({ model }) => {
        if (model === "p/a") throw new Error("hook boom");
      };
      const res = await run(
        async (_b, m) => {
          calls.push(m);
          return m === "p/a" ? fail() : ok("b");
        },
        { onFallback: explodingFallback },
      );
      expect(await res.text()).toBe("b");
      expect(calls).toEqual(["p/a", "p/b"]);
      await sleep(10);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("nested leaf abort propagates without inner fanout or loser samples", async () => {
    let live = 0;
    let maxLive = 0;
    const leafSignals = [];
    const result = await run(async (b, model, attempt) => {
      if (model === "p/a") {
        return handleComboChat({
          body: b,
          models: ["leaf/a", "leaf/b"],
          comboName: "nested",
          comboStrategy: "fastest",
          hedgeDelayMs: 1,
          parentAttempt: attempt,
          handleSingleModel: async (_b, _m, leafAttempt) => {
            leafSignals.push(leafAttempt.signal);
            maxLive = Math.max(maxLive, ++live);
            try {
              return await delayed(leafAttempt, 500, () => ok());
            } finally {
              live--;
            }
          },
          log,
        });
      }
      maxLive = Math.max(maxLive, ++live);
      live--;
      return ok("outer backup");
    });
    expect(await result.text()).toBe("outer backup");
    await sleep(10);
    expect(maxLive).toBe(2);
    expect(leafSignals).toHaveLength(1);
    expect(leafSignals[0].aborted).toBe(true);
    expect(getFastestModels(["leaf/a", "leaf/b"], "nested", () => 0.5)).toEqual([
      "leaf/a",
      "leaf/b",
    ]);
  });

  it("probes (onAttempt) stay sequential", async () => {
    const calls = [];
    await run(
      async (_b, m) => {
        calls.push(m);
        return m === "p/a" ? fail() : ok();
      },
      { onAttempt: () => {} },
    );
    expect(calls).toEqual(["p/a", "p/b"]);
  });

  it("aborting a probe mid-read cancels the head and the reader", async () => {
    const ctrl = new AbortController();
    let cancelled = false;
    const body = new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(body, { headers: { "content-type": "text/event-stream" } });
    const p = probeStreamHead(res, { signal: ctrl.signal });
    ctrl.abort();
    expect((await p).outcome).toBe("error");
    await sleep(0);
    expect(cancelled).toBe(true);
  });
});

describe("hedge cancellation accounting", () => {
  it.each([null, { prompt_tokens: 17, completion_tokens: 2 }])(
    "cancel finalizes observed usage only: %j",
    async (observed) => {
      const complete = vi.fn();
      // Content and optional provider usage arrive, then the consumer cancels.
      const src = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }], ...(observed && { usage: observed }) })}\n\n`,
            ),
          );
        },
      });
      const ts = createSSETransformStreamWithLogger(
        "openai",
        "openai",
        null,
        null,
        null,
        null,
        null,
        { messages: [{ role: "user", content: "x" }] },
        complete,
      );
      const piped = src.pipeThrough(ts);
      const reader = piped.getReader();
      await reader.read(); // let the usage-bearing chunk flow through transform
      await reader.cancel("hedge loser");
      ts.finalizeCancelled();
      await sleep(10);
      expect(complete).toHaveBeenCalledTimes(1);
      const [content, usage, , info] = complete.mock.calls[0];
      expect(info.cancelled).toBe(true);
      expect(content.content).toContain("hi");
      expect(usage).toEqual(observed); // no estimated tokens on cancelled work
    },
  );

  it("grant reservation release is idempotent on abort", () => {
    const grant = { grantId: "g1", grantRpm: 10, grantTpm: 1000 };
    const h = checkAndReserveGrant(grant, 50);
    expect(h).toBeTruthy();
    releaseGrantReservation(h);
    releaseGrantReservation(h);
    releaseGrantReservation(h);
  });
});

describe("comboStrategyPatch hedgeDelayMs", () => {
  it("roundtrips hedgeDelayMs and rejects invalid values", async () => {
    const strategies = {};
    const update = async (fn) => {
      const next = fn(strategies);
      Object.assign(strategies, next);
      return { comboStrategies: strategies };
    };
    const good = await applyComboStrategyPatch(
      {
        comboStrategyPatch: {
          name: "c",
          patch: { fallbackStrategy: "fastest", hedgeDelayMs: 250 },
        },
      },
      update,
    );
    expect(good.settings.comboStrategies.c.hedgeDelayMs).toBe(250);
    const merged = await applyComboStrategyPatch(
      { comboStrategyPatch: { name: "c", patch: { hedgeDelayMs: 0 } } },
      update,
    );
    expect(merged.settings.comboStrategies.c.hedgeDelayMs).toBe(0);
    for (const bad of [-1, 10001, 2.5, "9"]) {
      const res = await applyComboStrategyPatch(
        { comboStrategyPatch: { name: "c", patch: { hedgeDelayMs: bad } } },
        update,
      );
      expect(res.response.status).toBe(400);
    }
  });
});
