// YAN-425: CSV writer for usage export — RFC 4180 quoting plus spreadsheet
// formula-injection neutralization — and the daily aggregation that folds
// request-level rows for sub-day periods.
import { describe, expect, it } from "vitest";
import {
  aggregateDailyRows,
  csvCell,
  csvHeader,
  csvRow,
  rowValues,
} from "@/lib/usage/exportFormat.js";

describe("csvCell quoting (RFC 4180)", () => {
  it("passes plain values through unquoted", () => {
    expect(csvCell("openai")).toBe("openai");
    expect(csvCell("gpt-4o")).toBe("gpt-4o");
    expect(csvCell("")).toBe("");
  });

  it("quotes values containing comma, quote, CR or LF and doubles quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell("a\rb")).toBe('"a\rb"');
  });

  it("renders null/undefined empty and keeps numbers numeric", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(1.25)).toBe("1.25");
  });
});

describe("csvCell formula injection", () => {
  it.each([["=SUM(A1:A2)"], ["+2+2"], ["-2+2"], ["@cmd"], ["\t=1"], ["\r=1"]])(
    "neutralizes string cell %j with a leading quote",
    (value) => {
      // After neutralization the cell may be RFC-quoted (CR case), so allow
      // an opening quote before the protective single quote.
      expect(csvCell(value)).toMatch(/^"?'/);
    },
  );

  it("neutralizes before quoting, so a formula with a comma stays inert text", () => {
    expect(csvCell("=a,b")).toBe('"\'=a,b"');
  });

  it("does not neutralize plain negative numbers or safe strings", () => {
    expect(csvCell(-12.5)).toBe("-12.5");
    expect(csvCell("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(csvCell("2026-10-26")).toBe("2026-10-26");
  });
});

describe("csvRow / csvHeader / rowValues", () => {
  it("joins cells with commas and terminates with CRLF", () => {
    expect(csvRow(["a", 1, null])).toBe("a,1,\r\n");
    expect(csvHeader(["date", "cost"])).toBe("date,cost\r\n");
  });

  it("projects a row onto the column list in order", () => {
    expect(rowValues(["b", "a", "missing"], { a: 1, b: 2 })).toEqual([2, 1, undefined]);
    expect(csvRow(rowValues(["x"], { x: "=1+1" }))).toBe("'=1+1\r\n");
  });
});

describe("aggregateDailyRows", () => {
  it("folds requests into per-day dimension groups with summed tokens/cost/savings", async () => {
    const rows = [
      {
        timestamp: "2026-10-26T01:00:00.000Z",
        provider: "openai",
        model: "gpt-4o",
        account: "Acct",
        account_id: "c1",
        api_key: "Key A",
        api_key_masked: "sk-***",
        endpoint: "/v1/chat/completions",
        prompt_tokens: 10,
        completion_tokens: 5,
        cached_tokens: 2,
        cost: 0.5,
        status: "ok",
        saved_tokens_est: 3,
      },
      {
        timestamp: "2026-10-26T02:00:00.000Z",
        provider: "openai",
        model: "gpt-4o",
        account: "Acct",
        account_id: "c1",
        api_key: "Key A",
        api_key_masked: "sk-***",
        endpoint: "/v1/chat/completions",
        prompt_tokens: 20,
        completion_tokens: 7,
        cached_tokens: 0,
        cost: 0.25,
        status: "ok",
        saved_tokens_est: 0,
      },
      {
        timestamp: "2026-10-26T03:00:00.000Z",
        provider: "openai",
        model: "gpt-4o-mini",
        account: "Acct",
        account_id: "c1",
        api_key: "Key A",
        api_key_masked: "sk-***",
        endpoint: "/v1/chat/completions",
        prompt_tokens: 1,
        completion_tokens: 1,
        cached_tokens: 0,
        cost: 0.01,
        status: "ok",
        saved_tokens_est: 0,
      },
    ];
    const daily = [];
    for await (const row of aggregateDailyRows(rows)) daily.push(row);
    expect(daily).toHaveLength(2);
    const main = daily.find((r) => r.model === "gpt-4o");
    expect(main).toMatchObject({
      requests: 2,
      prompt_tokens: 30,
      completion_tokens: 12,
      cached_tokens: 2,
      saved_tokens_est: 3,
    });
    expect(main.cost).toBe(0.75);
  });

  it("groups by server-local day, distinct api keys and connections, rounding cost", async () => {
    const savedTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const base = {
        // 2026-10-26T01:30Z is 2026-10-25 21:30 in New York.
        timestamp: "2026-10-26T01:30:00.000Z",
        provider: "openai",
        model: "gpt-4o",
        account: "Same name",
        account_id: "c1",
        api_key: "Same label",
        api_key_masked: "sk-***",
        endpoint: "/v1/chat",
        prompt_tokens: 1,
        completion_tokens: 1,
        cached_tokens: 0,
        status: "ok",
        saved_tokens_est: 0,
      };
      const rows = [
        { ...base, api_key_id: "k1", account_id: "c1", cost: 0.1 },
        { ...base, api_key_id: "k2", account_id: "c1", cost: 0.1 },
        { ...base, api_key_id: "k1", account_id: "c2", cost: 0.1 },
        { ...base, api_key_id: "k1", account_id: "c1", cost: 0.2 },
      ];
      const daily = [];
      for await (const row of aggregateDailyRows(rows)) daily.push(row);
      expect(daily).toHaveLength(3);
      expect(daily.every((r) => r.date === "2026-10-25")).toBe(true);
      expect(daily.find((r) => r.requests === 2).cost).toBe(0.3);
    } finally {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });
});
