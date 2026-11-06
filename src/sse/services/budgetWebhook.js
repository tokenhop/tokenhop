// Budget webhook delivery (YAN-1831). budgetNotify schedules one delivery per
// claimed notice (soft crossing, first hard rejection) off the request path
// (global and per-workspace concurrency caps, bounded per-workspace queue):
// scheduling is synchronous and never throws, the POST runs on a later tick,
// and every timer is unref'd. Each attempt re-reads the webhook row (deleted
// or disabled → stop) and goes through the pinned egress helper (one DNS
// resolution, blocked ranges refused, redirects never followed).
// Signature: `t=<unix s>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
// Logs carry the destination host and status only — never the URL path,
// query, body or secret. In-flight deliveries are dropped on shutdown; the
// notice claim is durable, so a restart loses at most that delivery.
import { createHash, createHmac } from "node:crypto";
import { fetchPinned } from "open-sse/utils/pinnedFetch.js";
import { header } from "@/shared/brand";
import { getBudgetWebhookForDeliveryUnscoped } from "@/lib/db/repos/budgetWebhooksRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";

/** Tunables (tests shrink them). */
export const C = {
  delaysMs: [0, 2000, 10000],
  timeoutMs: 5000,
  // Global cap on concurrent deliveries, and per workspace: one slow endpoint
  // cannot hold every slot. Excess waits in a bounded per-workspace FIFO.
  maxInFlight: 64,
  perWorkspaceInFlight: 2,
  perWorkspaceQueue: 16,
};

const RETRY_STATUS = new Set([408, 429]);
const RETRY_REASONS = new Set(["timeout", "network", "dns"]);

let inFlight = 0;
// workspaceId → { active, queue: [{ notice, webhookId, settle }] }
const lanes = new Map();
// Scheduled deliveries (queued or running) until they finish.
const pending = new Set();

/**
 * Delivery id: notice id + 12 hex of sha256(noticeSignature + "|" + claim
 * time). The claim time (`notice.at`) is fixed for one claim, so retries keep
 * the id; every re-arm (even back to earlier limits) gets a new one.
 */
export function webhookIdFor(notice, signature) {
  const digest = createHash("sha256")
    .update(`${signature ?? ""}|${notice.at ?? ""}`)
    .digest("hex")
    .slice(0, 12);
  return `${notice.id}:${digest}`;
}

/** Wire payload for a budget notice (pure); `id` is the delivery id. */
export function buildBudgetWebhookPayload(notice, id) {
  return {
    type: notice.kind === "hard" ? "budget.hard_limit" : "budget.soft_limit",
    id,
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

async function deliver(notice, webhookId) {
  const body = JSON.stringify(buildBudgetWebhookPayload(notice, webhookId));
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
          [header("webhook-id")]: webhookId,
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

function startDelivery(lane, job) {
  inFlight++;
  lane.active++;
  setImmediate(() => {
    deliver(job.notice, job.webhookId)
      .catch((e) => console.warn("[budgetWebhook] delivery error", { code: e?.code ?? null }))
      .finally(() => {
        inFlight--;
        lane.active--;
        // It just used a slot: its next job waits behind other workspaces.
        const workspaceId = job.notice.workspaceId;
        if (lanes.get(workspaceId) === lane) {
          lanes.delete(workspaceId);
          lanes.set(workspaceId, lane);
        }
        job.settle();
        pump();
      });
  });
}

// Start queued deliveries while the global and per-workspace caps allow:
// round-robin, one job per lane per round. A lane that just started or
// finished a job moves to the back of the order, so the next free global slot
// goes to another workspace. Idle lanes are dropped.
function pump() {
  let started = true;
  while (started && inFlight < C.maxInFlight) {
    started = false;
    for (const [workspaceId, lane] of [...lanes]) {
      if (inFlight >= C.maxInFlight) break;
      if (!lane.queue.length || lane.active >= C.perWorkspaceInFlight) continue;
      startDelivery(lane, lane.queue.shift());
      lanes.delete(workspaceId);
      lanes.set(workspaceId, lane);
      started = true;
    }
  }
  for (const [workspaceId, lane] of [...lanes]) {
    if (!lane.active && !lane.queue.length) lanes.delete(workspaceId);
  }
}

/**
 * Schedule delivery for a claimed notice. Synchronous; never throws.
 * `signature` is the claim's noticeSignature: the webhook id is the notice id
 * plus a digest of it, so a re-armed notice (limit or soft % changed in the
 * window) gets a new id while retries of one delivery keep theirs.
 */
export function scheduleBudgetWebhook(notice, signature) {
  try {
    const workspaceId = notice?.workspaceId;
    if (workspaceId == null) return;
    const webhookId = webhookIdFor(notice, signature);
    const lane = lanes.get(workspaceId) ?? { active: 0, queue: [] };
    const startsNow =
      !lane.queue.length && lane.active < C.perWorkspaceInFlight && inFlight < C.maxInFlight;
    if (!startsNow && lane.queue.length >= C.perWorkspaceQueue) {
      console.warn("[budgetWebhook] dropped: workspace delivery queue full");
      return;
    }
    lanes.set(workspaceId, lane);
    let settle;
    const done = new Promise((resolve) => {
      settle = resolve;
    });
    pending.add(done);
    lane.queue.push({
      notice,
      webhookId,
      settle: () => {
        pending.delete(done);
        settle();
      },
    });
    pump();
  } catch (e) {
    console.warn("[budgetWebhook] schedule failed", { code: e?.code ?? null });
  }
}

export const __test__ = {
  inFlight: () => inFlight,
  pending: () => pending.size,
  settled: async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  },
};
