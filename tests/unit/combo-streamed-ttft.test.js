// YAN-764: combo attempt feedback — the trusted third arg handleComboChat hands
// to handleSingleModel. registerStream() returns the settle function; the
// streaming layer calls it before returning a streamed Response.
// Covers the combo contract directly (not the streamingHandler outcome wiring).
//
// Observing a recorded sample: seed reference members at 1 / 2000 / 7000 ms and
// read the member's slot in getFastestModels (cold = 0, then 1..3 by median).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  handleComboChat,
  getFastestModels,
  recordComboLatency,
  resetComboRotation,
} from "../../open-sse/services/combo.js";

let now = 1000;
let nowSpy;

beforeEach(() => {
  now = 1000;
  nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  nowSpy.mockRestore();
});

const log = { info() {}, warn() {} };
const ok = () => new Response("ok", { status: 200 });
const err = () => new Response("no", { status: 500 });

const REFS = ["ref/1", "ref/2000", "ref/7000"];
const seed = (combo) => {
  resetComboRotation(combo);
  recordComboLatency(combo, "ref/1", 1);
  recordComboLatency(combo, "ref/2000", 2000);
  recordComboLatency(combo, "ref/7000", 7000);
};
// 0 = no sample, 1 = (1,2000), 2 = (2000,7000), 3 = >7000
const slot = (combo, member) => getFastestModels([member, ...REFS], combo, () => 1).indexOf(member);

const run = (combo, handleSingleModel, extra = {}) =>
  handleComboChat({
    body: {},
    models: ["p/a"],
    comboName: combo,
    comboStrategy: "fastest",
    log,
    handleSingleModel,
    ...extra,
  });

describe("combo attempt feedback (streamed fastest)", () => {
  it("samples firstTokenAt (3000ms), not response-headers/return time", async () => {
    seed("c1");
    await run("c1", async (_b, _m, attempt) => {
      expect(typeof attempt.registerStream).toBe("function");
      const settle = attempt.registerStream();
      expect(typeof settle).toBe("function");
      now = 1050; // headers + role + heartbeat happened around here
      now = 4000; // first meaningful token
      settle({ firstTokenAt: 4000, error: null, cancelled: false });
      now = 4100; // handleSingleModel returns the Response afterwards
      return ok();
    });
    expect(slot("c1", "p/a")).toBe(2); // 3000ms; a header-time sample (~50) would be slot 1
  });

  it("error after content: ONE failure-penalty sample, not success+penalty", async () => {
    seed("c2");
    await run("c2", async (_b, _m, attempt) => {
      const settle = attempt.registerStream();
      now = 1500;
      settle({ firstTokenAt: 1200, error: { message: "boom" }, cancelled: false });
      return ok();
    });
    // single 10000 sample -> slot 3; success(200)+penalty(10000) median 5100 -> slot 2.
    expect(slot("c2", "p/a")).toBe(3);
  });

  it("empty stream (no meaningful token): no sample", async () => {
    seed("c3");
    await run("c3", async (_b, _m, attempt) => {
      attempt.registerStream()({ firstTokenAt: null, error: null, cancelled: false });
      return ok();
    });
    expect(slot("c3", "p/a")).toBe(0);
  });

  it("explicit downstream cancel: no sample, even with a token and an error", async () => {
    seed("c4");
    await run("c4", async (_b, _m, attempt) => {
      attempt.registerStream()({ firstTokenAt: 1200, error: { message: "x" }, cancelled: true });
      return ok();
    });
    expect(slot("c4", "p/a")).toBe(0);
  });

  it("settles exactly once: a later settle() is ignored", async () => {
    seed("c5");
    await run("c5", async (_b, _m, attempt) => {
      const settle = attempt.registerStream();
      settle({ firstTokenAt: 1100, error: null, cancelled: false }); // 100ms
      settle({ firstTokenAt: 9900, error: null, cancelled: false }); // ignored
      settle({ firstTokenAt: null, error: { message: "late" }, cancelled: false }); // ignored
      return ok();
    });
    expect(slot("c5", "p/a")).toBe(1);
  });

  it("non-streamed success (no registerStream) samples at return time, unchanged", async () => {
    seed("c6");
    await run("c6", async (_b, _m, attempt) => {
      expect(typeof attempt.registerStream).toBe("function");
      now = 1100;
      return ok();
    });
    expect(slot("c6", "p/a")).toBe(1); // 100ms
  });

  it("registerStream after the attempt failed returns null (no stale register)", async () => {
    seed("c7");
    let late;
    await handleComboChat({
      body: {},
      models: ["p/a", "p/b"],
      comboName: "c7",
      comboStrategy: "fastest",
      log,
      handleSingleModel: async (_b, m, attempt) => {
        if (m === "p/a") {
          late = attempt;
          return err();
        }
        return ok();
      },
    });
    expect(late.registerStream()).toBeNull();
  });
});

