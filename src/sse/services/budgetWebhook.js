// Budget webhook delivery (YAN-1831). budgetNotify schedules one delivery per
// claimed notice (soft crossing, first hard rejection) off the request path:
// scheduling is synchronous and never throws, the POST runs on a later tick,
// and every timer is unref'd. Each attempt re-reads the webhook row (deleted
// or disabled → stop) and goes through the pinned egress helper (one DNS
// resolution, blocked ranges refused, redirects never followed).
// Signature: `t=<unix s>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
// Logs carry the destination host and status only — never the URL path,
// query, body or secret. In-flight deliveries are dropped on shutdown; the
// notice claim is durable, so a restart loses at most that delivery.
import { createHmac } from "node:crypto";
import { fetchPinned } from "open-sse/utils/pinnedFetch.js";
import { header } from "@/shared/brand";
import { getBudgetWebhookForDeliveryUnscoped } from "@/lib/db/repos/budgetWebhooksRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";

/** Tunables (tests shrink them). */
export const C = { delaysMs: [0, 2000, 10000], timeoutMs: 5000, maxInFlight: 64 };

const RETRY_STATUS = new Set([408, 429]);
const RETRY_REASONS = new Set(["timeout", "network", "dns"]);

let inFlight = 0;
const pending = new Set();

/** Wire payload for a budget notice (pure). */
export function buildBudgetWebhookPayload(notice) {
  return {
    type: notice.kind === "hard" ? "budget.hard_limit" : "budget.soft_limit",
    id: notice.id,
    budgetId: notice.budgetId,
    workspaceId: notice.workspaceId,
    scope: { type: notice.scopeType, id: notice.scopeId },
    window: notice.window,
    windowStart: notice.windowStart,
    resetAt: notice.resetAt ?? null,
    limits: {
      usd: notice.limitUsd ?? null,
      tokens: notice.limitTokens ?? null,
      requests: notice.limitRequests ?? null,
    },
    spent: { ...notice.spent },
    threshold: { percent: notice.kind === "hard" ? 100 : notice.softLimitPct },
    timestamp: notice.at,
  };
}

export function signBudgetWebhook(secret, body, t) {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

const retryable = (r) =>
  RETRY_REASONS.has(r.reason) ||
  (r.reason === "http" && (r.status >= 500 || RETRY_STATUS.has(r.status)));

async function deliver(notice) {
  const body = JSON.stringify(buildBudgetWebhookPayload(notice));
  for (let attempt = 1; attempt <= C.delaysMs.length; attempt++) {
    await sleep(C.delaysMs[attempt - 1]);
    let hook;
    let allowPrivate;
    try {
      hook = await getBudgetWebhookForDeliveryUnscoped(notice.workspaceId);
      allowPrivate =
        (await getSettings({ secretMode: "metadata" })).budgetWebhookAllowPrivateNetworks === true;
    } catch (e) {
      console.warn("[budgetWebhook] delivery skipped", { code: e?.code ?? "unavailable" });
      return;
    }
    if (!hook) return;
    const t = Math.floor(Date.now() / 1000);
    const result = await fetchPinned(
      hook.url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [header("signature")]: signBudgetWebhook(hook.secret, body, t),
          [header("webhook-id")]: notice.id,
        },
        body,
      },
      { allowPrivate, timeoutMs: C.timeoutMs },
    );
    if (result.ok) return;
    console.warn("[budgetWebhook] delivery failed", {
      host: hostOf(hook.url),
      reason: result.reason,
      status: result.status ?? null,
      attempt,
    });
    if (!retryable(result)) return;
  }
}

/** Schedule delivery for a claimed notice. Synchronous; never throws. */
export function scheduleBudgetWebhook(notice) {
  try {
    if (notice?.workspaceId == null) return;
    if (inFlight >= C.maxInFlight) {
      console.warn("[budgetWebhook] dropped: too many deliveries in flight");
      return;
    }
    inFlight++;
    let settle;
    const done = new Promise((resolve) => {
      settle = resolve;
    });
    pending.add(done);
    setImmediate(() => {
      deliver(notice)
        .catch((e) => console.warn("[budgetWebhook] delivery error", { code: e?.code ?? null }))
        .finally(() => {
          inFlight--;
          pending.delete(done);
          settle();
        });
    });
  } catch (e) {
    console.warn("[budgetWebhook] schedule failed", { code: e?.code ?? null });
  }
}

export const __test__ = {
  inFlight: () => inFlight,
  settled: () => Promise.allSettled([...pending]),
};
