// YAN-53: malformed chat bodies → 400, not 500.
// YAN-112: device-code poll survives a non-JSON token response.
import { describe, expect, it } from "vitest";

import { readTokenResponse } from "../../src/lib/oauth/providerHelpers.js";
import { updateSettings } from "../../src/lib/localDb.js";
import { handleChat } from "../../src/sse/handlers/chat.js";

const post = (body) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

describe("handleChat body validation (YAN-53)", () => {
  it.each([["null"], ['{"model":123,"messages":[]}'], ["[]"]])("rejects %s with 400", async (b) => {
    await updateSettings({ requireApiKey: false });
    const res = await handleChat(post(b));
    expect(res.status).toBe(400);
  });
});

describe("readTokenResponse (YAN-112)", () => {
  it("returns invalid_response for a non-JSON body instead of throwing", async () => {
    const data = await readTokenResponse(new Response("<html>502</html>", { status: 502 }));
    expect(data).toEqual({ error: "invalid_response", error_description: "<html>502</html>" });
  });

  it("parses JSON bodies", async () => {
    const data = await readTokenResponse(Response.json({ error: "authorization_pending" }));
    expect(data).toEqual({ error: "authorization_pending" });
  });
});

// Review follow-up for #668 (YAN-687 sibling): a translateRequest throw is a
// malformed client body — 400, no account cooldown, no upstream call.
import { vi } from "vitest";

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: vi.fn(() => {
      throw new Error("must not reach an upstream: malformed body");
    }),
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));
vi.mock("../../open-sse/services/tokenRefresh.js", async (importOriginal) => ({
  ...(await importOriginal()),
  refreshWithRetry: vi.fn(),
}));

describe("translateRequest throws are request-scoped (YAN-687 follow-up)", () => {
  it("messages:[null] gets a 400 without touching account state", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const result = await handleChatCore({
      body: { model: "gpt-4o", messages: [null] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "k", providerSpecificData: {} },
      log: { info() {}, warn() {}, debug() {}, error() {}, errorLine() {} },
      connectionId: "c",
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
    });
    expect(result.status).toBe(400);
    expect(result.localError).toBe(true);
  });
});
