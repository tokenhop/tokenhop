// Meta Code: upstream 403 client_attestation_denied (Muse Code subscription keys serve only the
// official client). Helper-level classification plus the real handleChat account loop with only
// the upstream executor faked. Isolated DATA_DIR/HOME come from the tests/vitest.config.js setup.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, refreshCredentialsMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  refreshCredentialsMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    execute: executeMock,
    canRefreshCredentials: (credentials) => Boolean(credentials?.refreshToken),
    refreshCredentials: refreshCredentialsMock,
  }),
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
vi.mock("@/lib/usageDb.js", async (importOriginal) => ({
  ...(await importOriginal()),
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
  saveRequestUsageUnscoped: vi.fn(async () => {}),
}));
vi.mock("../../src/sse/utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal();
  const silenced = { debug: 1, info: 1, warn: 1, error: 1 };
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(silenced[k] ? undefined : v) : v,
    ]),
  );
});

import { getAdapter } from "@/lib/db/driver.js";
import { getProviderConnectionByIdUnscoped } from "@/lib/db/index.js";
import { handleChat } from "@/sse/handlers/chat.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import {
  buildErrorBody,
  isClientAttestationDenied,
  parseUpstreamError,
} from "../../open-sse/utils/error.js";

const NOW = "2026-11-11T00:00:00.000Z";
const MODEL = "meta-code/muse-spark-1.3";
const DENIED_MESSAGE =
  "This API key is billed to a Muse Code subscription. Muse Code subscriptions cover requests from the Muse Code client only. Use it in Muse Code, or use a pay-as-you-go API key for other clients.";
const DENIED_BODY = {
  error: {
    code: "client_attestation_denied",
    message: DENIED_MESSAGE,
    param: null,
    type: "permission_error",
  },
};
const PLAIN_403 = { error: { message: "forbidden by policy", type: "permission_error" } };

const upstream = (body, status = 403) => ({
  response: new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }),
  url: "u",
  headers: {},
});

