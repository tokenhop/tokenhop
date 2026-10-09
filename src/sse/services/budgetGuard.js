// Gateway budget enforcement (YAN-372, ADR-0007): every level on the request
// path (key → user → membership → workspace, plus the grant actually routed
// through) must pass; an estimate is reserved before the upstream call, actual
// usage settles via the usage-commit hook, the hold is released when the
// response ends, errors or is cancelled.
// ponytail: single-process reservations and counters (handbook §1 single
// instance). Check+reserve below is synchronous (better-sqlite3 reads are
// sync, no await in between), so it is atomic in Node without a mutex; all
// async work (switch read, pricing) happens before it. Move to a shared store
// if the gateway ever scales out.
import { AsyncLocalStorage } from "node:async_hooks";
import { getAdapter } from "@/lib/db/driver.js";
import { getPricingForModel } from "@/lib/db/repos/pricingRepo.js";
import { statsEmitter } from "@/lib/db/repos/usageLiveFeed.js";
import { audit } from "@/lib/users/audit.js";
import {
  budgetsGeneration,
  membershipScopeId,
  windowEnd,
  windowStart,
} from "@/lib/users/budgets.js";
import { isMultiUserEnabled } from "@/lib/users/featureSwitch.js";
import { onUsageCommitted } from "@/lib/usage/usageCommitted.js";
import {
  BUDGET_DEFAULT_MAX_TOKENS,
  BUDGET_FALLBACK_RESERVE_USD,
  BUDGET_RESERVATION_MAX_MS,
  BUDGET_SETTLE_GRACE_MS,
} from "open-sse/config/runtimeConfig.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { calculateCostFromTokens } from "open-sse/providers/pricing.js";
import { estimateBodyTokens } from "./grantRateLimiter.js";

const FIELDS = { usd: "limitUsd", tokens: "limitTokens", requests: "limitRequests" };
const UNITS = Object.keys(FIELDS);
const PATH_LEVELS = ["key", "user", "membership", "workspace"];
const SWITCH_TTL_MS = 1000;
const zero = () => ({ usd: 0, tokens: 0, requests: 0 });
const successful = (status) => status == null || status === "ok" || status === "success";

const requestHolds = new AsyncLocalStorage();
const counters = new Map(); // `${budgetId}:${windowStart}` → state
let rows = [];
let generation = -1;
let loading = null;
let enabled = false;
let switchExpires = 0;
let db = null;

// Trusted gateway reader: compares scopes against resolved attribution only.
function listBudgetRowsUnscoped(adapter) {
  return adapter.all("SELECT * FROM budgets");
}

/**
 * Fast gate: false for legacy (no principal), switch off, or no budget rows —
 * one cached boolean per request on the no-budget path (no DB query).
 */
export async function hasBudgets(principal) {
  if (!principal) return false;
  if (Date.now() >= switchExpires) {
    enabled = await isMultiUserEnabled();
    switchExpires = Date.now() + SWITCH_TTL_MS;
  }
  if (!enabled) return false;
  if (generation !== budgetsGeneration()) {
    loading ??= getAdapter()
      .then((adapter) => {
        const gen = budgetsGeneration();
        db = adapter;
        rows = listBudgetRowsUnscoped(adapter);
        generation = gen;
        // Drop window state of deleted budgets (live budgets keep theirs: a
        // purge would lose in-flight reservations). Ids are never reused.
        const live = new Set(rows.map((b) => b.id));
        for (const [k, s] of counters) if (!live.has(s.budget.id)) counters.delete(k);
      })
      .finally(() => {
        loading = null;
      });
    try {
      await loading;
    } catch (e) {
      // Fail open (ADR-0007 availability over enforcement); retried next request.
      console.warn("[budgetGuard] budget read failed, not enforcing:", e?.message);
      return false;
    }
  }
  return rows.length > 0;
}

function scopeIdOf(level, who) {
  if (level === "key") return who.apiKeyId;
  if (level === "user") return who.userId;
  if (level === "membership") {
    return who.workspaceId && who.userId ? membershipScopeId(who.workspaceId, who.userId) : null;
  }
  if (level === "workspace") return who.workspaceId;
  return who.grantId;
}

