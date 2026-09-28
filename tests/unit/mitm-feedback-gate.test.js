import { describe, expect, it } from "vitest";
import { readInterceptStatus } from "../../src/app/(dashboard)/dashboard/cli-tools/lib/interceptStatus.js";
import { getCopyableErrorDetails } from "../../src/app/(dashboard)/dashboard/errorDetails.js";

const mitmResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (body instanceof Error) throw body;
    return body;
  },
});

describe("readInterceptStatus", () => {
  it("stays Off when the server confirms it is stopped", async () => {
    await expect(
      readInterceptStatus(mitmResponse(200, { running: false, dnsStatus: { kiro: true } })),
    ).resolves.toEqual({});
  });

  it("throws on 304/500 instead of rendering unknown DNS as Off", async () => {
    await expect(readInterceptStatus(mitmResponse(304, {}))).rejects.toThrow(
      "MITM status request failed (304).",
    );
    await expect(readInterceptStatus(mitmResponse(500, { error: "boom" }))).rejects.toThrow(
      "MITM status request failed (500).",
    );
  });

  it("throws on unreadable or incomplete bodies instead of trusting them as Off", async () => {
    await expect(readInterceptStatus(mitmResponse(200, new Error("bad json")))).rejects.toThrow(
      "MITM status response was unreadable.",
    );
    for (const body of [
      {},
      { dnsStatus: { kiro: true } },
      { running: true },
      { running: true, dnsStatus: [] },
      { running: true, dnsStatus: {} },
    ]) {
      await expect(readInterceptStatus(mitmResponse(200, body))).rejects.toThrow(
        "missing DNS state",
      );
    }
  });
});

describe("getCopyableErrorDetails", () => {
  it("copies the server digest when present", () => {
    expect(getCopyableErrorDetails({ digest: "abc123", message: "sk-secret leaked here" })).toBe(
      "abc123",
    );
  });

  it("copies only fixed support text when there is no digest", () => {
    for (const error of [
      { digest: "", message: "sk-secret leaked here" },
      { message: "sk-secret leaked here" },
      null,
      undefined,
    ]) {
      const text = getCopyableErrorDetails(error);
      expect(text).toBe("Dashboard render error (no digest available)");
      expect(text).not.toContain("sk-secret");
    }
  });
});
