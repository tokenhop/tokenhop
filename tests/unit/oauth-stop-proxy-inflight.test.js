// YAN-739: stop-proxy / poll-status behaviour around an in-flight (exchanging)
// loopback session. Route handlers are called directly with a mocked principal.
import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ release: null }));
vi.mock("@/lib/oauth/providers", () => ({
  exchangeTokens: vi.fn(
    () =>
      new Promise((resolve) => {
        gate.release = () => resolve({ accessToken: "at", email: "a@oauth.test", expiresIn: 3600 });
      }),
  ),
}));
const created = vi.hoisted(() => []);
vi.mock("@/lib/oauth/utils/server/shared.js", async (orig) => ({
  ...(await orig()),
  createSessionConnection: vi.fn(async (binding, data) => {
    const conn = { id: `c${created.length}`, email: data.email, binding };
    created.push(conn);
    return conn;
  }),
}));
vi.mock("@/lib/oauth/scope", () => ({
  oauthScope: async () => ({ ctx: { userId: "ua" }, workspaceId: "w-ua" }),
  hostOnlyRefusal: async () => null,
  createIn: vi.fn(),
}));

const binding = { userId: "ua", workspaceId: "w-ua", ctx: { userId: "ua" } };
let codex;
let stopProxy;
let pollStatus;
beforeEach(async () => {
  created.length = 0;
  gate.release = null;
  codex = await import("@/lib/oauth/utils/server/codex.js");
  stopProxy = (await import("@/lib/oauth/routes/stopProxy.js")).default;
  pollStatus = (await import("@/lib/oauth/routes/pollStatus.js")).default;
  for (const s of codex.codexLiveSessions()) codex.clearCodexSession(s.state);
});

const register = (state) =>
  codex.registerCodexSession({
    state,
    codeVerifier: "cv",
    redirectUri: "http://localhost:1455/auth/callback",
    binding,
  });

describe("in-flight loopback session", () => {
  it("own stop-proxy mid-exchange: 2xx, session not lost, still completes", async () => {
    register("st1");
    const cb = codex.handleCodexCallback(new URL("http://localhost/callback?code=c&state=st1"), 1);
    await vi.waitFor(() => expect(gate.release).toBeTypeOf("function")); // exchange in flight
    expect(codex.getCodexSessionStatus("st1").status).toBe("exchanging");

    const res = await stopProxy(
      "codex",
      new Request("http://localhost/api/oauth/codex/stop-proxy"),
    );
    expect(res.status).toBe(200);
    expect(codex.getCodexSessionStatus("st1")?.status).toBe("exchanging");

    gate.release();
    await cb;
    expect(codex.getCodexSessionStatus("st1").status).toBe("done");
    expect(created).toHaveLength(1);
  });

  it("stop-proxy forgets the pending binding of the flows it clears", async () => {
    const { rememberBinding, bindingFor } = await import("@/lib/oauth/pendingBinding");
    register("st-pending");
    rememberBinding("st-pending", { provider: "codex", ...binding });
    await stopProxy("codex", new Request("http://localhost/api/oauth/codex/stop-proxy"));
    expect(codex.getCodexSessionStatus("st-pending")).toBeNull();
    expect(bindingFor("st-pending")).toBeNull();
  });

  it("poll-status reports an exchanging session as pending", async () => {
    register("st2");
    codex.getCodexSessionStatus("st2").status = "exchanging";
    const res = await pollStatus("codex", new Request("http://localhost/x"), {
      searchParams: new URLSearchParams({ state: "st2" }),
    });
    expect(await res.json()).toEqual({ status: "pending" });
  });
});
