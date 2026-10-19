// YAN-739: concurrent per-user loopback logins (codex/xAI/trae/windsurf/zed) share
// one listener per provider. Sessions are keyed by state, the listener stays up
// while another bound login is pending, and the switch-off path is unchanged.
// Callback handlers are exercised directly: no sockets.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/oauth/providers", () => ({
  exchangeTokens: vi.fn(async (_p, code) => ({
    accessToken: `at-${code}`,
    email: `${code}@oauth.test`,
    expiresIn: 3600,
  })),
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

const bind = (userId) => ({ userId, workspaceId: `w-${userId}`, ctx: { userId } });
const cb = (qs) => new URL(`http://localhost/callback?${qs}`);
const codexReg = (state, userId) => ({
  state,
  codeVerifier: "cv",
  redirectUri: "http://localhost:1455/auth/callback",
  binding: userId ? bind(userId) : undefined,
});

let codex;
let xai;
let trae;
let windsurf;
let zed;
beforeEach(async () => {
  created.length = 0;
  codex = await import("@/lib/oauth/utils/server/codex.js");
  xai = await import("@/lib/oauth/utils/server/xai.js");
  trae = await import("@/lib/oauth/utils/server/trae.js");
  windsurf = await import("@/lib/oauth/utils/server/windsurf.js");
  zed = await import("@/lib/oauth/utils/server/zed.js");
  for (const [mod, name] of [
    [codex, "Codex"],
    [xai, "Xai"],
    [trae, "Trae"],
    [windsurf, "Windsurf"],
    [zed, "Zed"],
  ]) {
    for (const s of mod[`${name.toLowerCase()}LiveSessions`]()) mod[`clear${name}Session`](s.state);
  }
});

describe.each([
  ["codex", () => codex, "registerCodexSession", "handleCodexCallback", "getCodexSessionStatus"],
  ["xai", () => xai, "registerXaiSession", "handleXaiCallback", "getXaiSessionStatus"],
])("%s concurrent users", (_n, mod, reg, handle, status) => {
  it("keeps the listener until the last bound login finishes; each lands in its own workspace", async () => {
    const m = mod();
    m[reg](codexReg("sa", "ua"));
    m[reg](codexReg("sb", "ub"));

    const first = await m[handle](cb("code=A&state=sa"), 20128);
    expect(first.status).toBe(200);
    expect(first.released).toBe(false);
    expect(m[status]("sa").status).toBe("done");
    expect(m[status]("sb").status).toBe("pending");

    const second = await m[handle](cb("code=B&state=sb"), 20128);
    expect(second.released).toBe(true);
    expect(created.map((c) => c.binding.userId)).toEqual(["ua", "ub"]);
    expect(created.map((c) => c.binding.workspaceId)).toEqual(["w-ua", "w-ub"]);
  });

  it("unknown state with another bound login pending: 400, listener kept, others untouched", async () => {
    const m = mod();
    m[reg](codexReg("sa", "ua"));
    const out = await m[handle](cb("code=X&state=nope"), 20128);
    expect(out.status).toBe(400);
    expect(out.released).toBe(false);
    expect(m[status]("sa").status).toBe("pending");
  });

  it("switch off (unbound): stop after callback and legacy 302 redirect preserved", async () => {
    const m = mod();
    m[reg](codexReg("su"));
    const done = await m[handle](cb("code=U&state=su"), 20128);
    expect(done.released).toBe(true);
    const legacy = await m[handle](cb("code=L&state=zzz"), 20128);
    expect(legacy.status).toBe(302);
    expect(legacy.headers.Location).toBe("http://localhost:20128/callback?code=L&state=zzz");
  });
});

