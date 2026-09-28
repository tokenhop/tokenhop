import { describe, it, expect } from "vitest";
import {
  WINDOW_MS,
  EDGE_STATE_LABEL,
  identifyClient,
  buildLiveRoutes,
} from "@/lib/home/liveRoutes.js";

const NOW = new Date("2026-09-26T12:00:00Z").getTime();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function usage(overrides = {}) {
  return {
    timestamp: iso(60_000),
    provider: "openrouter",
    model: "m1",
    keyName: "nightly-job",
    userAgent: null,
    comboName: null,
    ...overrides,
  };
}

function failure(overrides = {}) {
  return {
    timestamp: iso(60_000),
    provider: "gemini-cli",
    model: "m1",
    status: "429",
    ...overrides,
  };
}

describe("live routes windowing", () => {
  it("keeps only requests inside the rolling 5-minute window", () => {
    const routes = buildLiveRoutes({
      usageRows: [
        usage({ timestamp: iso(WINDOW_MS - 1_000), provider: "a" }),
        usage({ timestamp: iso(WINDOW_MS + 60_000), provider: "b" }),
      ],
      now: NOW,
    });
    expect(routes.edges.map((e) => e.to)).toEqual(["a"]);
  });

  it("counts requests exactly at the window edge as out", () => {
    const routes = buildLiveRoutes({
      usageRows: [usage({ timestamp: iso(WINDOW_MS), provider: "a" })],
      now: NOW,
    });
    expect(routes.edges).toHaveLength(0);
  });

  it("drops error rows outside the window", () => {
    const routes = buildLiveRoutes({
      usageRows: [usage({ provider: "openrouter" })],
      errorRows: [failure({ timestamp: iso(WINDOW_MS + 1_000), status: "500" })],
      now: NOW,
    });
    expect(routes.providers.find((p) => p.id === "openrouter").state).toBe("flowing");
  });

  it("returns an empty model with no rows", () => {
    expect(buildLiveRoutes({ now: NOW })).toEqual({
      clients: [],
      providers: [],
      edges: [],
      fallbacks: [],
    });
  });
});

describe("client identification", () => {
  it("prefers the API key name over the user agent", () => {
    expect(identifyClient({ keyName: "nightly-job", userAgent: "claude-code/2.1.0" })).toBe(
      "nightly-job",
    );
  });

  it("maps claude-code UA to Claude Code", () => {
    expect(identifyClient({ userAgent: "claude-code/2.1.0" })).toBe("Claude Code");
  });

  it("maps codex UA to Codex CLI", () => {
    expect(identifyClient({ userAgent: "codex-cli/1.2.3" })).toBe("Codex CLI");
  });

  it("maps cursor UA to Cursor", () => {
    expect(identifyClient({ userAgent: "Cursor/0.42.0" })).toBe("Cursor");
  });

  it("maps curl UA to curl", () => {
    expect(identifyClient({ userAgent: "curl/8.5.0" })).toBe("curl");
  });

  it("falls back to Unknown client with neither key nor known UA", () => {
    expect(identifyClient({})).toBe("Unknown client");
    expect(identifyClient({ keyName: null, userAgent: null })).toBe("Unknown client");
  });

  it("groups edges by key name", () => {
    const routes = buildLiveRoutes({
      usageRows: [usage({ keyName: "job-a" }), usage({ keyName: "job-a" })],
      now: NOW,
    });
    expect(routes.clients).toEqual([{ id: "job-a", count: 2 }]);
    expect(routes.edges[0]).toMatchObject({ from: "job-a", to: "openrouter", count: 2 });
  });
});

