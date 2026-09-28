// Meta Code (Muse Spark): routing, subscription-key mint, re-mint refresh, quota, device poll.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { PROVIDERS, PROVIDER_MODELS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import { getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { mintMetaCodeKey } from "../../open-sse/services/metaCode.js";
import { getMetaCodeUsage, parseMetaSubsUsage } from "../../open-sse/services/usage/meta-code.js";
import { refreshMetaCodeToken } from "../../open-sse/services/tokenRefresh.js";
import metaCodeOAuth from "../../src/lib/oauth/providers/meta-code.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const MINT = {
  api_key: "LLM|1|abc",
  is_subs_active: true,
  subs_tier_name: "Muse Code Everyday",
  subs_usage: {
    window: { used_percent: 12, window_duration_mins: 300, resets_at: 1790275673 },
    weekly: { used_percent: 140, resets_at: 1790553600 },
  },
};

beforeEach(() => vi.mocked(proxyAwareFetch).mockReset());

describe("meta-code routing", () => {
  it("routes Muse models over the Responses API with no client id in source", () => {
    const cfg = PROVIDERS["meta-code"];
    expect(cfg.baseUrl).toBe("https://api.meta.ai/v1/responses");
    expect(cfg.format).toBe("openai-responses");
    expect(PROVIDER_OAUTH["meta-code"].clientId).toBeUndefined();
    expect(PROVIDER_MODELS.mc.map((m) => m.id)).toContain("muse-spark-1.3");
    expect(getModelTargetFormat("mc", "muse-spark-1.3")).toBe("openai-responses");
  });

  it("folds reasoning_effort into Responses reasoning and forces SSE (Meta 400s on it)", () => {
    const out = new DefaultExecutor("meta-code").transformRequest("muse-spark-1.3", {
      model: "muse-spark-1.3",
      input: [],
      stream: false,
      reasoning_effort: "high",
    });
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.reasoning).toEqual({ summary: "auto", effort: "high" });
    expect(out.stream).toBe(true);
  });
});

describe("meta-code mint", () => {
  it("mints with the dca token as Bearer", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(json(MINT));
    const data = await mintMetaCodeKey("dca:tok");
    const [url, opts] = vi.mocked(proxyAwareFetch).mock.calls[0];
    expect(url).toBe(PROVIDER_OAUTH["meta-code"].mintUrl);
    expect(opts.headers.Authorization).toBe("Bearer dca:tok");
    expect(data.api_key).toBe("LLM|1|abc");
  });

  it("throws with status (body kept out of message) and on missing key", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({ title: "secret-ish" }, 401));
    const err = await mintMetaCodeKey("dca:bad").catch((e) => e);
    expect(err).toMatchObject({ status: 401 });
    expect(err.message).not.toContain("secret-ish");
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({ api_key: "", action_url: "https://x" }));
    await expect(mintMetaCodeKey("dca:tok")).rejects.toThrow(/https:\/\/x/);
  });
});

describe("meta-code re-mint refresh", () => {
  it("returns the minted key and keeps the dca token", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(json(MINT));
    expect(await refreshMetaCodeToken("dca:ok")).toEqual({
      accessToken: "LLM|1|abc",
      refreshToken: "dca:ok",
    });
  });

  it("maps a rejected dca token to invalid_grant and transient failures to null", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({}, 401));
    expect(await refreshMetaCodeToken("dca:dead")).toEqual({ error: "invalid_grant" });
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({}, 503));
    expect(await refreshMetaCodeToken("dca:flaky")).toBeNull();
  });
});

describe("meta-code quota", () => {
  it("maps 5h + weekly windows to clamped percent quotas", () => {
    const q = parseMetaSubsUsage(MINT.subs_usage);
    expect(q["Session (5h)"]).toMatchObject({ used: 12, total: 100, remainingPercentage: 88 });
    expect(q["Session (5h)"].resetAt).toBe(new Date(1790275673 * 1000).toISOString());
    expect(q.Weekly).toMatchObject({ used: 100, remainingPercentage: 0 });
  });

  it("messages API-key and expired connections, caches success until forced", async () => {
    expect((await getMetaCodeUsage(null)).message).toMatch(/sign-in/);
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({}, 401));
    expect((await getMetaCodeUsage("dca:old")).message).toMatch(/re-authorize/);
    vi.mocked(proxyAwareFetch).mockResolvedValue(json(MINT));
    const ok = await getMetaCodeUsage("dca:quota");
    expect(ok.plan).toBe("Muse Code Everyday");
    expect(Object.keys(ok.quotas)).toEqual(["Session (5h)", "Weekly"]);
    await getMetaCodeUsage("dca:quota");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    await getMetaCodeUsage("dca:quota", null, { force: true });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
  });

  it("explains an idle subscription when Meta omits subs_usage", async () => {
    const { subs_usage: _omitted, ...idle } = MINT;
    vi.mocked(proxyAwareFetch).mockResolvedValue(json(idle));
    const usage = await getMetaCodeUsage("dca:idle");
    expect(usage.plan).toBe("Muse Code Everyday");
    expect(usage.quotas).toBeUndefined();
    expect(usage.message).toMatch(/no active usage window/i);
  });
});

describe("meta-code device poll", () => {
  const cfg = { tokenUrl: "https://auth.example/token", clientId: "cid" };
  afterEach(() => vi.unstubAllGlobals());

  it("keeps authorization_pending and slow_down pending, surfaces other errors", async () => {
    for (const [error, ok] of [
      ["authorization_pending", true],
      ["slow_down", true],
      ["expired_token", false],
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => json({ error }, 400)),
      );
      const res = await metaCodeOAuth.pollToken(cfg, "dev-code");
      expect(res).toEqual({ ok, data: { error } });
    }
  });

  it("maps minted key to accessToken and dca token to refreshToken", () => {
    const t = metaCodeOAuth.mapTokens({ access_token: "dca:x" }, MINT);
    expect(t).toMatchObject({ accessToken: "LLM|1|abc", refreshToken: "dca:x", expiresAt: null });
  });
});
