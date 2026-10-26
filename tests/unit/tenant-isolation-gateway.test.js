// YAN-378 part 1/3: workspace-scoped /v1/models catalog (list, detail) and the
// chat-family generation entry points (chat/completions, completions, messages,
// responses, fim/completions, embeddings) plus metering/catalog endpoints
// (messages/count_tokens no-resolution guard, audio/voices credentials).
// Siblings: tenant-isolation-gateway-controls (grants/budgets/lifecycle) and
// tenant-isolation-gateway-extra-routes (media/search/models-info parity).
// LIMITS: no timing benchmark; streaming release timing is budgets-gateway's.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  proxyAwareFetch: (url, options) => globalThis.fetch(url, options),
}));

// featureSwitch reads TOKENHOP_MULTI_USER at module load: set before imports.
const { executeMock, fetchCalls, savedEnv } = vi.hoisted(() => {
  const savedEnv = {
    TOKENHOP_MULTI_USER: process.env.TOKENHOP_MULTI_USER,
    TOKENHOP_MASTER_KEY: process.env.TOKENHOP_MASTER_KEY,
  };
  process.env.TOKENHOP_MULTI_USER = "on";
  return { executeMock: vi.fn(), fetchCalls: { urls: [], requests: [] }, savedEnv };
});

vi.stubGlobal(
  "fetch",
  vi.fn(async (url, init) => {
    fetchCalls.urls.push(String(url));
    fetchCalls.requests.push({ url: String(url), init, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
);

// Live provider catalogs are external metadata, not tenant authorization.
// Leave all DB/auth/model resolution real; disable unrelated public probes.
vi.mock("@/lib/providerModels/liveResolvers.js", async (importOriginal) => ({
  ...(await importOriginal()),
  hasLiveModelResolver: () => false,
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  notifyRequestLogsEnabled: vi.fn(),
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    trackPendingRequest: vi.fn(),
    appendRequestLog: vi.fn(async () => {}),
    saveRequestDetailUnscoped: vi.fn(async () => {}),
  };
});

import { GET as listModels } from "@/app/api/v1/models/route.js";
import { GET as lookupModel } from "@/app/api/v1/models/[...model]/route.js";
import { POST as chatPost } from "@/app/api/v1/chat/completions/route.js";
import { POST as completionsPost } from "@/app/api/v1/completions/route.js";
import { POST as messagesPost } from "@/app/api/v1/messages/route.js";
import { POST as responsesPost } from "@/app/api/v1/responses/route.js";
import { POST as fimPost } from "@/app/api/v1/fim/completions/route.js";
import { POST as embeddingsPost } from "@/app/api/v1/embeddings/route.js";
import { POST as countTokensPost } from "@/app/api/v1/messages/count_tokens/route.js";
import { GET as voicesGet } from "@/app/api/v1/audio/voices/route.js";
import {
  TOKEN_A,
  observeResponse,
  TOKEN_B,
  okUpstream,
  req,
  post,
  restoreEnv,
  seedGatewayWorld,
} from "../helpers/tenantIsolation/gatewayWorld.js";

let world;

beforeEach(async () => {
  fetchCalls.urls.length = 0;
  fetchCalls.requests.length = 0;
  executeMock.mockReset();
  executeMock.mockResolvedValue(okUpstream());
  world = await seedGatewayWorld();
});

afterEach(() => {
  delete process.env.TOKENHOP_MASTER_KEY;
});

afterAll(() => restoreEnv(savedEnv));

describe("workspace-scoped catalog", () => {
  it("catalog lists only the key's own workspace resources", async () => {
    const res = await listModels(req("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    const ids = (await (await observeResponse(res)).json()).data.map((m) => m.id);
    expect(ids).toContain("anthropic/claude-3-5-sonnet-20241022");
    expect(ids).not.toContain("combo-w1");
    expect(ids).not.toContain("alias-w1");
    expect(ids).not.toContain("openai/custom-w1-model");
    expect(ids.every((id) => !id.startsWith("nodew1/"))).toBe(true);
    // A disabled openai/gpt-4o-mini; that disable never bleeds into B's catalog
    // and B still has no openai connection at all.
    expect(ids.every((id) => !id.startsWith("openai/"))).toBe(true);
    // A's compatible node is never probed from B's request.
    expect(fetchCalls.urls).toEqual([]);
  });

  it.each(["combo-w1", "alias-w1", ["openai", "custom-w1-model"], ["openai", "gpt-4o"]])(
    "detail %s: other-workspace id and unknown id answer the same",
    async (...path) => {
      const other = await lookupModel(req(`http://localhost/v1/models/${path.flat().join("/")}`), {
        params: Promise.resolve({ model: path.flat() }),
      });
      const missing = await lookupModel(req("http://localhost/v1/models/nope/nope-0000"), {
        params: Promise.resolve({ model: ["nope", "nope-0000"] }),
      });
      expect(other.status).toBe(404);
      expect(other.status).toBe(missing.status);
      const scrub = (body, id) => JSON.stringify(body).replaceAll(id, "<id>");
      const otherId = path.flat().join("/");
      const scrubbedOther = scrub(await (await observeResponse(other)).json(), otherId);
      const scrubbedMissing = scrub(
        await (await observeResponse(missing)).json(),
        "nope/nope-0000",
      );
      // Identical status/type/code; the only difference is the echo of the
      // caller's own requested identifier — no new information disclosed.
      expect(scrubbedOther).toEqual(scrubbedMissing);
      expect(scrubbedOther).not.toContain("w1-node.test");
    },
  );

  it("control: owning workspace key lists its own resources", async () => {
    const res = await listModels(req("http://localhost/v1/models", TOKEN_A));
    expect(res.status).toBe(200);
    const ids = (await (await observeResponse(res)).json()).data.map((m) => m.id);
    expect(ids).toContain("combo-w1");
    expect(ids).toContain("openai/custom-w1-model");
    expect(ids).toContain("openai/gpt-4o");
    expect(ids).not.toContain("openai/gpt-4o-mini"); // disabled in wA
  });
});

describe("workspace-scoped chat-family entry points", () => {
  const UNKNOWN = "no-such-name-00000000";
  const entryPoints = [
    [
      "chat/completions",
      (m) =>
        chatPost(
          post("http://localhost/v1/chat/completions", {
            model: m,
            messages: [{ role: "user", content: "hi" }],
          }),
        ),
    ],
    [
      "completions",
      (m) => completionsPost(post("http://localhost/v1/completions", { model: m, prompt: "hi" })),
    ],
    [
      "messages",
      (m) =>
        messagesPost(
          post("http://localhost/v1/messages", {
            model: m,
            max_tokens: 10,
            messages: [{ role: "user", content: "hi" }],
          }),
        ),
    ],
    [
      "responses",
      (m) => responsesPost(post("http://localhost/v1/responses", { model: m, input: "hi" })),
    ],
    [
      "fim",
      (m) =>
        fimPost(
          post("http://localhost/v1/fim/completions", { model: m, prompt: "def", suffix: "" }),
        ),
    ],
    [
      "embeddings",
      (m) => embeddingsPost(post("http://localhost/v1/embeddings", { model: m, input: "hi" })),
    ],
    [
      // Intentional no-resolution guard: metering accepts caller model labels.
      // Equality plus zero fetch/executor verifies labels never dispatch upstream.
      "messages/count_tokens",
      (m) =>
        countTokensPost(
          post("http://localhost/v1/messages/count_tokens", {
            model: m,
            messages: [{ role: "user", content: "hi" }],
          }),
        ),
    ],
  ];

  it.each(entryPoints)(
    "%s: other-workspace combo and alias names answer like unknown names; no upstream",
    async (_name, call) => {
      const results = {};
      for (const model of ["combo-w1", "alias-w1", UNKNOWN]) {
        const res = await call(model);
        results[model] = { status: res.status, body: await res.json() };
      }
      expect(results["combo-w1"]).toEqual(results[UNKNOWN]);
      expect(results["alias-w1"]).toEqual(results[UNKNOWN]);
      expect(executeMock).not.toHaveBeenCalled();
      expect(fetchCalls.urls).toEqual([]);
    },
  );

  it("audio/voices uses only the key's own workspace connection; another workspace's credential is never fetched with", async () => {
    world.conn("conn-eleven-w1", "elevenlabs", "wA", { data: { apiKey: "sk-eleven-w1" } });
    // wB's key: no elevenlabs connection of its own → structured 400, no
    // upstream voice-catalog fetch (and so no use of wA's credential).
    const denied = await voicesGet(
      new Request("http://localhost/v1/audio/voices?provider=elevenlabs", {
        headers: { authorization: `Bearer ${TOKEN_B}` },
      }),
    );
    expect(denied.status).toBe(400);
    expect((await denied.json()).error?.message).toContain("connection");
    expect(executeMock).not.toHaveBeenCalled();
    expect(fetchCalls.requests).toEqual([]);
    // Control: wA's key reaches the (stubbed) upstream catalog fetch with wA's
    // own credential — proving the stub captures init/headers.
    const own = await voicesGet(
      new Request("http://localhost/v1/audio/voices?provider=elevenlabs", {
        headers: { authorization: `Bearer ${TOKEN_A}` },
      }),
    );
    expect(own.status).toBe(200);
    expect(fetchCalls.requests).toHaveLength(1);
    expect(fetchCalls.requests[0].headers.get("xi-api-key")).toBe("sk-eleven-w1");
  });

  it("canonical provider/model without an own connection is not routed", async () => {
    const res = await chatPost(
      post("http://localhost/v1/chat/completions", {
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error?.message ?? "").toContain("openai");
    expect(executeMock).not.toHaveBeenCalled();
  });
});