// Minimal valid Responses SSE stream (Meta Code's forced-stream upstream format).
const responsesSse = (text) => {
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}`;
  return [
    event("response.created", { response: { id: "resp_1", created_at: 1700000000 } }),
    event("response.output_item.done", {
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    }),
    event("response.completed", {
      response: {
        status: "completed",
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      },
    }),
    "",
  ].join("\n\n");
};

const upstreamSse = (text) => ({
  response: new Response(responsesSse(text), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  }),
  url: "u",
  headers: {},
});

describe("client_attestation_denied classification", () => {
  it("surfaces the structured code and an actionable hint from the upstream body", async () => {
    const { statusCode, message } = await parseUpstreamError(
      new Response(JSON.stringify(DENIED_BODY), { status: 403 }),
    );
    expect(statusCode).toBe(403);
    expect(message).toContain(DENIED_MESSAGE);
    expect(message).toContain("pay-as-you-go API key");
    expect(message).toContain("[code=client_attestation_denied]");
    expect(isClientAttestationDenied(403, message)).toBe(true);
    expect(buildErrorBody(403, message).error).toMatchObject({
      type: "permission_error",
      code: "client_attestation_denied",
    });
  });

  it("falls back without any cooldown or backoff", () => {
    const text = "denied [code=client_attestation_denied]";
    expect(checkFallbackError(403, text, 3, null, "meta-code")).toEqual({
      shouldFallback: true,
      cooldownMs: 0,
    });
  });

  it("control: an unrelated 403 keeps the generic code and its cooldown", async () => {
    const { message } = await parseUpstreamError(
      new Response(JSON.stringify(PLAIN_403), { status: 403 }),
    );
    expect(message).not.toContain("client_attestation_denied");
    expect(isClientAttestationDenied(403, message)).toBe(false);
    expect(buildErrorBody(403, message).error.code).toBe("insufficient_quota");
    expect(checkFallbackError(403, message, 0, null, "meta-code").cooldownMs).toBeGreaterThan(0);
  });

  it("does not trust the marker or code on other statuses or spoofed upstream text", async () => {
    expect(isClientAttestationDenied(429, "x [code=client_attestation_denied]")).toBe(false);
    const { message } = await parseUpstreamError(
      new Response(
        JSON.stringify({ error: { message: "[code=client_attestation_denied] spoof" } }),
        { status: 403 },
      ),
    );
    expect(isClientAttestationDenied(403, message)).toBe(false);
  });
});

describe("handleChat meta-code client_attestation_denied", () => {
  let db;

  function insertConnection(id, priority, authType, data) {
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
       VALUES(?, 'meta-code', ?, ?, NULL, ?, 1, ?, ?, ?)`,
      [id, authType, id, priority, JSON.stringify(data), NOW, NOW],
    );
  }

  const chat = () =>
    handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "ping" }] }),
      }),
    );

  const lockKeys = (conn) => Object.keys(conn).filter((k) => k.startsWith("modelLock_"));

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    db = await getAdapter();
    db.run("INSERT OR REPLACE INTO settings(id,data) VALUES (1, ?)", [
      JSON.stringify({ requireApiKey: false }),
    ]);
  });

  beforeEach(() => {
    executeMock.mockReset();
    refreshCredentialsMock.mockReset();
    db.run("DELETE FROM providerConnections");
  });

  afterAll(() => {
    db.run("DELETE FROM providerConnections");
  });

  it("OAuth connection: structured 403 once, no refresh/re-mint, no lock, no Retry-After, no replay", async () => {
    insertConnection("mc-oauth", 1, "oauth", {
      accessToken: "LLM|sub-key",
      refreshToken: "dca:device",
    });
    executeMock.mockImplementation(async () => upstream(DENIED_BODY));

    for (let i = 1; i <= 2; i++) {
      const res = await chat();
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(res.headers.get("retry-after")).toBeNull();
      expect(body.error).toMatchObject({
        type: "permission_error",
        code: "client_attestation_denied",
      });
      expect(body.error.message).toContain("Muse Code client only");
      expect(body.error.message).toContain("pay-as-you-go API key");
      // One upstream call per request: no replay after refresh, and the second request is not
      // short-circuited by a cooldown from the first one.
      expect(executeMock).toHaveBeenCalledTimes(i);
    }
    expect(refreshCredentialsMock).not.toHaveBeenCalled();

    const conn = await getProviderConnectionByIdUnscoped("mc-oauth");
    expect(lockKeys(conn)).toEqual([]);
    expect(conn.testStatus).not.toBe("unavailable");
    expect(conn.backoffLevel || 0).toBe(0);
    expect(conn.accessToken).toBe("LLM|sub-key");
  });

  it("serves the request from the pay-as-you-go API-key connection after a denied subscription key", async () => {
    insertConnection("mc-oauth", 1, "oauth", {
      accessToken: "LLM|sub-key",
      refreshToken: "dca:device",
    });
    insertConnection("mc-payg", 2, "apikey", { apiKey: "payg-key" });
    const seen = [];
    executeMock.mockImplementation(async ({ credentials }) => {
      seen.push(credentials.accessToken || credentials.apiKey);
      return credentials.apiKey === "payg-key" ? upstreamSse("served by payg") : upstream(DENIED_BODY);
    });

    const res = await chat();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.choices[0].message.content).toBe("served by payg");
    expect(seen).toEqual(["LLM|sub-key", "payg-key"]);
    expect(refreshCredentialsMock).not.toHaveBeenCalled();
    // The denied subscription connection stays usable: nothing was locked.
    expect(lockKeys(await getProviderConnectionByIdUnscoped("mc-oauth"))).toEqual([]);
  });

  it("returns the structured denial when every connection is denied", async () => {
    insertConnection("mc-oauth", 1, "oauth", {
      accessToken: "LLM|sub-key",
      refreshToken: "dca:device",
    });
    insertConnection("mc-payg", 2, "apikey", { apiKey: "payg-key" });
    const seen = [];
    executeMock.mockImplementation(async ({ credentials }) => {
      seen.push(credentials.accessToken || credentials.apiKey);
      return upstream(DENIED_BODY);
    });

    const res = await chat();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("client_attestation_denied");
    expect(seen).toEqual(["LLM|sub-key", "payg-key"]);
    expect(refreshCredentialsMock).not.toHaveBeenCalled();
    for (const id of ["mc-oauth", "mc-payg"]) {
      expect(lockKeys(await getProviderConnectionByIdUnscoped(id))).toEqual([]);
    }
  });

  it("control: an unrelated 403 still refreshes the token, retries once and locks the account", async () => {
    insertConnection("mc-oauth", 1, "oauth", {
      accessToken: "LLM|old",
      refreshToken: "dca:device",
    });
    refreshCredentialsMock.mockResolvedValue({ accessToken: "LLM|new", refreshToken: "dca:device" });
    executeMock.mockImplementation(async () => upstream(PLAIN_403));

    const res = await chat();
    expect(JSON.stringify(await res.json())).not.toContain("client_attestation_denied");
    expect(refreshCredentialsMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledTimes(2);
    const conn = await getProviderConnectionByIdUnscoped("mc-oauth");
    expect(lockKeys(conn).length).toBeGreaterThan(0);
  });
});

describe("combo with client_attestation_denied members", () => {
  const log = { info: () => {}, warn: () => {}, debug: () => {} };
  const deniedResponse = () =>
    new Response(
      JSON.stringify({
        error: {
          message: `${DENIED_MESSAGE} [code=client_attestation_denied]`,
          type: "permission_error",
          code: "client_attestation_denied",
        },
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );

  it("advances past a denied member to the next one", async () => {
    const seen = [];
    const res = await handleComboChat({
      body: {},
      models: ["meta-code/muse-spark-1.3", "other/model"],
      handleSingleModel: async (_b, m) => {
        seen.push(m);
        return m.startsWith("meta-code/")
          ? deniedResponse()
          : new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      log,
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["meta-code/muse-spark-1.3", "other/model"]);
  });

  it("returns the structured permission_error, without Retry-After, when all members are denied", async () => {
    const seen = [];
    const res = await handleComboChat({
      body: {},
      models: ["meta-code/muse-spark-1.3", "meta-code/muse-spark-1.2"],
      handleSingleModel: async (_b, m) => {
        seen.push(m);
        return deniedResponse();
      },
      log,
    });
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(body.error).toMatchObject({
      type: "permission_error",
      code: "client_attestation_denied",
    });
    expect(body.error.message).toContain("Muse Code client only");
    expect(seen).toHaveLength(2);
  });

  it("control: an all-members unrelated 403 keeps the generic body shape", async () => {
    const res = await handleComboChat({
      body: {},
      models: ["p/a", "p/b"],
      handleSingleModel: async () =>
        new Response(JSON.stringify(PLAIN_403), { status: 403 }),
      log,
    });
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error.code).toBeUndefined();
  });
});
