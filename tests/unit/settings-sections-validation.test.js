import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-settings-sections-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const settingsPatch = (body) =>
  import("@/app/api/settings/route.js").then(({ PATCH }) =>
    PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    ),
  );

const expect400 = async (body) => {
  // Round-trip through JSON so "__proto__" arrives as an own key, like the real API path.
  const res = await settingsPatch(JSON.parse(JSON.stringify(body)));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBeTruthy();
};

const expect200 = async (body, key, value) => {
  const res = await settingsPatch(body);
  expect(res.status).toBe(200);
  if (key !== undefined) expect((await res.json())[key]).toEqual(value);
};

describe("YAN-310 routing validation", () => {
  it("accepts valid fallbackStrategy and stickyRoundRobinLimit", async () => {
    await expect200({ fallbackStrategy: "round-robin" }, "fallbackStrategy", "round-robin");
    await expect200({ stickyRoundRobinLimit: 3 }, "stickyRoundRobinLimit", 3);
    await expect200({ fallbackStrategy: "fill-first" }, "fallbackStrategy", "fill-first");
  });

  it("rejects bad strategy / sticky limit", async () => {
    await expect400({ fallbackStrategy: "random" });
    await expect400({ fallbackStrategy: 42 });
    for (const bad of [0, -1, 1.5, "3", NaN, Infinity, 10 ** 9]) {
      await expect400({ stickyRoundRobinLimit: bad });
    }
  });

  it("accepts valid comboStrategy and comboStickyRoundRobinLimit", async () => {
    await expect200({ comboStrategy: "round-robin" }, "comboStrategy", "round-robin");
    await expect200({ comboStickyRoundRobinLimit: 5 }, "comboStickyRoundRobinLimit", 5);
    await expect200({ comboStrategy: "fallback" }, "comboStrategy", "fallback");
    await expect200({ comboStickyRoundRobinLimit: 1 }, "comboStickyRoundRobinLimit", 1);
  });

  it("rejects bad comboStrategy / combo sticky limit", async () => {
    await expect400({ comboStrategy: "random" });
    await expect400({ comboStickyRoundRobinLimit: 0 });
    await expect400({ comboStickyRoundRobinLimit: 1.5 });
    await expect400({ comboStickyRoundRobinLimit: "5" });
  });

  it("accepts valid providerStrategies map", async () => {
    await expect200(
      {
        providerStrategies: {
          anthropic: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 5 },
        },
      },
      "providerStrategies",
      { anthropic: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 5 } },
    );
    await expect200({ providerStrategies: {} }, "providerStrategies", {});
  });

  it("rejects malformed providerStrategies", async () => {
    await expect400({ providerStrategies: [] });
    await expect400({ providerStrategies: { anthropic: { fallbackStrategy: "nope" } } });
    await expect400({ providerStrategies: { anthropic: { stickyRoundRobinLimit: 0 } } });
    await expect400({ providerStrategies: { anthropic: "round-robin" } });
    await expect400(
      JSON.parse('{"providerStrategies":{"__proto__":{"fallbackStrategy":"weighted"}}}'),
    );
    await expect400(JSON.parse('{"providerStrategies":{"anthropic":{"__proto__":"weighted"}}}'));
    // Non-routing keys owned by other pages are allowed through untouched:
    // NoAuthProxyCard writes proxyPoolId + rotateStrategy into the same map.
    await expect200({
      providerStrategies: {
        anthropic: { proxyPoolId: "pool-1", rotateStrategy: "round-robin" },
      },
    });
    await expect400({
      providerStrategies: { anthropic: { proxyPoolId: "", rotateStrategy: "round-robin" } },
    });
    await expect400({
      providerStrategies: { anthropic: { rotateStrategy: "sideways" } },
    });
  });

  it("accepts valid capacityAdapter entries (Combos page writer)", async () => {
    await expect200(
      { capacityAdapter: { vision: { enabled: true, roundRobin: false, models: ["oc/x"] } } },
      "capacityAdapter",
      { vision: { enabled: true, roundRobin: false, models: ["oc/x"] } },
    );
    // Legacy array form stored by old clients is normalized by the consumer.
    await expect200({ capacityAdapter: { vision: ["oc/x"] } });
  });

  it("rejects malformed capacityAdapter entries", async () => {
    await expect400({ capacityAdapter: [] });
    await expect400({ capacityAdapter: { bogus: { enabled: true } } });
    await expect400(JSON.parse('{"capacityAdapter":{"__proto__":{"enabled":true}}}'));
    await expect400({ capacityAdapter: { vision: { enabled: "yes" } } });
    await expect400({ capacityAdapter: { vision: { roundRobin: 1 } } });
    await expect400({ capacityAdapter: { vision: { models: "oc/x" } } });
    await expect400({ capacityAdapter: { vision: { enabled: true, hack: 1 } } });
  });
});

