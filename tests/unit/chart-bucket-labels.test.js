// YAN-1233: /api/usage/chart labels follow the dashboard locale on the
// client, from the bucket bounds (grain + start) the server sends.
import { describe, expect, it } from "vitest";
import { localizeBucketLabels } from "@/shared/utils/chartBucketLabels.js";

const NOW = new Date(2026, 9, 15, 12);
const day = (start, label = "en") => ({ label, grain: "day", start, tokens: 1 });

describe("localizeBucketLabels", () => {
  it("formats day buckets in the given locale, keeping every other field", () => {
    const [b] = localizeBucketLabels([day("2026-10-03")], "de", NOW);
    expect(b.label).toBe(
      new Intl.DateTimeFormat("de", { month: "short", day: "numeric" }).format(
        new Date(2026, 9, 3),
      ),
    );
    expect(b).toMatchObject({ grain: "day", start: "2026-10-03", tokens: 1 });
    expect(localizeBucketLabels([day("2026-10-03")], "en-US", NOW)[0].label).toBe("Oct 3");
  });

  it("adds the year when the series crosses New Year", () => {
    const out = localizeBucketLabels([day("2025-12-31"), day("2026-01-01")], "en-US", NOW);
    expect(out.map((b) => b.label)).toEqual(["Dec 31, 2025", "Jan 1, 2026"]);
  });

  it("adds the year when the whole series lies outside the current year", () => {
    expect(localizeBucketLabels([day("2025-06-01")], "en-US", NOW)[0].label).toBe("Jun 1, 2025");
  });

  it("formats week, month and year buckets", () => {
    const out = localizeBucketLabels(
      [
        { grain: "month", start: "2025-11" },
        { grain: "year", start: "2024" },
        { grain: "week", start: "2026-09-28" },
      ],
      "fr",
      NOW,
    );
    expect(out[0].label).toBe(
      new Intl.DateTimeFormat("fr", { month: "short", year: "numeric" }).format(
        new Date(2025, 10, 1),
      ),
    );
    expect(out[1].label).toBe("2024");
    // Mixed years in the series: week labels carry the year.
    expect(out[2].label).toMatch(/2026/);
  });

  it("formats hour buckets as local 24-hour time", () => {
    const start = new Date(2026, 9, 15, 7).toISOString();
    expect(localizeBucketLabels([{ grain: "hour", start }], "en-US", NOW)[0].label).toBe("07:00");
  });

  it("keeps the server label for buckets without bounds or with bad bounds", () => {
    const legacy = { label: "Sep 1", tokens: 2 };
    const bad = { label: "x", grain: "day", start: "not-a-date" };
    expect(localizeBucketLabels([legacy, bad], "de", NOW)).toEqual([legacy, bad]);
  });

  it("falls back to English for an invalid locale tag", () => {
    expect(localizeBucketLabels([day("2026-10-03")], "@@", NOW)[0].label).toBe("Oct 3");
  });
});
