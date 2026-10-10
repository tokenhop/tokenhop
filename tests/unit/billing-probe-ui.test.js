import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  billingProbeFeedback,
  billingProbeOutcome,
  probeErrorLabel,
  probeNotifyMethod,
} from "@/shared/utils/providerHealth.js";

const read = (rel) =>
  readFileSync(
    resolve(__dirname, "../../src/app/(dashboard)/dashboard/providers/detail", rel),
    "utf8",
  );
const rowSrc = read("SortableConnectionRow.js");
const hookSrc = read("useConnections.js");
const pageSrc = read("ProviderDetailPage.js");
const sectionSrc = read("ConnectionsSection.js");

describe("billing probe error codes", () => {
  it.each([
    ["billing", "Still out of credit"],
    ["auth", "Key was rejected"],
    ["rate_limited", "Provider rate limit"],
    ["server_error", "Provider error"],
    ["timeout", "Probe timed out"],
    ["network", "Network error"],
    ["invalid_response", "Unexpected reply"],
    ["unknown", "Probe failed"],
  ])("maps %s to plain copy", (code, label) => {
    expect(probeErrorLabel(code)).toBe(label);
  });

  it("explains how to clear a lock when the probe model is gone", () => {
    expect(probeErrorLabel("probe_model_unavailable")).toMatch(
      /replace the API key or re-enable the connection/,
    );
  });

  it("never echoes raw text, prototype keys or non-strings", () => {
    for (const raw of ["sk-secret leaked 402 body", "constructor", "__proto__", 42, {}, []]) {
      expect(probeErrorLabel(raw)).toBe("Probe failed");
    }
    expect(probeErrorLabel(null)).toBeNull();
    expect(probeErrorLabel(undefined)).toBeNull();
    expect(probeErrorLabel("")).toBeNull();
  });
});

describe("billing probe feedback", () => {
  it("keeps not_locked and maps not_found and disabled separately", () => {
    expect(billingProbeFeedback("not_locked")).toEqual({
      variant: "info",
      text: "No longer out of credit.",
    });
    expect(billingProbeFeedback("not_found")).toEqual({
      variant: "err",
      text: "Connection no longer exists",
    });
    expect(billingProbeFeedback("disabled").text).toBe("Enable this connection before probing it.");
    expect(billingProbeFeedback("constructor").variant).toBe("err");
  });

  it("maps HTTP outcomes and always asks for a refetch", () => {
    expect(billingProbeOutcome(200, { result: "cleared" })).toMatchObject({
      variant: "ok",
      refetch: true,
    });
    expect(billingProbeOutcome(200, { result: "still_locked" }).variant).toBe("warn");
    expect(billingProbeOutcome(409, { result: "disabled" })).toMatchObject({
      variant: "err",
      text: "Enable this connection before probing it.",
      refetch: true,
    });
    expect(billingProbeOutcome(409, { error: "Connection is disabled" }).text).toBe(
      "Enable this connection before probing it.",
    );
    expect(billingProbeOutcome(404, { result: "not_found" })).toMatchObject({
      variant: "err",
      text: "Connection no longer exists",
      refetch: true,
    });
    expect(billingProbeOutcome(500, { error: "Billing probe failed" })).toMatchObject({
      variant: "err",
      text: "Billing probe failed",
      refetch: true,
    });
    expect(billingProbeOutcome(500, null).text).toBe("Probe failed. Try again later.");
  });

  it("turns a 429 into a try-again-in message", () => {
    expect(billingProbeOutcome(429, { result: "rate_limited", retryAfterMs: 4 * 60_000 })).toEqual({
      variant: "warn",
      text: "Probed recently. Try again in 4m.",
      refetch: true,
    });
    expect(billingProbeOutcome(429, { result: "rate_limited", retryAfterMs: 1 }).text).toBe(
      "Probed recently. Try again in 1m.",
    );
    expect(
      billingProbeOutcome(429, { result: "rate_limited", retryAfterMs: 90 * 60_000 }).text,
    ).toBe("Probed recently. Try again in 2h.");
    expect(billingProbeOutcome(429, {}).text).toBe("Probed recently. Try again later.");
  });

  it("maps notify variants to notification store methods", () => {
    expect(["ok", "err", "warn", "info", "weird"].map(probeNotifyMethod)).toEqual([
      "success",
      "error",
      "warning",
      "info",
      "info",
    ]);
  });
});

describe("billing probe UI wiring", () => {
  it("renders the Probe button only for a lock the caller may manage", () => {
    expect(rowSrc).toMatch(
      /const showProbe = !!billingLock && canManage && typeof onProbe === "function"/,
    );
    expect(rowSrc).toMatch(/\{showProbe \? \(/);
    expect(rowSrc).toContain('view.can("workspace.connections.manage", connection.workspaceId)');
    // Disabled rows never carry a lock: connectionHealth returns "off" first.
    expect(rowSrc).toMatch(/billingLock = health\.state === "out_of_credit"/);
  });

  it("marks the button busy and disabled while probing", () => {
    expect(rowSrc).toMatch(/disabled=\{probing\}/);
    expect(rowSrc).toMatch(/aria-busy=\{probing \|\| undefined\}/);
    expect(rowSrc).toMatch(/aria-label=\{`Probe now \$\{displayName\}`\}/);
  });

  it("renders only mapped probe errors and no raw lock text", () => {
    expect(rowSrc).toContain("probeErrorLabel(billingLock.lastProbeError)");
    expect(rowSrc).not.toMatch(/title=\{billingLock\.lastProbeError\}/);
    expect(rowSrc).not.toMatch(/billingLock\.message/);
    expect(rowSrc).not.toMatch(/\{billingLock\.lastProbeError\}/);
  });

  it("dedupes probes per connection and reloads after every outcome", () => {
    expect(hookSrc).toMatch(/if \(probingRef\.current\.has\(id\)\) return;/);
    expect(hookSrc).toContain("billingProbeOutcome(res.status, data)");
    expect(hookSrc).toMatch(
      /finally \{[\s\S]*probingRef\.current\.delete\(id\)[\s\S]*fetchConnections\(\)/,
    );
  });

  it("routes toasts through the shared notify mapping and rows through the section", () => {
    expect(pageSrc).toContain("store[probeNotifyMethod(variant)](message)");
    expect(pageSrc).toContain("useConnections({ providerId, notifyError, notifyResult })");
    expect(sectionSrc).toContain("onProbe={() => conn.probeBilling(entry.id)}");
    expect(sectionSrc).toContain("probing={conn.probingIds.includes(entry.id)}");
  });
});
