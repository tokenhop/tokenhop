// Budget notices (YAN-1830, YAN-1832): once per budget, kind and window, a
// `soft` notice when settled spend crosses softLimitPct and a `hard` notice on
// the first budget_exceeded 429. Each is audited and emitted on statsEmitter
// ("budgetNotice") for the usage stream.
// Durable: the claim is a compare-and-set row in budgetNotices
// (budgetNoticesRepo), written synchronously before anything is sent, so a
// restart inside a window never repeats a notice and a new window re-arms it.
// The claim carries the budget's limit signature (+ softLimitPct for soft):
// changing a limit or the soft % in-window re-arms the notice.
// Fail open: notices never block or fail a gateway request. A claim write
// error still sends the notice (worst case one duplicate after a restart),
// except a foreign-key failure: the budget was deleted, so nothing is sent.
// A DB import/restore keeps the claims of the budget ids it keeps (YAN-1929),
// so a restore repeats no notice in the same window; restored limits that
// differ change the signature and re-arm it, like any limit change.
// A workspace budget webhook (YAN-1831) is scheduled off the request path
// after the claim, so it inherits the once-per-window guarantee (and the
// claim-failure duplicate caveat).
import { claimBudgetNoticeUnscoped } from "@/lib/db/repos/budgetNoticesRepo.js";
import { statsEmitter } from "@/lib/db/repos/usageLiveFeed.js";
import { audit } from "@/lib/users/audit.js";
import { windowEnd } from "@/lib/users/budgets.js";
import { noticeId, noticeSignature } from "@/shared/utils/budgetNotice.js";
import { scheduleBudgetWebhook } from "./budgetWebhook.js";

const FIELDS = { usd: "limitUsd", tokens: "limitTokens", requests: "limitRequests" };
const ACTIONS = { soft: "budget.softLimit", hard: "budget.hardStop" };

/** Statsemitter event the usage stream forwards (after its own filtering). */
export const BUDGET_NOTICE_EVENT = "budgetNotice";

/** Has settled spend reached softLimitPct of any limit? */
export function softCrossed(budget, spent) {
  if (budget.softLimitPct == null) return false;
  return Object.entries(FIELDS).some(
    ([u, f]) => budget[f] != null && spent[u] >= (budget[f] * budget.softLimitPct) / 100,
  );
}

/**
 * Send the `kind` notice for a window state once (state: { start, budget,
 * spent, notices }). `notices[kind]` caches the signature already claimed in
 * this process, so repeat checks cost no DB access. Synchronous.
 */
export function notifyOnce(db, state, kind, now = Date.now()) {
  const b = state.budget;
  const signature = noticeSignature(b, kind);
  if (state.notices[kind] === signature) return;
  state.notices[kind] = signature;
  const windowStart = new Date(state.start).toISOString();
  try {
    const won = claimBudgetNoticeUnscoped(db, {
      budgetId: b.id,
      kind,
      windowStart,
      signature,
      notifiedAt: new Date(now).toISOString(),
    });
    if (!won) return; // already sent for this window and limits (e.g. before a restart)
  } catch (e) {
    // Same message on every adapter (cf. mapConstraintErrors in users/errors.js).
    if (String(e?.message).includes("FOREIGN KEY constraint failed")) return;
    console.warn("[budgetGuard] notice claim failed, sending unclaimed:", e?.message);
  }
  const end = windowEnd(b.window, state.start);
  const notice = {
    id: noticeId(b.id, kind, windowStart),
    kind,
    budgetId: b.id,
    workspaceId: b.workspaceId,
    scopeType: b.scopeType,
    scopeId: b.scopeId,
    window: b.window,
    limitUsd: b.limitUsd,
    limitTokens: b.limitTokens,
    limitRequests: b.limitRequests,
    softLimitPct: b.softLimitPct,
    spent: { ...state.spent },
    windowStart,
    resetAt: end == null ? null : new Date(end).toISOString(),
    at: new Date(now).toISOString(),
  };
  void audit(
    { workspaceId: b.workspaceId },
    ACTIONS[kind],
    { type: "budget", id: b.id },
    {
      after: {
        scopeType: b.scopeType,
        scopeId: b.scopeId,
        window: b.window,
        windowStart,
        level: b.scopeType,
        limitUsd: b.limitUsd,
        limitTokens: b.limitTokens,
        limitRequests: b.limitRequests,
        softLimitPct: b.softLimitPct,
        spentUsd: state.spent.usd,
        spentTokens: state.spent.tokens,
        spentRequests: state.spent.requests,
      },
    },
  );
  try {
    statsEmitter.emit(BUDGET_NOTICE_EVENT, notice);
  } catch (e) {
    console.warn("[budgetGuard] notice listener failed:", e?.message);
  }
  scheduleBudgetWebhook(notice);
}

/** Soft notice when the window's settled spend is past the threshold. */
export function notifySoftLimit(db, state) {
  if (softCrossed(state.budget, state.spent)) notifyOnce(db, state, "soft");
}
