import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/quota/lib/quotaUtils.js";
import { UPSTREAM_CLIENT_IDS } from "@/shared/brand";

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ACTIVE_USAGE = {
  user: {
    membership: { level: "LEVEL_ADVANCED" },
  },
  usage: {
    limit: "100",
    used: "35",
    remaining: "65",
    resetTime: "2026-08-01T00:00:00Z",
  },
  limits: [
    {
      window: { type: "rate" },
      detail: {
        limit: "60",
        remaining: "40",
        resetTime: "2026-07-29T12:00:00Z",
      },
    },
  ],
};

// Live OAuth capture 2026-09-25 (YAN-383): `detail.used` not `remaining`,
// no top-level `usage`/`user`, new `usages` map that disagrees on limit_5h.
const LIVE_USAGE_2026_09 = {
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "100", resetTime: "2026-09-25T20:51:06.623962Z" },
    },
  ],
  usages: {
    limit_5h: { used_ratio: 0, reset_time: "2026-09-25T20:51:05Z" },
    limit_month_total: { used_ratio: 0.4049, reset_time: "2026-10-21T00:00:00Z" },
    limit_month_code: { used_ratio: 0, reset_time: "2026-10-21T00:00:00Z" },
  },
};

describe("kimi live /v1/usages schema (YAN-383)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exhausted 5h window shows 0% remaining despite usages.limit_5h.used_ratio = 0", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(LIVE_USAGE_2026_09));
    const usage = await getUsageForProvider({ provider: "kimi", accessToken: "tok" });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Kimi Coding");
    expect(usage.quotas.Ratelimit).toBeUndefined();
    expect(usage.quotas["5h"]).toMatchObject({
      used: 100,
      total: 100,
      remainingPercentage: 0,
      resetAt: "2026-09-25T20:51:06.623Z",
    });
    expect(usage.quotas.Monthly.remainingPercentage).toBeCloseTo(59.51, 2);
    expect(usage.quotas.Monthly.resetAt).toBe("2026-10-21T00:00:00.000Z");
    expect(usage.quotas["Monthly (Code)"].remainingPercentage).toBe(100);
  });

  it("uses usages ratio when it is more exhausted than limits[]", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", used: "10" },
          },
        ],
        usages: { limit_5h: { used_ratio: 0.5, reset_time: "2026-09-25T20:51:05Z" } },
      }),
    );
    const usage = await getUsageForProvider({ provider: "kimi", accessToken: "tok" });
    expect(usage.quotas["5h"].remainingPercentage).toBe(50);
  });

  it("keeps one row per window instead of overwriting", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", used: "20" },
          },
          {
            window: { duration: 7, timeUnit: "TIME_UNIT_DAY" },
            detail: { limit: "1000", used: "250" },
          },
        ],
      }),
    );
    const usage = await getUsageForProvider({ provider: "kimi", accessToken: "tok" });
    expect(usage.quotas["5h"].remainingPercentage).toBe(80);
    expect(usage.quotas["7d"].remainingPercentage).toBe(75);
  });

  it("parseQuotaData forwards the new rows", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(LIVE_USAGE_2026_09));
    const usage = await getUsageForProvider({ provider: "kimi", accessToken: "tok" });
    const rows = parseQuotaData("kimi", usage);
    expect(rows.map((r) => r.name).sort()).toEqual(["5h", "Monthly", "Monthly (Code)"]);
    expect(rows.find((r) => r.name === "5h").remainingPercentage).toBe(0);
  });
});

describe("kimi registry usage flags", () => {
  it("exposes usage + usageApikey so OAuth and apikey cards appear on /quota", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("kimi");
    expect(USAGE_APIKEY_PROVIDERS).toContain("kimi");
  });

  it("registers transport.usage url when present (optional)", () => {
    // Provider may or may not put usage url on transport; handler has its own constant.
    expect(PROVIDERS.kimi).toBeTruthy();
  });
});

