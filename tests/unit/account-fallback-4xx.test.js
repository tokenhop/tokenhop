// Regression: an unmatched 4xx (a request-scoped failure) used to hit the
// transient-cooldown default, which locked the account for 30s and — with a
// single connection — answered every other request in that window with a copy of
// the first error. A 400 "maximum context length" from one session therefore
// looked like the same failure in unrelated sessions.
import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { handleComboChat, isModelScopedError } from "../../open-sse/services/combo.js";

describe("checkFallbackError — request-scoped vs account-scoped failures", () => {
  it("does not cool the account down for a 400 caused by the request", () => {
    const result = checkFallbackError(
      400,
      JSON.stringify({
        error: {
          message:
            "This model's maximum context length is 1048576 tokens. However, you requested 1186139 tokens",
          type: "invalid_request_error",
        },
      }),
    );

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
  });

  it("still falls back for account-scoped statuses", () => {
    for (const status of [401, 402, 403, 404, 429]) {
      expect(checkFallbackError(status, "nope").shouldFallback).toBe(true);
    }
  });

  it("still honours rate-limit / quota wording on any 4xx", () => {
    expect(checkFallbackError(400, "rate limit reached").shouldFallback).toBe(true);
    expect(checkFallbackError(422, "quota exceeded").shouldFallback).toBe(true);
  });

  it("rotates away from a Claude account that is out of extra usage without locking it", () => {
    const message =
      "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.";
    const json = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message },
    });

    for (const errorText of [json, `[400]: ${message}`]) {
      expect(checkFallbackError(400, errorText)).toEqual({ shouldFallback: true, cooldownMs: 0 });
    }
  });

  it("keeps the transient cooldown for unmatched server errors", () => {
    const result = checkFallbackError(503, "upstream exploded");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });
});

describe("model-scoped 4xx (YAN-660)", () => {
  const codexEntitlement =
    "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.";

  it("locks the model on that account for the Codex ChatGPT-plan entitlement error", () => {
    const result = checkFallbackError(400, codexEntitlement);
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });

  it("classifies 404/410 and model-not-supported 400s as model-scoped, not request-scoped", () => {
    expect(isModelScopedError(410, "Gone")).toBe(true);
    expect(isModelScopedError(404, "nope")).toBe(true);
    expect(isModelScopedError(400, codexEntitlement)).toBe(true);
    expect(isModelScopedError(400, "INVALID_MODEL_ID")).toBe(true);
    expect(isModelScopedError(400, "maximum context length exceeded")).toBe(false);
    expect(isModelScopedError(422, "unknown model")).toBe(false);
  });

  it("a combo advances past a 410 to the next member", async () => {
    const replies = [
      new Response(JSON.stringify({ error: { message: "model retired" } }), { status: 410 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ];
    const seen = [];
    const res = await handleComboChat({
      body: {},
      models: ["p/old", "p/new"],
      handleSingleModel: async (_b, m) => {
        seen.push(m);
        return replies.shift();
      },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["p/old", "p/new"]);
  });
});