const matches = (budget, who) => {
  const id = scopeIdOf(budget.scopeType, who);
  return id != null && id === budget.scopeId;
};

function scopeFilter(budget) {
  if (budget.scopeType === "membership") {
    const i = budget.scopeId.indexOf(":");
    return [
      "workspaceId = ? AND userId = ?",
      [budget.scopeId.slice(0, i), budget.scopeId.slice(i + 1)],
    ];
  }
  const column = { key: "apiKeyId", user: "userId", workspace: "workspaceId", grant: "grantId" }[
    budget.scopeType
  ];
  return [`${column} = ?`, [budget.scopeId]];
}

/**
 * Settled spend of `budget` in the UTC window containing `now`, from
 * usageHistory (settled-success rows in the budget's scope). `notionalUsd` is
 * the subset of `usd` priced on subscription connections (meta.notional).
 * Synchronous; shared by enforcement and the budget GET routes.
 */
export function spentFor(db, budget, now = Date.now()) {
  const [sql, params] = scopeFilter(budget);
  const spent = db.get(
    `SELECT COALESCE(SUM(cost), 0) AS usd, COALESCE(SUM(promptTokens + completionTokens), 0) AS tokens, COUNT(*) AS requests, COALESCE(SUM(CASE WHEN CASE WHEN json_valid(meta) THEN json_extract(meta, '$.notional') END = 1 THEN cost ELSE 0 END), 0) AS notionalUsd FROM usageHistory WHERE ${sql} AND timestamp >= ? AND (status IS NULL OR status IN ('ok', 'success'))`,
    [...params, new Date(windowStart(budget.window, now)).toISOString()],
  );
  return {
    usd: Number(spent.usd),
    tokens: Number(spent.tokens),
    requests: Number(spent.requests),
    notionalUsd: Number(spent.notionalUsd),
  };
}

// Spent for the current UTC window: rebuilt from settled usageHistory rows the
// first time a window is seen (also the crash-recovery path after a restart),
// then kept current by the usage-commit hook. Synchronous.
function stateFor(budget, now = Date.now()) {
  const start = windowStart(budget.window, now);
  const key = `${budget.id}:${start}`;
  let state = counters.get(key);
  if (!state) {
    const { usd, tokens, requests } = spentFor(db, budget, now);
    state = {
      start,
      budget,
      spent: { usd, tokens, requests },
      reserved: zero(),
      softEmitted: false,
    };
    for (const [k, old] of counters) if (old.budget.id === budget.id) counters.delete(k);
    counters.set(key, state);
    state.budget = budget;
    notifySoftLimit(state); // history may already be past the threshold
  }
  state.budget = budget; // limits may have changed (new generation)
  return state;
}

function exceeded(state, estimate) {
  for (const unit of UNITS) {
    const limit = state.budget[FIELDS[unit]];
    if (limit != null && state.spent[unit] + state.reserved[unit] + estimate[unit] > limit) {
      return { budget: state.budget, unit, spent: state.spent[unit] };
    }
  }
  return null;
}

const fmt = (unit, n) => (unit === "usd" ? `$${Number(n).toFixed(2)}` : `${n} ${unit}`);

/** ADR-0007 429: OpenAI-shaped, names the level and window. */
export function budgetResponse({ budget, unit, spent }, now = Date.now()) {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  const end = windowEnd(budget.window, now);
  if (end != null) headers["Retry-After"] = String(Math.max(1, Math.ceil((end - now) / 1000)));
  const per = budget.window === "total" ? "in total" : `per ${budget.window}`;
  const res = new Response(
    JSON.stringify({
      error: {
        message: `Budget exceeded at ${budget.scopeType} level: ${fmt(unit, budget[FIELDS[unit]])} ${per} (spent ${fmt(unit, spent)}).`,
        type: "insufficient_quota",
        param: null,
        code: "budget_exceeded",
        level: budget.scopeType,
        window: budget.window,
      },
    }),
    { status: 429, headers },
  );
  res.localError = true; // request-scoped: combos advance, no account cooldown
  return res;
}

/** All-granted-candidates-over-budget result for getProviderCredentials. */
export function budgetLimitedResult(limit) {
  const end = windowEnd(limit.budget.window);
  return {
    allRateLimited: true,
    retryAfter: end != null ? new Date(end).toISOString() : null,
    retryAfterHuman: end != null ? "next budget window" : "does not reset",
    lastError: "Grant budget exceeded",
    lastErrorCode: 429,
    budgetLimit: limit,
  };
}