describe("trae/windsurf/zed per-user sessions", () => {
  it.each([
    ["Trae", () => trae],
    ["Windsurf", () => windsurf],
    ["Zed", () => zed],
  ])("%s: A's register does not supersede B's; same user's re-register does", (name, mod) => {
    const m = mod();
    const register = (state, userId) =>
      m[`register${name}Session`]({ state, codeVerifier: "cv", binding: bind(userId) });
    register("a1", "ua");
    register("b1", "ub");
    expect(m[`get${name}SessionStatus`]("a1")).not.toBeNull();
    expect(m[`get${name}SessionStatus`]("b1")).not.toBeNull();
    expect(m[`${name.toLowerCase()}LiveSessions`]()).toHaveLength(2);

    register("a2", "ua");
    expect(m[`get${name}SessionStatus`]("a1")).toBeNull();
    expect(m[`get${name}SessionStatus`]("a2")).not.toBeNull();
    expect(m[`get${name}SessionStatus`]("b1")).not.toBeNull();

    // Stop-proxy semantics: dropping A's flows leaves B's pending and the listener needed.
    m[`clear${name}SessionsFor`]("ua");
    expect(m[`get${name}SessionStatus`]("a2")).toBeNull();
    expect(m[`get${name}SessionStatus`]("b1")?.status).toBe("pending");
    expect(m[`release${name}Listener`]()).toBe(false);
    m[`clear${name}SessionsFor`]("ub");
    expect(m[`release${name}Listener`]()).toBe(true);
  });

  it("unbound sessions keep today's single-session semantics", () => {
    trae.registerTraeSession({ state: "u1" });
    trae.registerTraeSession({ state: "u2" });
    expect(trae.getTraeSessionStatus("u1")).toBeNull();
    expect(trae.getTraeSessionStatus("u2")).not.toBeNull();
    expect(trae.releaseTraeListener()).toBe(true);
  });
});

