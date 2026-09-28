import { describe, it, expect } from "vitest";
import {
  sortRows,
  groupRows,
  sharePct,
  periodDelta,
  shapeChartSeries,
  buildCurl,
} from "@/app/(dashboard)/dashboard/usage/lib/usageShapes.js";

describe("sortRows", () => {
  it("derives totals + token-share cost split and sorts", () => {
    const rows = sortRows(
      [
        { rawModel: "b", promptTokens: 60, cachedTokens: 20, completionTokens: 40, cost: 1 },
        { rawModel: "A", promptTokens: 0, completionTokens: 0, cost: 0 },
      ],
      "rawModel",
      "asc",
    );
    expect(rows.map((r) => r.rawModel)).toEqual(["A", "b"]);
    const b = rows[1];
    expect(b.totalTokens).toBe(100);
    expect(b.inputCost).toBeCloseTo(0.4);
    expect(b.cachedCost).toBeCloseTo(0.2);
    expect(b.outputCost).toBeCloseTo(0.4);
    expect(rows[0].inputCost).toBe(0);
    expect(sortRows(rows, "totalTokens", "desc")[0].rawModel).toBe("b");
  });
});

describe("groupRows + sharePct", () => {
  it("sums group summaries and computes share", () => {
    const rows = sortRows(
      [
        {
          accountName: "x",
          requests: 2,
          promptTokens: 10,
          completionTokens: 5,
          cost: 0.3,
          pending: 1,
          lastUsed: "2026-01-01",
        },
        {
          accountName: "x",
          requests: 3,
          promptTokens: 20,
          completionTokens: 5,
          cost: 0.7,
          pending: 2,
          lastUsed: "2026-02-01",
        },
        {
          connectionId: "abcdef123456",
          requests: 5,
          promptTokens: 40,
          completionTokens: 20,
          cost: 1,
        },
      ],
      "requests",
      "asc",
    );
    const groups = groupRows(rows, "accountName");
    const x = groups.find((g) => g.groupKey === "x");
    expect(x.items).toHaveLength(2);
    expect(x.summary).toMatchObject({
      requests: 5,
      promptTokens: 30,
      completionTokens: 10,
      totalTokens: 40,
      pending: 3,
      lastUsed: "2026-02-01",
    });
    expect(x.summary.cost).toBeCloseTo(1);
    expect(groups.some((g) => g.groupKey === "Account abcdef12...")).toBe(true);

    const total = groups.reduce((n, g) => n + g.summary.requests, 0);
    expect(sharePct(x.summary.requests, total)).toBe(50);
    expect(sharePct(5, 0)).toBe(0);
    expect(groupRows(null, "rawModel")).toEqual([]);
  });
});

describe("periodDelta", () => {
  it("up", () => expect(periodDelta(150, 100)).toEqual({ pct: 50, up: true }));
  it("down", () => expect(periodDelta(50, 100)).toEqual({ pct: -50, up: false }));
  it("zero previous → null pct", () => {
    expect(periodDelta(10, 0)).toEqual({ pct: null, up: true });
    expect(periodDelta(0, 0)).toEqual({ pct: null, up: false });
  });
});

describe("shapeChartSeries", () => {
  it("maps basic and extended buckets; totals preserved", () => {
    const basic = shapeChartSeries([
      { label: "a", tokens: 100, cost: 0.1 },
      { label: "b", tokens: 50, cost: 0.2 },
    ]);
    expect(basic[0]).toEqual({
      label: "a",
      input: 100,
      cached: 0,
      output: 0,
      cost: 0.1,
      tokens: 100,
    });
    expect(basic.reduce((n, r) => n + r.tokens, 0)).toBe(150);
    expect(basic.reduce((n, r) => n + r.cost, 0)).toBeCloseTo(0.3);

    const ext = shapeChartSeries([{ label: "c", input: 10, cached: 5, output: 7, cost: 0.5 }]);
    expect(ext[0]).toEqual({ label: "c", input: 10, cached: 5, output: 7, cost: 0.5, tokens: 17 });
    expect(shapeChartSeries(null)).toEqual([]);
  });
});

describe("buildCurl", () => {
  it("redacts sensitive header values and escapes quotes", () => {
    const secrets = ["sk-SECRET", "key-123", "sess=abc", "tok-9", "api-7"];
    const out = buildCurl({
      method: "POST",
      url: "http://h/v1/it's",
      headers: {
        Authorization: `Bearer ${secrets[0]}`,
        "X-Api-Key": secrets[1],
        Cookie: secrets[2],
        token: secrets[3],
        "api-key": secrets[4],
        "Content-Type": "application/json",
      },
      body: { msg: "don't" },
    });
    for (const s of secrets) expect(out).not.toContain(s);
    expect(out).toContain("-H 'Authorization: [redacted]'");
    expect(out).toContain("-H 'X-Api-Key: [redacted]'");
    expect(out).toContain("-H 'Content-Type: application/json'");
    expect(out).toContain(`curl -X POST 'http://h/v1/it'\\''s'`);
    expect(out).toContain(`--data '{"msg":"don'\\''t"}'`);
    expect(out.split("\n").length).toBe(8);
  });

  it("redacts secret-bearing JSON body keys", () => {
    const out = buildCurl({
      method: "POST",
      url: "http://h/v1/chat",
      headers: { "Content-Type": "application/json" },
      body: {
        model: "m",
        api_key: "sk-SECRET",
        nested: { password: "pw-9", ok: 1 },
        arr: [{ token: "t-1" }],
      },
    });
    expect(out).not.toContain("sk-SECRET");
    expect(out).not.toContain("pw-9");
    expect(out).not.toContain("t-1");
    expect(out).toContain('"api_key":"[redacted]"');
    expect(out).toContain('"password":"[redacted]"');
    expect(out).toContain('"token":"[redacted]"');
    expect(out).toContain('"ok":1');
  });

  it("omits --data when no body", () => {
    expect(buildCurl({ method: "GET", url: "http://h" })).toBe("curl -X GET 'http://h'");
  });
});
