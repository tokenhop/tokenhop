import { describe, it, expect } from "vitest";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/quota/lib/quotaUtils.js";

describe("Codex Spark Quota Tracking (#3431)", () => {
  it("labels a business primary weekly window as Weekly, not 5h", () => {
    const quotas = parseQuotaData("codex", {
      plan: "business",
      quotas: {
        session: {
          used: 0,
          total: 100,
          remaining: 100,
          windowMinutes: 10080,
          resetAt: "2026-10-03T00:00:00.000Z",
        },
      },
    });

    expect(quotas).toHaveLength(1);
    expect(quotas[0].name).toBe("Weekly");
    expect(quotas[0].resetAt).toBe("2026-10-03T00:00:00.000Z");
  });

  it("correctly normalizes spark_session and spark_weekly quotas with display labels", () => {
    const mockCodexUsage = {
      plan: "team",
      quotas: {
        session: { used: 20, total: 100, remaining: 80, resetAt: "2026-08-22T05:00:00.000Z" },
        weekly: { used: 40, total: 100, remaining: 60, resetAt: "2026-08-28T05:00:00.000Z" },
        review_session: {
          used: 0,
          total: 100,
          remaining: 100,
          resetAt: "2026-08-22T05:00:00.000Z",
        },
        spark_session: { used: 12, total: 100, remaining: 88, resetAt: "2026-08-22T05:00:00.000Z" },
        spark_weekly: { used: 25, total: 100, remaining: 75, resetAt: "2026-08-28T05:00:00.000Z" },
      },
    };

    const parsed = parseQuotaData("codex", mockCodexUsage);

    const sparkSession = parsed.find((q) => q.name === "Spark (5h)");
    const sparkWeekly = parsed.find((q) => q.name === "Spark (Weekly)");
    const session = parsed.find((q) => q.name === "5h");
    const weekly = parsed.find((q) => q.name === "Weekly");

    expect(sparkSession).toBeDefined();
    expect(sparkSession.used).toBe(12);
    expect(sparkSession.remaining).toBe(88);

    expect(sparkWeekly).toBeDefined();
    expect(sparkWeekly.used).toBe(25);
    expect(sparkWeekly.remaining).toBe(75);

    expect(session).toBeDefined();
    expect(session.used).toBe(20);
    expect(weekly).toBeDefined();
    expect(weekly.used).toBe(40);
  });
});
