// YAN-373 review (CodeRabbit 4249943527): pasting the same invitation token
// again must re-trigger the status check. The node test env has no DOM, so the
// hashchange wiring is pinned from source, matching admin-workspace-flows.js.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  resolve(import.meta.dirname, "../../src/app/invite/InviteClient.js"),
  "utf8",
);
const onHash = src.slice(src.indexOf("const onHash"), src.indexOf("window.addEventListener"));

describe("same-token hashchange re-checks", () => {
  it("bumps a reload sequence on every hash navigation", () => {
    expect(onHash).toContain("setLoadSeq((seq) => seq + 1)");
  });
  it("keys the status effect on the sequence, not only the token", () => {
    expect(src).toMatch(/\}, \[token, loadSeq, showServerError\]\)/);
  });
  it("resets busy, retryAfter and the form so a stale check or error cannot persist", () => {
    for (const reset of [
      "setBusy(false)",
      "setRetryAfter(0)",
      'setForm({ email: "", username: "", displayName: "", password: "", confirmPassword: "" })',
      'setError("")',
    ]) {
      expect(onHash).toContain(reset);
    }
  });
  it("scrubs the hash and keeps the invalid-token message", () => {
    expect(onHash).toContain("window.history.replaceState");
    expect(onHash).toContain("This invitation link is not valid.");
    expect(src).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });
});