describe("combo feedback is limited to live fastest traffic", () => {
  it("probe runs (onAttempt) keep handleSingleModel at 2 args and record nothing", async () => {
    seed("c8");
    const arity = [];
    await run(
      "c8",
      async (...args) => {
        arity.push(args.length);
        return ok();
      },
      { onAttempt: () => {} },
    );
    expect(arity).toEqual([2]);
    expect(slot("c8", "p/a")).toBe(0);
  });

  it("non-fastest strategies get no attempt arg", async () => {
    const arity = [];
    await run(
      "c9",
      async (...args) => {
        arity.push(args.length);
        return ok();
      },
      { comboStrategy: "fallback" },
    );
    expect(arity).toEqual([2]);
  });
});

describe("nested combos", () => {
  it("inner leaf register chains up: each level samples its member exactly once", async () => {
    seed("outer2");
    seed("inner2");
    await run(
      "outer2",
      async (_b, _m, attempt) => {
        const res = await handleComboChat({
          body: {},
          models: ["p/z"],
          comboName: "inner2",
          comboStrategy: "fastest",
          log,
          parentAttempt: attempt,
          handleSingleModel: async (_ib, _im, innerAttempt) => {
            now = 4000;
            innerAttempt.registerStream()({ firstTokenAt: 4000, error: null, cancelled: false });
            return ok();
          },
        });
        return res;
      },
      { models: ["combo/inner2"] },
    );
    // 3000ms at both levels. A duplicate (token + return-time) sample at the outer
    // level would give median < 2000 -> slot 1.
    expect(slot("inner2", "p/z")).toBe(2);
    expect(slot("outer2", "combo/inner2")).toBe(2);
  });

  it("inner failure never registers upward: outer takes a failure penalty only", async () => {
    seed("outer3");
    seed("inner3");
    let outerAttempt;
    const res = await run(
      "outer3",
      async (_b, m, attempt) => {
        if (m !== "combo/inner3") return ok();
        outerAttempt = attempt;
        return handleComboChat({
          body: {},
          models: ["p/x", "p/y"],
          comboName: "inner3",
          comboStrategy: "fastest",
          log,
          parentAttempt: attempt,
          handleSingleModel: async () => err(),
        });
      },
      { models: ["combo/inner3", "p/direct"] },
    );
    expect(res.ok).toBe(true);
    expect(outerAttempt.registered).toBe(false);
    expect(slot("outer3", "combo/inner3")).toBe(3); // one 10s failure sample
    expect(slot("inner3", "p/x")).toBe(3);
    expect(slot("inner3", "p/y")).toBe(3);
  });
});

describe("workspace isolation", () => {
  it("samples are keyed by comboName (workspace rotation key); other workspaces untouched", async () => {
    seed("ws:1:combo");
    seed("ws:2:combo");
    await run("ws:1:combo", async (_b, _m, attempt) => {
      attempt.registerStream()({ firstTokenAt: 4000, error: null, cancelled: false });
      return ok();
    });
    expect(slot("ws:1:combo", "p/a")).toBe(2);
    expect(slot("ws:2:combo", "p/a")).toBe(0);
  });
});
