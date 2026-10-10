// Shared helpers for billing-* tests: an in-memory store that mimics
// mutateBillingLockUnscoped's transactional contract, and a fake executor.
import { vi } from "vitest";

export const CLAUDE_OK = {
  type: "message",
  content: [{ type: "text", text: "hi" }],
  usage: { input_tokens: 8, output_tokens: 1 },
};
export const OPENAI_OK = {
  choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
};

export function lockOf(generation = 100, extra = {}) {
  return {
    reason: "credit_exhausted",
    code: "http_400",
    message: "Upstream reported exhausted credit or spend limit",
    lockedAt: new Date().toISOString(),
    nextProbeAt: new Date(Date.now() - 1000).toISOString(),
    lastProbeAt: null,
    lastProbeError: null,
    generation,
    ...extra,
  };
}

/** In-memory connection row + the same mutate contract as the DB repo. */
export function makeStore(row) {
  const live = { id: "a1", provider: "anthropic", authType: "apikey", isActive: true, ...row };
  const mutate = vi.fn(async (_id, decide) => {
    if (live.__deleted) return { applied: false, missing: true, billingLock: null };
    const patch = decide({ ...live });
    if (!patch) {
      return {
        applied: false,
        missing: false,
        billingLock: live.billingLock ? { ...live.billingLock } : null,
        disabled: live.isActive === false,
      };
    }
    if ("billingLock" in patch) live.billingLock = patch.billingLock ?? undefined;
    return { applied: true, missing: false, billingLock: live.billingLock ?? null };
  });
  return { live, mutate };
}

export function makeDeps(store, { body = CLAUDE_OK, status = 200, execute, pricing } = {}) {
  const exec =
    execute ?? vi.fn(async () => ({ response: new Response(JSON.stringify(body), { status }) }));
  return {
    exec,
    deps: {
      getConnection: vi.fn(async () => (store.live.__deleted ? null : { ...store.live })),
      getMetadata: vi.fn(async () => ({ ...store.live })),
      listActive: vi.fn(async () => [{ ...store.live }]),
      mutate: store.mutate,
      getPricing: vi.fn(async () => (pricing === undefined ? { input: 1, output: 5 } : pricing)),
      getExecutor: vi.fn(() => ({ execute: exec })),
      resolveConnectionProxyConfig: vi.fn(async () => ({})),
      saveDetail: vi.fn(async () => {}),
    },
  };
}