describe("edge state precedence", () => {
  it("error beats flowing", () => {
    const routes = buildLiveRoutes({
      usageRows: [usage({ provider: "p" })],
      errorRows: [failure({ provider: "p", status: "500" })],
      now: NOW,
    });
    expect(routes.providers.find((p) => p.id === "p").state).toBe("error");
  });

  it("cooling (429) beats flowing", () => {
    const routes = buildLiveRoutes({
      usageRows: [usage({ provider: "p" })],
      errorRows: [failure({ provider: "p", status: "429" })],
      now: NOW,
    });
    expect(routes.providers.find((p) => p.id === "p").state).toBe("cooling");
  });

  it("active lock cools even with only flowing traffic", () => {
    const routes = buildLiveRoutes({
      usageRows: [usage({ provider: "p", model: "m1" })],
      connections: [{ provider: "p", modelLock_m1: new Date(NOW + 60_000).toISOString() }],
      now: NOW,
    });
    expect(routes.providers.find((p) => p.id === "p").state).toBe("cooling");
  });

  it("idle provider stays idle", () => {
    const routes = buildLiveRoutes({
      usageRows: [usage({ provider: "other" })],
      connections: [{ provider: "p", name: "P" }],
      now: NOW,
    });
    expect(routes.providers.find((p) => p.id === "p").state).toBe("idle");
  });

  it("expired locks do not cool", () => {
    const routes = buildLiveRoutes({
      usageRows: [usage({ provider: "p", model: "m1" })],
      connections: [{ provider: "p", modelLock_m1: new Date(NOW - 60_000).toISOString() }],
      now: NOW,
    });
    expect(routes.providers.find((p) => p.id === "p").state).toBe("flowing");
  });

  it("cools when a 429 has zero successful rows", () => {
    const routes = buildLiveRoutes({
      errorRows: [failure({ provider: "p", status: "429" })],
      now: NOW,
    });
    expect(routes.providers.find((p) => p.id === "p").state).toBe("cooling");
  });

  it("edges inherit the provider state", () => {
    const routes = buildLiveRoutes({
      usageRows: [usage({ provider: "p" })],
      errorRows: [failure({ provider: "p", status: "500" })],
      now: NOW,
    });
    expect(routes.edges[0].state).toBe("error");
  });

  it("labels every state", () => {
    expect(EDGE_STATE_LABEL).toEqual({
      error: "Error",
      cooling: "Cooling down",
      flowing: "Flowing",
      idle: "Idle",
    });
  });
});

describe("fallback extraction", () => {
  function hop(overrides = {}) {
    return {
      timestamp: iso(90_000),
      comboName: "coder",
      provider: "gemini-cli",
      model: "m",
      status: 429,
      ...overrides,
    };
  }

  it("pairs a recorded failed step with the combo's winning provider", () => {
    const routes = buildLiveRoutes({
      usageRows: [usage({ provider: "openrouter", comboName: "coder" })],
      fallbackHops: [hop()],
      providerNames: { "gemini-cli": "Gemini CLI", openrouter: "OpenRouter" },
      now: NOW,
    });
    expect(routes.fallbacks).toEqual([
      {
        from: "gemini-cli",
        fromName: "Gemini CLI",
        to: "openrouter",
        toName: "OpenRouter",
        status: 429,
        cooldownUntil: null,
      },
    ]);
  });

  it("ignores hops outside the window", () => {
    const routes = buildLiveRoutes({
      usageRows: [usage({ provider: "openrouter", comboName: "coder" })],
      fallbackHops: [hop({ timestamp: iso(WINDOW_MS + 1_000) })],
      now: NOW,
    });
    expect(routes.fallbacks).toHaveLength(0);
  });

  it("ignores hops of another combo", () => {
    const routes = buildLiveRoutes({
      usageRows: [usage({ provider: "openrouter", comboName: "coder" })],
      fallbackHops: [hop({ comboName: "other" })],
      now: NOW,
    });
    expect(routes.fallbacks).toHaveLength(0);
  });

  it("ignores hops with no later win", () => {
    const routes = buildLiveRoutes({
      usageRows: [usage({ provider: "openrouter", comboName: "coder", timestamp: iso(120_000) })],
      fallbackHops: [hop({ timestamp: iso(60_000) })],
      now: NOW,
    });
    expect(routes.fallbacks).toHaveLength(0);
  });

  it("ignores same-provider retries", () => {
    const routes = buildLiveRoutes({
      usageRows: [usage({ provider: "gemini-cli", comboName: "coder" })],
      fallbackHops: [hop()],
      now: NOW,
    });
    expect(routes.fallbacks).toHaveLength(0);
  });

  it("dedupes repeated hops between the same pair", () => {
    const routes = buildLiveRoutes({
      usageRows: [usage({ provider: "openrouter", comboName: "coder" })],
      fallbackHops: [hop(), hop({ timestamp: iso(80_000) })],
      now: NOW,
    });
    expect(routes.fallbacks).toHaveLength(1);
  });

  it("attaches the cooling expiry of the fallen-back-from provider", () => {
    const until = new Date(NOW + 120_000).toISOString();
    const routes = buildLiveRoutes({
      usageRows: [usage({ provider: "openrouter", comboName: "coder" })],
      fallbackHops: [hop()],
      connections: [{ provider: "gemini-cli", modelLock_m: until }],
      now: NOW,
    });
    expect(routes.fallbacks[0].cooldownUntil).toBe(until);
  });
});