// Input chars/4 + max_tokens (or the default) priced from the pricing table;
// unknown pricing and non-token modalities reserve the fallback constant.
async function estimateUsage({ provider, model, body, nonToken, noOutput }) {
  if (nonToken) return { usd: BUDGET_FALLBACK_RESERVE_USD, tokens: 0, requests: 1 };
  // Non-positive or junk max_tokens never shrinks the reservation below the
  // default; a huge one is capped at the model's output limit (ADR-0007), so
  // one client can't hold a whole workspace budget with max_tokens: 1e6.
  const asked = Number(
    body?.max_tokens ?? body?.max_completion_tokens ?? body?.generationConfig?.maxOutputTokens,
  );
  const cap = Number(getCapabilitiesForModel(provider, model)?.maxOutput) || Infinity;
  const output = noOutput ? 0 : Math.min(asked > 0 ? asked : BUDGET_DEFAULT_MAX_TOKENS, cap);
  const input = estimateBodyTokens({ ...body, max_tokens: 0, max_completion_tokens: 0 });
  let pricing = null;
  if (provider && model) pricing = await getPricingForModel(provider, model).catch(() => null);
  const usd = pricing
    ? calculateCostFromTokens({ prompt_tokens: input, completion_tokens: output }, pricing)
    : BUDGET_FALLBACK_RESERVE_USD;
  return { usd: Number(usd) || 0, tokens: input + output, requests: 1 };
}

// Synchronous check of every budget, then reserve on every budget. Returns a
// limit descriptor when one is exceeded, else an idempotent release function.
function reserve(budgets, estimate) {
  let states;
  try {
    states = budgets.map((b) => stateFor(b));
  } catch (e) {
    // Spent rebuild failed (DB error): fail open, nothing reserved.
    console.warn("[budgetGuard] spend read failed, not enforcing:", e?.message);
    return { release() {} };
  }
  for (const s of states) {
    const hit = exceeded(s, estimate);
    if (hit) return { hit };
  }
  for (const s of states) for (const u of UNITS) s.reserved[u] += estimate[u];
  let done = false;
  return {
    release() {
      if (done) return;
      done = true;
      for (const s of states)
        for (const u of UNITS) s.reserved[u] = Math.max(0, s.reserved[u] - estimate[u]);
    },
  };
}

const grantBudgets = (grantId) =>
  rows.filter((b) => b.scopeType === "grant" && b.scopeId === grantId);

/** Selection-time context for grant budgets; null (zero cost) when none apply. */
export function grantBudgetContext() {
  const store = requestHolds.getStore();
  if (!store || !rows.some((b) => b.scopeType === "grant")) return null;
  return store;
}

/** Non-reserving peek: is this grant over one of its budgets? */
export function grantBudgetLimit(grantId, ctx) {
  if (!ctx || !grantId) return null;
  try {
    for (const b of grantBudgets(grantId)) {
      const hit = exceeded(stateFor(b), ctx.estimate);
      if (hit) return hit;
    }
  } catch {
    return null; // fail open; reserveGrantBudget logs the read failure
  }
  return null;
}

/**
 * Reserve the chosen grant's budgets (only budgets of the grant actually
 * routed through apply). Returns { hit } or a handle whose release is
 * idempotent; the request wrapper also releases it when the response ends.
 */
export function reserveGrantBudget(grantId, ctx) {
  if (!ctx || !grantId) return null;
  const budgets = grantBudgets(grantId);
  if (!budgets.length) return null;
  const r = reserve(budgets, ctx.estimate);
  if (r.release) ctx.releases.push(r.release);
  return r;
}