describe("YAN-310 network validation", () => {
  it("accepts valid proxy toggle/url/no-proxy", async () => {
    await expect200({ outboundProxyEnabled: true }, "outboundProxyEnabled", true);
    await expect200(
      { outboundProxyUrl: "http://proxy:8080" },
      "outboundProxyUrl",
      "http://proxy:8080",
    );
    await expect200(
      { outboundProxyUrl: "socks5://proxy:1080" },
      "outboundProxyUrl",
      "socks5://proxy:1080",
    );
    await expect200({ outboundProxyUrl: "" }, "outboundProxyUrl", "");
    await expect200(
      { outboundNoProxy: "localhost,example.com" },
      "outboundNoProxy",
      "localhost,example.com",
    );
    await expect200({ outboundNoProxy: "" }, "outboundNoProxy", "");
    await expect200({ outboundProxyEnabled: false }, "outboundProxyEnabled", false);
  });

  it("rejects bad proxy url / no-proxy", async () => {
    await expect400({ outboundProxyEnabled: "yes" });
    await expect400({ outboundProxyUrl: "ftp://proxy:21" });
    await expect400({ outboundProxyUrl: "not a url" });
    await expect400({ outboundProxyUrl: "http://proxy:8080\nEvil: 1" });
    await expect400({ outboundProxyUrl: "gopher://x" });
    await expect400({ outboundProxyUrl: "x".repeat(3000) });
    await expect400({ outboundNoProxy: "good.com,\nbad" });
    await expect400({ outboundNoProxy: 42 });
  });

  it("accepts tunnel/tailscale toggles, rejects read-only env keys", async () => {
    await expect200({ tunnelEnabled: true }, "tunnelEnabled", true);
    await expect200({ tailscaleEnabled: false }, "tailscaleEnabled", false);
    await expect200({ tunnelEnabled: false }, "tunnelEnabled", false);
    await expect400({ tunnelEnabled: "yes" });
    await expect400({ tunnelProvider: "tailscale" });
    await expect400({ SEARXNG_URL: "https://x" });
    await expect400({ CLAUDE_CLI_VERSION: "1.0.0" });
    await expect400({ CODEX_CLI_VERSION: "1.0.0" });
    await expect400({ ZED_CLIENT_VERSION: "1.0.0" });
  });
});

describe("YAN-310 token saver validation", () => {
  it("accepts valid toggles, levels, headroom and pxpipe params", async () => {
    await expect200({ rtkEnabled: true }, "rtkEnabled", true);
    await expect200({ headroomEnabled: false }, "headroomEnabled", false);
    await expect200(
      { headroomUrl: "http://localhost:8787" },
      "headroomUrl",
      "http://localhost:8787",
    );
    await expect200({ headroomUrl: "" }, "headroomUrl", "");
    await expect200({ headroomTimeoutMs: 3000 }, "headroomTimeoutMs", 3000);
    await expect200({ headroomCompressUserMessages: true }, "headroomCompressUserMessages", true);
    await expect200({ cavemanEnabled: true }, "cavemanEnabled", true);
    await expect200({ cavemanLevel: "ultra" }, "cavemanLevel", "ultra");
    await expect200({ cavemanLevel: "wenyan" }, "cavemanLevel", "wenyan");
    await expect200({ ponytailEnabled: false }, "ponytailEnabled", false);
    await expect200({ ponytailLevel: "lite" }, "ponytailLevel", "lite");
    await expect200({ pxpipeEnabled: true }, "pxpipeEnabled", true);
    await expect200({ pxpipeMinChars: 25000 }, "pxpipeMinChars", 25000);
    await expect200({ pxpipeMinChars: 0 }, "pxpipeMinChars", 0);
    await expect200({ pxpipeTimeoutMs: 15000 }, "pxpipeTimeoutMs", 15000);
    await expect200({ pxpipeAutoInstall: false }, "pxpipeAutoInstall", false);
    await expect200({ rtkEnabled: true }, "rtkEnabled", true);
    await expect200({ cavemanEnabled: false }, "cavemanEnabled", false);
    await expect200({ cavemanLevel: "full" }, "cavemanLevel", "full");
    await expect200({ ponytailLevel: "full" }, "ponytailLevel", "full");
    await expect200({ pxpipeEnabled: false }, "pxpipeEnabled", false);
  });

  it("rejects bad token saver values", async () => {
    await expect400({ rtkEnabled: "yes" });
    await expect400({ headroomUrl: "ftp://x" });
    await expect400({ headroomUrl: "http://x\nEvil: 1" });
    await expect400({ headroomTimeoutMs: 0 });
    await expect400({ headroomTimeoutMs: -5 });
    await expect400({ headroomTimeoutMs: 1.5 });
    await expect400({ cavemanLevel: "extreme" });
    await expect400({ ponytailLevel: "wenyan" });
    await expect400({ pxpipeMinChars: -1 });
    await expect400({ pxpipeMinChars: 1.5 });
    await expect400({ pxpipeTimeoutMs: 0 });
    await expect400({ pxpipeAutoInstall: "yes" });
  });
});