describe("getUsageForProvider(kimi) auth selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("OAuth path: Bearer + X-Msh-* (not chat x-api-key)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(ACTIVE_USAGE));

    const usage = await getUsageForProvider({
      provider: "kimi",
      accessToken: "tok-abc",
      providerSpecificData: { deviceId: "stable-device-1" },
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Allegro");
    expect(usage.quotas.Weekly).toMatchObject({
      used: 35,
      total: 100,
      remainingPercentage: 65,
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(KIMI_USAGE_URL);
    expect(opts.method).toBe("GET");
    expect(opts.headers.Authorization).toBe("Bearer tok-abc");
    expect(opts.headers["x-api-key"]).toBeUndefined();
    expect(opts.headers["X-Msh-Platform"]).toBe(UPSTREAM_CLIENT_IDS.kimiPlatform);
    expect(opts.headers["X-Msh-Device-Id"]).toBe("stable-device-1");
    expect(opts.headers["X-Msh-Version"]).toBeTruthy();
  });

  it("apikey path: x-api-key only (no Bearer / X-Msh)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(ACTIVE_USAGE));

    const usage = await getUsageForProvider({
      provider: "kimi",
      apiKey: "sk-test-123",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.quotas.Weekly.used).toBe(35);

    const [, opts] = proxyAwareFetch.mock.calls[0];
    expect(opts.headers["x-api-key"]).toBe("sk-test-123");
    expect(opts.headers.Authorization).toBeUndefined();
    expect(opts.headers["X-Msh-Platform"]).toBeUndefined();
  });

  it("prefers apiKey over accessToken when both present", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(ACTIVE_USAGE));

    await getUsageForProvider({
      provider: "kimi",
      accessToken: "tok-abc",
      apiKey: "sk-prefer-me",
    });

    const [, opts] = proxyAwareFetch.mock.calls[0];
    expect(opts.headers["x-api-key"]).toBe("sk-prefer-me");
    expect(opts.headers.Authorization).toBeUndefined();
    expect(opts.headers["X-Msh-Platform"]).toBeUndefined();
  });

  it("maps membership levels to plan display names", async () => {
    for (const [level, plan] of [
      ["LEVEL_BASIC", "Moderato"],
      ["LEVEL_INTERMEDIATE", "Allegretto"],
      ["LEVEL_ADVANCED", "Allegro"],
      ["LEVEL_STANDARD", "Vivace"],
    ]) {
      proxyAwareFetch.mockResolvedValueOnce(
        jsonResponse({
          user: { membership: { level } },
          usage: { limit: "10", used: "1", remaining: "9" },
        }),
      );
      const usage = await getUsageForProvider({
        provider: "kimi",
        accessToken: "t",
      });
      expect(usage.plan).toBe(plan);
    }
  });

  it("parses Weekly + Ratelimit; does not put absolute remaining on quota rows", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(ACTIVE_USAGE));

    const usage = await getUsageForProvider({
      provider: "kimi",
      accessToken: "tok",
    });

    // Absolute remaining would break getRemainingPercentage (treats it as 0-100 %)
    expect(usage.quotas.Weekly.remaining).toBeUndefined();
    expect(usage.quotas.Weekly.remainingPercentage).toBe(65);
    expect(usage.quotas.Ratelimit).toMatchObject({
      used: 20,
      total: 60,
      remainingPercentage: expect.closeTo((40 / 60) * 100, 5),
    });
    expect(usage.quotas.Ratelimit.remaining).toBeUndefined();
  });

  it("surfaces re-authorize message only on 401 unauthenticated", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          code: "unauthenticated",
          details: [
            {
              debug: {
                reason: "REASON_INVALID_AUTH_TOKEN",
                localizedMessage: { message: "Invalid auth token" },
              },
            },
          ],
        },
        401,
      ),
    );

    const usage = await getUsageForProvider({
      provider: "kimi",
      accessToken: "expired",
    });

    expect(usage.message).toMatch(/expired|re-authorize/i);
    expect(usage.message).not.toMatch(/subscribe|permission/i);
    expect(usage.quotas).toBeUndefined();
  });

  it("maps 403 REASON_FEATURE_NO_PERMISSION to subscribe message (not expired)", async () => {
    // Live capture: valid OAuth JWT still returns 403 permission_denied when
    // the account has no Kimi Code usage entitlement.
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          code: "permission_denied",
          details: [
            {
              type: "common.error.v1.ErrorDetail",
              debug: {
                reason: "REASON_FEATURE_NO_PERMISSION",
                localizedMessage: {
                  locale: "en-US",
                  message:
                    "You do not have permission to use this feature. Please subscribe to access.",
                },
              },
            },
          ],
        },
        403,
      ),
    );

    const usage = await getUsageForProvider({
      provider: "kimi",
      accessToken: "valid-but-no-sub",
      providerSpecificData: { deviceId: "stable-device-1" },
    });

    expect(usage.message).toMatch(/permission|subscribe/i);
    expect(usage.message).not.toMatch(/expired|re-authorize/i);
    // Must not trip usage-route AUTH_EXPIRED_PATTERNS force-refresh loop
    expect(usage.message.toLowerCase()).not.toMatch(/expired|re-authorize|unauthorized|401/);
  });

  it("formatKimiUsageError distinguishes 401 vs 403 feature gate", async () => {
    const { formatKimiUsageError } = await import("../../open-sse/services/usage/kimi.js");
    expect(formatKimiUsageError(401, '{"code":"unauthenticated"}')).toMatch(
      /expired|re-authorize/i,
    );
    expect(
      formatKimiUsageError(
        403,
        JSON.stringify({
          code: "permission_denied",
          details: [
            {
              debug: {
                reason: "REASON_FEATURE_NO_PERMISSION",
                localizedMessage: {
                  message: "You do not have permission to use this feature.",
                },
              },
            },
          ],
        }),
      ),
    ).toMatch(/permission|subscribe/i);
  });

  it("returns tracked-per-request message when usage limit missing", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        user: { membership: { level: "LEVEL_BASIC" } },
        usage: {},
      }),
    );

    const usage = await getUsageForProvider({
      provider: "kimi",
      accessToken: "tok",
    });

    expect(usage.plan).toBe("Moderato");
    expect(usage.message).toMatch(/tracked per request/i);
  });

  it("returns missing-credentials message when neither token nor key", async () => {
    const usage = await getUsageForProvider({ provider: "kimi" });
    expect(usage.message).toMatch(/token|key|credential/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("parseQuotaData(kimi)", () => {
  it("forwards remainingPercentage for dashboard bars", () => {
    const rows = parseQuotaData("kimi", {
      plan: "Allegro",
      quotas: {
        Weekly: {
          used: 35,
          total: 100,
          remainingPercentage: 65,
          resetAt: "2026-08-01T00:00:00.000Z",
        },
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Weekly",
      used: 35,
      total: 100,
      remainingPercentage: 65,
    });
  });
});
