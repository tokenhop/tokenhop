import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  coercePeriod,
  formatRelativeFromNow,
  isPeriod,
  loadStoredPeriod,
  PERIOD_STORAGE_KEY,
  periodOptions,
  periodStart,
  resolvePeriod,
  saveStoredPeriod,
  smallestPeriodWithData,
  SUMMARY_PERIODS,
} from "@/shared/utils/period.js";

const DAY = 24 * 60 * 60 * 1000;
const PERIOD_MODULE = fileURLToPath(new URL("../../src/shared/utils/period.js", import.meta.url));
const now = new Date(2026, 8, 29, 12).getTime();

describe("period selection", () => {
  it("recognizes only known period values", () => {
    expect(isPeriod("today")).toBe(true);
    expect(isPeriod("60d")).toBe(true);
    expect(isPeriod("7D")).toBe(false);
    expect(isPeriod(null)).toBe(false);
  });

  it("coerces to the next allowed rank or the largest allowed period", () => {
    expect(coercePeriod("24h")).toBe("24h");
    expect(coercePeriod("24h", SUMMARY_PERIODS)).toBe("7d");
    expect(coercePeriod("60d", SUMMARY_PERIODS)).toBe("30d");
    expect(coercePeriod("bad", SUMMARY_PERIODS)).toBe("today");
  });

  it("prefers valid URL, then valid stored period, then default", () => {
    expect(resolvePeriod({ urlValue: "24h", storedValue: "30d", allowed: SUMMARY_PERIODS })).toBe(
      "7d",
    );
    expect(resolvePeriod({ urlValue: "bad", storedValue: "30d", allowed: SUMMARY_PERIODS })).toBe(
      "30d",
    );
    expect(resolvePeriod({ urlValue: null, storedValue: "bad", allowed: SUMMARY_PERIODS })).toBe(
      "today",
    );
  });

  it("returns options in canonical order regardless of allowed order", () => {
    expect(periodOptions(["30d", "today", "7d"])).toEqual([
      { value: "today", label: "Today" },
      { value: "7d", label: "7d" },
      { value: "30d", label: "30d" },
    ]);
  });
});

describe("period boundaries", () => {
  it("uses local midnight for calendar periods and a rolling 24h window", () => {
    expect(periodStart("today", now)).toBe(new Date(2026, 8, 29).getTime());
    expect(periodStart("24h", now)).toBe(now - DAY);
    expect(periodStart("7d", now)).toBe(new Date(2026, 8, 23).getTime());
    expect(periodStart("30d", now)).toBe(new Date(2026, 7, 31).getTime());
    expect(periodStart("60d", now)).toBe(new Date(2026, 7, 1).getTime());
  });

  it("keeps local midnight across a DST change", () => {
    // TZ is fixed per process, so run the check in a child with a DST zone.
    const script = `import { periodStart } from ${JSON.stringify(PERIOD_MODULE)};
      const d = new Date(periodStart("7d", new Date(2026, 10, 6, 12).getTime()));
      process.stdout.write([d.getDate(), d.getHours(), d.getMinutes()].join(":"));`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TZ: "America/New_York" },
      encoding: "utf8",
    });
    expect(out).toBe("31:0:0");
  });

  it("picks the first period containing the last request", () => {
    const cases = [
      [null, null],
      [new Date(2026, 8, 29, 12), "today"],
      [new Date(2026, 8, 28, 23), "24h"],
      [new Date(2026, 8, 27, 12), "7d"],
      [new Date(2026, 8, 9, 12), "30d"],
      [new Date(2026, 7, 15, 12), "60d"],
      [new Date(2026, 5, 30, 12), null],
      [new Date(2026, 8, 30, 12), "today"],
      ["not a timestamp", null],
    ];
    for (const [lastAt, expected] of cases) {
      expect(smallestPeriodWithData(lastAt, undefined, now)).toBe(expected);
    }
    expect(smallestPeriodWithData(new Date(2026, 8, 28, 23), SUMMARY_PERIODS, now)).toBe("7d");
    expect(
      smallestPeriodWithData(
        new Date(2026, 8, 28, 22),
        undefined,
        new Date(2026, 8, 29, 23, 30).getTime(),
      ),
    ).toBe("7d");
  });
});

describe("relative time and storage", () => {
  it("formats elapsed days, hours, and at least one minute", () => {
    expect(formatRelativeFromNow(new Date(now - 2 * DAY).toISOString(), "en", now)).toBe(
      "2 days ago",
    );
    expect(formatRelativeFromNow(new Date(now - 3 * 60 * 60 * 1000).toISOString(), "en", now)).toBe(
      "3 hours ago",
    );
    expect(formatRelativeFromNow(new Date(now + DAY).toISOString(), "en", now)).toBe(
      "1 minute ago",
    );
    expect(formatRelativeFromNow("bad", "en", now)).toBe("");
    expect(formatRelativeFromNow(new Date(now).toISOString(), "no-such-locale!", now)).toBe(
      "1 minute ago",
    );
    const arabic = formatRelativeFromNow(new Date(now - 2 * DAY).toISOString(), "ar", now);
    expect(arabic).not.toBe("");
    expect(arabic).not.toBe("2 days ago");
  });

  it("tolerates unavailable storage and rejects garbage", () => {
    const throwing = {
      getItem() {
        throw new Error("Denied");
      },
      setItem() {
        throw new Error("Denied");
      },
    };
    expect(loadStoredPeriod(throwing)).toBeNull();
    expect(() => saveStoredPeriod("7d", throwing)).not.toThrow();

    const data = new Map([[PERIOD_STORAGE_KEY, "garbage"]]);
    const storage = {
      getItem(key) {
        return data.get(key) ?? null;
      },
      setItem(key, value) {
        data.set(key, value);
      },
    };
    expect(loadStoredPeriod(storage)).toBeNull();
    saveStoredPeriod("30d", storage);
    expect(loadStoredPeriod(storage)).toBe("30d");
  });
});