describe("review fixes", () => {
  it("#1 repeated/concurrent callback for one state exchanges once and never flips done->error", async () => {
    const { exchangeTokens } = await import("@/lib/oauth/providers");
    exchangeTokens.mockClear();
    codex.registerCodexSession(codexReg("dup", "ua"));
    codex.registerCodexSession(codexReg("other", "ub"));
    const [r1, r2] = await Promise.all([
      codex.handleCodexCallback(cb("code=A&state=dup"), 20128),
      codex.handleCodexCallback(cb("code=A&state=dup"), 20128),
    ]);
    expect(exchangeTokens).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(codex.getCodexSessionStatus("dup").status).toBe("done");
    expect([r1, r2].every((r) => r.status === 200)).toBe(true);
    const again = await codex.handleCodexCallback(cb("code=A&state=dup"), 20128);
    expect(again.body).toContain("Authentication successful");
    expect(codex.getCodexSessionStatus("dup").status).toBe("done");
  });

  it("#1/#8 an exchanging session counts as live and survives its owner's stop-proxy", () => {
    codex.registerCodexSession(codexReg("ex", "ua"));
    codex.getCodexSessionStatus("ex").status = "exchanging";
    expect(codex.releaseCodexListener("other-finisher")).toBe(false);
    codex.clearCodexSessionsFor("ua");
    expect(codex.getCodexSessionStatus("ex")).not.toBeNull();
  });

  it("#2 trae without state: only the sole PENDING session qualifies, else 400 and untouched", async () => {
    const started = await trae.startTraeProxy();
    try {
      const hit = () =>
        fetch(`http://127.0.0.1:${started.port}/callback?refreshToken=r&loginHost=h`);
      trae.registerTraeSession({ state: "ta", binding: bind("ua") });
      trae.registerTraeSession({ state: "tb", binding: bind("ub") });
      trae.getTraeSessionStatus("ta").status = "done";
      trae.registerTraeSession({ state: "tc", binding: bind("uc") });
      // done + two pending: ambiguous -> fail closed, nobody mutated.
      expect((await hit()).status).toBe(400);
      expect(trae.getTraeSessionStatus("tb").status).toBe("pending");
      expect(trae.getTraeSessionStatus("tc").status).toBe("pending");
      expect(trae.getTraeSessionStatus("ta").status).toBe("done");
      // done + one pending: the pending one is used, the done one is left alone.
      trae.clearTraeSession("tc");
      expect((await hit()).status).toBe(200);
      expect(trae.getTraeSessionStatus("tb").status).toBe("done");
      expect(created.map((c) => c.binding.userId)).toEqual(["ub"]);
    } finally {
      trae.stopTraeProxy();
    }
  });

  it("#3 zed: a lone BOUND session is key-matched, not blindly used or poisoned", async () => {
    const { createZedNativeAuthData } = await import("open-sse/shared/zedAuth.js");
    const crypto = await import("node:crypto");
    const mine = createZedNativeAuthData({}, { nativeAppPort: 1 });
    const foreign = createZedNativeAuthData({}, { nativeAppPort: 1 });
    const enc = crypto
      .publicEncrypt(
        {
          key: crypto.createPublicKey({
            key: Buffer.from(foreign.publicKey, "base64url"),
            format: "der",
            type: "pkcs1",
          }),
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from("tok"),
      )
      .toString("base64url");
    zed.registerZedSession({
      state: "za",
      codeVerifier: mine.privateKeyVerifier,
      binding: bind("ua"),
    });
    const started = await zed.startZedProxy(0);
    try {
      const res = await fetch(`http://127.0.0.1:${started.port}/?user_id=u&access_token=${enc}`);
      expect(res.status).toBe(200);
      expect(zed.getZedSessionStatus("za").status).toBe("pending");
      expect(created).toHaveLength(0);
    } finally {
      zed.stopZedProxy();
    }
  });

  it("#4 single->multi flip: unbound pending + bound finishing keeps the listener; pure unbound stops", () => {
    trae.registerTraeSession({ state: "legacy" });
    trae.registerTraeSession({ state: "newbound", binding: bind("ua") });
    expect(trae.getTraeSessionStatus("legacy")).not.toBeNull(); // different owner key
    expect(trae.releaseTraeListener("newbound")).toBe(false);
    expect(trae.releaseTraeListener("legacy")).toBe(false); // bound one still pending
    trae.clearTraeSession("newbound");
    expect(trae.releaseTraeListener("legacy")).toBe(true); // nothing bound left
  });

  it("#5/#6 a state held by another user is refused; expired sessions are swept on register", () => {
    expect(codex.registerCodexSession(codexReg("held", "ua"))).toBe(true);
    expect(codex.registerCodexSession(codexReg("held", "ub"))).toBe(false);
    expect(codex.getCodexSessionStatus("held").binding.userId).toBe("ua");
    expect(codex.registerCodexSession(codexReg("held", "ua"))).toBe(true); // same user may re-register
    codex.registerCodexSession(codexReg("old", "uc"));
    codex.getCodexSessionStatus("old").createdAt = Date.now() - 31 * 60_000;
    codex.registerCodexSession(codexReg("fresh", "ud"));
    expect(codex.getCodexSessionStatus("old")).toBeNull();
  });

  it("never replaces an in-flight (exchanging) session, for any provider", () => {
    for (const [mod, reg, get, args] of [
      [codex, "registerCodexSession", "getCodexSessionStatus", codexReg("inflight", "ua")],
      [xai, "registerXaiSession", "getXaiSessionStatus", codexReg("inflight", "ua")],
      [
        trae,
        "registerTraeSession",
        "getTraeSessionStatus",
        { state: "inflight", binding: bind("ua") },
      ],
      [
        windsurf,
        "registerWindsurfSession",
        "getWindsurfSessionStatus",
        { state: "inflight", binding: bind("ua") },
      ],
      [
        zed,
        "registerZedSession",
        "getZedSessionStatus",
        { state: "inflight", codeVerifier: "k", binding: bind("ua") },
      ],
    ]) {
      expect(mod[reg](args)).toBe(true);
      const live = mod[get]("inflight");
      live.status = "exchanging";
      expect(mod[reg](args)).toBe(false); // even the same user
      expect(mod[get]("inflight")).toBe(live);
    }
  });

  it("zed: with two bound sessions, the one whose key matches (the SECOND) completes; the other is untouched", async () => {
    const { createZedNativeAuthData } = await import("open-sse/shared/zedAuth.js");
    const crypto = await import("node:crypto");
    const first = createZedNativeAuthData({}, { nativeAppPort: 1 });
    const second = createZedNativeAuthData({}, { nativeAppPort: 1 });
    const enc = crypto
      .publicEncrypt(
        {
          key: crypto.createPublicKey({
            key: Buffer.from(second.publicKey, "base64url"),
            format: "der",
            type: "pkcs1",
          }),
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from("second-user-token"),
      )
      .toString("base64url");
    zed.registerZedSession({
      state: "z1",
      codeVerifier: first.privateKeyVerifier,
      binding: bind("ua"),
    });
    zed.registerZedSession({
      state: "z2",
      codeVerifier: second.privateKeyVerifier,
      binding: bind("ub"),
    });
    const started = await zed.startZedProxy(0);
    try {
      const res = await fetch(`http://127.0.0.1:${started.port}/?user_id=u&access_token=${enc}`);
      expect(res.status).toBe(200);
      expect(zed.getZedSessionStatus("z2").status).toBe("done");
      expect(zed.getZedSessionStatus("z1").status).toBe("pending");
      expect(created.map((c) => c.binding.userId)).toEqual(["ub"]);
    } finally {
      zed.stopZedProxy();
    }
  });
});
