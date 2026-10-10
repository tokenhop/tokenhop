// YAN-1041 end-to-end through the real handleChat account loop: real auth.js
// selection + markAccountUnavailable + real SQLite persistence; only the
// upstream executor (and logger/stream seams) is faked. Isolated DATA_DIR/HOME
// come from the tests/vitest.config.js setup.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

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
vi.mock("@/lib/usageDb.js", async (importOriginal) => ({
  ...(await importOriginal()),
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
  saveRequestUsageUnscoped: vi.fn(async () => {}),
}));
// Keep the real logger (chatCore calls tagForSession etc.); only silence output.
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
import { getProviderConnectionByIdUnscoped } from "@/lib/localDb";
import { handleChat } from "@/sse/handlers/chat.js";

const NOW = "2026-10-04T00:00:00.000Z";
const MODEL = "anthropic/claude-haiku-4-5-20251001";
const CREDIT_400 = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "Your credit balance is too low to access the Anthropic API. sk-ant-UPSTREAM-SECRET",
  },
};
const OK = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5-20251001",
  content: [{ type: "text", text: "pong" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 3, output_tokens: 1 },
};

let db;

function insertConnection(id, priority, extra = {}) {
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, 'anthropic', 'apikey', ?, NULL, ?, 1, ?, ?, ?)`,
    [id, id, priority, JSON.stringify({ apiKey: `sk-ant-${id}-SECRET`, ...extra }), NOW, NOW],
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
  db.run("DELETE FROM providerConnections");
});

afterAll(() => {
  db.run("DELETE FROM providerConnections");
});

describe("handleChat billing-lock account loop", () => {
  it("credit 400 on the first API-key account locks it and the SAME request succeeds on the second", async () => {
    insertConnection("acct-a", 1);
    insertConnection("acct-b", 2);
    const seenKeys = [];
    executeMock.mockImplementation(async ({ credentials }) => {
      seenKeys.push(credentials.apiKey);
      return credentials.apiKey.includes("acct-a")
        ? {
            response: new Response(JSON.stringify(CREDIT_400), { status: 400 }),
            url: "u",
            headers: {},
          }
        : {
            response: new Response(JSON.stringify(OK), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
            url: "u",
            headers: {},
          };
    });

    const res = await chat();

    expect(res.status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(seenKeys).toEqual(["sk-ant-acct-a-SECRET", "sk-ant-acct-b-SECRET"]);

    // The failing account carries a persisted connection-wide billing lock…
    const a = await getProviderConnectionByIdUnscoped("acct-a");
    expect(a.billingLock).toMatchObject({
      reason: "credit_exhausted",
      message: "Upstream reported exhausted credit or spend limit",
      lastProbeAt: null,
      lastProbeError: null,
    });
    expect(Number.isFinite(a.billingLock.generation)).toBe(true);
    expect(Date.parse(a.billingLock.nextProbeAt)).toBeGreaterThan(Date.now());
    // …and NOT a per-model lock; the lock text never carries upstream free text.
    expect(Object.keys(a).filter((k) => k.startsWith("modelLock_"))).toEqual([]);
    expect(JSON.stringify(a.billingLock)).not.toMatch(/SECRET|sk-ant|UPSTREAM/);
    // The healthy account is untouched.
    expect((await getProviderConnectionByIdUnscoped("acct-b")).billingLock ?? null).toBeNull();
  });

  it("a locked account is skipped for the NEXT request too (all models), no re-dispatch to it", async () => {
    insertConnection("acct-a", 1);
    insertConnection("acct-b", 2);
    executeMock.mockImplementation(async ({ credentials }) =>
      credentials.apiKey.includes("acct-a")
        ? {
            response: new Response(JSON.stringify(CREDIT_400), { status: 400 }),
            url: "u",
            headers: {},
          }
        : {
            response: new Response(JSON.stringify(OK), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
            url: "u",
            headers: {},
          },
    );
    expect((await chat()).status).toBe(200);
    executeMock.mockClear();

    expect((await chat()).status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1); // acct-a never dispatched again
    expect(executeMock.mock.calls[0][0].credentials.apiKey).toBe("sk-ant-acct-b-SECRET");
  });

  it("every eligible connection billing-locked -> existing unavailable path: 503 with fixed credit copy", async () => {
    insertConnection("acct-a", 1);
    insertConnection("acct-b", 2);
    executeMock.mockImplementation(async () => ({
      response: new Response(JSON.stringify(CREDIT_400), { status: 400 }),
      url: "u",
      headers: {},
    }));

    // Request 1 locks both accounts (400 -> a, 400 -> b) and ends with the last
    // upstream error; request 2 hits the all-locked selection path.
    await chat();
    expect(executeMock).toHaveBeenCalledTimes(2);
    executeMock.mockClear();

    const res = await chat();
    const raw = await res.text();
    expect(executeMock).not.toHaveBeenCalled(); // zero upstream traffic
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = JSON.parse(raw);
    expect(body.error.message).toContain("Connection out of credit");
    expect(body.error.message).toContain("http_400"); // fixed lock code, not upstream text
    // Stable fixed copy only: no upstream text, keys or secrets.
    expect(raw).not.toMatch(/SECRET|sk-ant|UPSTREAM|credit balance/i);
  });
});