describe("YAN-310 providers & models validation", () => {
  it("accepts valid providerThinking / auto-ping / quotaVisibility / mitm", async () => {
    await expect200({ providerThinking: { anthropic: { mode: "high" } } }, "providerThinking", {
      anthropic: { mode: "high" },
    });
    await expect200({ providerThinking: {} }, "providerThinking", {});
    await expect200(
      { claudeAutoPing: { enabled: true, connections: { c1: true } } },
      "claudeAutoPing",
      { enabled: true, connections: { c1: true } },
    );
    await expect200({ codexAutoPing: { enabled: false, connections: {} } }, "codexAutoPing", {
      enabled: false,
      connections: {},
    });
    await expect200({ ccFilterNaming: true }, "ccFilterNaming", true);
    await expect200({ ccFilterNaming: false }, "ccFilterNaming", false);
    await expect200(
      { quotaVisibility: { anthropic: { hidden: ["model-a"] } } },
      "quotaVisibility",
      { anthropic: { hidden: ["model-a"] } },
    );
    await expect200({ quotaVisibility: {} }, "quotaVisibility", {});
    await expect200(
      { mitmRouterBaseUrl: "http://localhost:20128" },
      "mitmRouterBaseUrl",
      "http://localhost:20128",
    );
    await expect200({ mitmRouterBaseUrl: "" }, "mitmRouterBaseUrl", "");
  });

  it("rejects malformed provider maps and urls", async () => {
    await expect400({ providerThinking: [] });
    await expect400({ providerThinking: { anthropic: { mode: "turbo" } } });
    await expect400({ providerThinking: { anthropic: "high" } });
    await expect400(JSON.parse('{"providerThinking":{"__proto__":{"mode":"high"}}}'));
    await expect400({ providerThinking: { anthropic: { mode: "high", extra: 1 } } });
    await expect200({ claudeAutoPing: { enabled: true } }, "claudeAutoPing", { enabled: true });
    await expect400({ claudeAutoPing: { enabled: "yes", connections: {} } });
    await expect400({
      claudeAutoPing: { enabled: true, connections: { c1: "yes" } },
    });
    await expect400({ claudeAutoPing: [] });
    await expect400({ ccFilterNaming: "yes" });
    await expect400({ quotaVisibility: [] });
    await expect400({ quotaVisibility: { anthropic: { hidden: "model-a" } } });
    await expect400({ quotaVisibility: { anthropic: { hidden: [42] } } });
    await expect400({ quotaVisibility: { anthropic: {} } });
    await expect400({ mitmRouterBaseUrl: "ftp://x" });
    await expect400({ mitmRouterBaseUrl: "http://x\nEvil: 1" });
  });
});

describe("YAN-310 observability validation", () => {
  it("accepts valid observability values", async () => {
    await expect200({ enableObservability: true }, "enableObservability", true);
    await expect200({ observabilityMaxRecords: 1000 }, "observabilityMaxRecords", 1000);
    await expect200({ observabilityBatchSize: 20 }, "observabilityBatchSize", 20);
    await expect200({ observabilityFlushIntervalMs: 5000 }, "observabilityFlushIntervalMs", 5000);
    await expect200({ observabilityMaxJsonSize: 5 }, "observabilityMaxJsonSize", 5);
    await expect200({ enableObservability: false }, "enableObservability", false);
  });

  it("rejects bad observability values", async () => {
    await expect400({ enableObservability: "yes" });
    await expect400({ observabilityMaxRecords: 0 });
    await expect400({ observabilityMaxRecords: 1.5 });
    await expect400({ observabilityBatchSize: 0 });
    await expect400({ observabilityFlushIntervalMs: 0 });
    await expect400({ observabilityFlushIntervalMs: -1 });
    await expect400({ observabilityMaxJsonSize: 0 });
    await expect400({ observabilityMaxJsonSize: "5" });
  });

  it("rejects control characters smuggled in URLs", async () => {
    await expect400({ outboundProxyUrl: "http://proxy:8080\u0009x" });
    await expect400({ headroomUrl: "http://x\u0007" });
    await expect400({ outboundNoProxy: "good.com,\u0000bad" });
  });

  it("rejects prototype pollution keys", async () => {
    await expect400(JSON.parse('{"__proto__":true}'));
    await expect400({ constructor: true });
    await expect400({ prototype: true });
    const res = await settingsPatch(JSON.parse('{"enableObservability":true,"__proto__":true}'));
    expect(res.status).toBe(400);
  });
});