// Release once the body is fully read, errors or is cancelled, plus a hard cap
// so a never-consumed body can't hold budget forever. The settle grace lets the
// async usage commit land before the hold drops (bounded overshoot).
function releaseWhenDone(res, release, held) {
  if (!held || !(res instanceof Response) || !res.body || !res.ok || res.bodyUsed) {
    release();
    return res;
  }
  const cap = setTimeout(release, BUDGET_RESERVATION_MAX_MS);
  cap.unref?.();
  const finish = () => {
    clearTimeout(cap);
    const t = setTimeout(release, BUDGET_SETTLE_GRACE_MS);
    t.unref?.();
  };
  let reader;
  try {
    reader = res.body.getReader();
  } catch {
    release(); // locked/disturbed body: can't observe its end
    return res;
  }
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
        } else controller.enqueue(value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
  const out = new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
  for (const k of Object.keys(res)) out[k] = res[k]; // localError and other handler flags
  return out;
}

/**
 * Leaf-handler hook. Returns null when the caller should just continue: no
 * principal, switch off, no budgets, or already inside this request's budget
 * scope. Otherwise reserves on the principal's path (429 when over) and
 * re-invokes `self` inside the scope, releasing when its response ends.
 * Usage: `const held = await budgeted(gateway, { provider, model, body }, () => fn(...args));
 * if (held) return held;`
 * @param {object|null} principal
 * @param {{ provider?: string, model?: string, body?: object, nonToken?: boolean, noOutput?: boolean }} opts
 * @param {() => Promise<Response>} self
 * @returns {Promise<Response|null>}
 */
export async function budgeted(principal, opts, self) {
  if (requestHolds.getStore() || !(await hasBudgets(principal))) return null;
  return withBudget(principal, opts, self);
}

/** Same as `budgeted`, for callers that can't re-enter: wraps `run` or just runs it. */
export async function withBudgetScope(principal, opts, run) {
  return (await budgeted(principal, opts, run)) ?? run();
}

async function withBudget(principal, opts, run) {
  const estimate = await estimateUsage(opts);
  const path = PATH_LEVELS.flatMap((lvl) =>
    rows.filter((b) => b.scopeType === lvl && matches(b, principal)),
  );
  const store = { estimate, releases: [] };
  if (path.length) {
    const r = reserve(path, estimate);
    if (r.hit) return budgetResponse(r.hit);
    store.releases.push(r.release);
  }
  const releaseAll = () => {
    for (const fn of store.releases) fn();
  };
  let res;
  try {
    res = await requestHolds.run(store, run);
  } catch (err) {
    releaseAll();
    throw err;
  }
  return releaseWhenDone(res, releaseAll, store.releases.length > 0);
}

function notifySoftLimit(state) {
  const b = state.budget;
  if (state.softEmitted || b.softLimitPct == null) return;
  const crossed = UNITS.some(
    (u) => b[FIELDS[u]] != null && state.spent[u] >= (b[FIELDS[u]] * b.softLimitPct) / 100,
  );
  if (!crossed) return;
  state.softEmitted = true;
  const after = {
    scopeType: b.scopeType,
    scopeId: b.scopeId,
    window: b.window,
    level: b.scopeType,
    limitUsd: b.limitUsd,
    limitTokens: b.limitTokens,
    limitRequests: b.limitRequests,
    softLimitPct: b.softLimitPct,
    spentUsd: state.spent.usd,
    spentTokens: state.spent.tokens,
    spentRequests: state.spent.requests,
  };
  void audit(
    { workspaceId: b.workspaceId },
    "budget.softLimit",
    { type: "budget", id: b.id },
    { after },
  );
  statsEmitter.emit("budgetSoftLimit", { budgetId: b.id, workspaceId: b.workspaceId, ...after });
}

// Settle: a committed usage row adds its actuals to every live window it
// belongs to. Windows built later read the row from usageHistory instead.
// One live listener across module reloads (Next HMR, vi.resetModules): drop
// the previous instance's subscription before adding this one.
globalThis.__budgetGuardUnsubscribe?.();
globalThis.__budgetGuardUnsubscribe = onUsageCommitted((entry) => {
  if (!successful(entry.status) || counters.size === 0) return;
  const ts = Date.parse(entry.timestamp) || Date.now();
  for (const state of counters.values()) {
    if (!matches(state.budget, entry) || windowStart(state.budget.window, ts) !== state.start)
      continue;
    state.spent.usd += Number(entry.cost) || 0;
    state.spent.tokens += (Number(entry.promptTokens) || 0) + (Number(entry.completionTokens) || 0);
    state.spent.requests += 1;
    notifySoftLimit(state);
  }
});
