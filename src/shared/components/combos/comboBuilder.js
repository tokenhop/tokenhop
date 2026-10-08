/**
 * Pure route-builder helpers for the Combos redesign (YAN-298).
 *
 * Pure module: no React, no imports from src/. Mirrors the semantics of
 * `src/app/(dashboard)/dashboard/combos/page.js` (parseWeight 0-1000,
 * weightOf fallback to saved ?? 1) and the board copy in
 * `docs/redesign/boards/project/Combos.dc.html`. Weighted-share math comes
 * from `open-sse/services/comboWeights.js` — the same pure helper the router
 * uses (YAN-411), never re-implemented here.
 */
import { ACTIVE } from "@/shared/brand";

import {
  comboBaseWeight,
  comboQuotaHeadroom,
  comboShares,
  effectiveComboWeight,
} from "open-sse/services/comboWeights.js";

/** Where the remaining-quota number came from → plain-English label. */
export const QUOTA_SOURCE_LABELS = {
  static: "no quota data yet",
  header: "provider-reported",
  probe: "from the last quota probe",
};

/**
 * Per-step effective-share explanation for the weighted strategy, derived
 * from the router's own math (comboWeights.js). Returns one entry per model:
 * `{ base, quota, quotaSource, share, fallbackOnly, outOfQuota }` — the
 * configured weight, remaining quota (0–1) and its source, and the effective
 * traffic share in percent. Shares are per model: duplicate rows show the
 * same share because the router dedupes weighted candidates.
 * @param {string[]} models
 * @param {Object<string, number>} weights
 * @param {Object<string, number>} headroomByModel
 * @param {Object<string, string>} [quotaSourceByModel]
 */
export function explainWeightedShares(models, weights, headroomByModel, quotaSourceByModel) {
  const list = Array.isArray(models) ? models : [];
  const shares = comboShares(list, weights, headroomByModel);
  return list.map((model, index) => {
    const quota = comboQuotaHeadroom(headroomByModel?.[model]);
    const base = comboBaseWeight(model, weights);
    return {
      base,
      quota,
      quotaSource: quotaSourceByModel?.[model] || "static",
      share: shares[index] ?? 0,
      fallbackOnly: base === 0,
      outOfQuota: base > 0 && effectiveComboWeight(model, weights, quota) === 0,
    };
  });
}

/**
 * One-line effective-share explanation for a weighted step (YAN-411):
 * configured weight, remaining quota with its source, effective share.
 */
export function shareDetailText(explanation) {
  if (!explanation) return null;
  const source = QUOTA_SOURCE_LABELS[explanation.quotaSource] || QUOTA_SOURCE_LABELS.static;
  if (explanation.fallbackOnly) {
    return "Weight 0 — fallback only: no traffic until the others fail.";
  }
  if (explanation.outOfQuota) {
    return `No quota left (${source}) — paused until quota resets.`;
  }
  const quotaPct = Math.round(explanation.quota * 100);
  return `Weight ${explanation.base} × ${quotaPct}% quota left (${source}) → about ${explanation.share}% of traffic.`;
}

export const STRATEGIES = [
  {
    id: "fallback",
    label: "Fallback",
    desc: "Try in order until one answers",
    icon: "low_priority",
  },
  {
    id: "round-robin",
    label: "Round robin",
    desc: "Rotate on every request",
    icon: "autorenew",
  },
  {
    id: "weighted",
    label: "Weighted",
    desc: "Split by weight and remaining quota",
    icon: "bar_chart",
  },
  { id: "fusion", label: "Fusion", desc: "Ask a panel, let a judge pick", icon: "gavel" },
  {
    id: "fastest",
    label: "Fastest",
    desc: "Prefer the model with the lowest recent latency",
    icon: "speed",
  },
];

/** Strategy id → StatusPill variant, matching the board. */
export const STRATEGY_PILL = {
  fallback: "brand",
  "round-robin": "info",
  weighted: "live",
  fusion: "warn",
  fastest: "ok",
};

export const STRATEGY_EXPLAINERS = {
  fallback: `Every request starts at #1. On a rate limit, auth error or outage, ${ACTIVE.slug} moves down the list without your client noticing.`,
  "round-robin":
    "Each request goes to the next model in the list, spreading load and quota evenly.",
  weighted:
    "Traffic splits by weight, then shifts away from accounts that are running low on quota.",
  fusion:
    "Every model in the panel answers in parallel. The judge reads them all and returns the best reply.",
  fastest:
    "The router tracks each model's recent response time and sends new requests to the quickest. Untried models go first until they have numbers. Failed attempts count as slow, so flaky models sink.",
};

/**
 * Role label for a model at `index` under `strategy`.
 * Unknown strategies fall back to Primary/Backup ordering.
 */
export function roleLabel(strategy, index) {
  if (strategy === "round-robin") return "In rotation";
  if (strategy === "weighted") return "Weighted";
  if (strategy === "fusion") return "Panelist";
  return index === 0 ? "Primary" : "Backup";
}

/**
 * Weight 0 means the model is fallback-only (never picked first).
 */
export function isFallbackOnly(weight) {
  return weight === 0;
}

/**
 * Same contract as page.js parseWeight: 0-1000 finite number.
 * Accepts strings and numbers.
 */
export function parseWeight(raw) {
  if (raw === undefined || raw === null) return { ok: false, error: "Enter a number" };
  if (typeof raw === "string" && raw.trim() === "")
    return { ok: false, error: "Enter a finite number" };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return { ok: false, error: "Enter a finite number" };
  if (parsed < 0 || parsed > 1000) return { ok: false, error: "Weight must be between 0 and 1000" };
  return { ok: true, value: parsed };
}

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

/** Same contract as the combo form name validation. */
export function validateComboName(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) return { ok: false, error: "Name is required" };
  if (!VALID_NAME_REGEX.test(trimmed))
    return { ok: false, error: "Only letters, numbers, -, _ and . allowed" };
  return { ok: true, value: trimmed };
}

function deepCopy(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Small reducer for editor dirty-state.
 * state = { saved, draft, errors }. Never mutates its input.
 * - {type:'set', field, value} → draft[field] = value
 * - {type:'reset'} → draft = copy(saved), errors = {}
 * - {type:'saved', saved} → saved + draft = copy(saved), errors = {}
 */
export function applyEditorAction(state, action) {
  if (!state || !action) return state;
  if (action.type === "set") {
    return { ...state, draft: { ...state.draft, [action.field]: action.value } };
  }
  if (action.type === "reset") {
    return { ...state, draft: deepCopy(state.saved), errors: {} };
  }
  if (action.type === "saved") {
    const next = deepCopy(action.saved);
    return { ...state, saved: next, draft: deepCopy(next), errors: {} };
  }
  return state;
}

/** True when draft JSON differs from saved JSON. */
export function isDirty(state) {
  if (!state) return false;
  return JSON.stringify(state.saved) !== JSON.stringify(state.draft);
}

export const CAPABILITY_ADAPTER_CAPS = ["vision", "audioInput"];

/**
 * Capability-adapter keys whose pool is enabled but empty. Missing entries
 * default to enabled (the DB default), matching the settings seed.
 * @param {Record<string, { enabled?: boolean, models?: string[] }>} adapter
 * @returns {string[]}
 */
export function adapterWarnings(adapter) {
  const out = [];
  for (const key of CAPABILITY_ADAPTER_CAPS) {
    const entry = adapter?.[key];
    const enabled = entry?.enabled !== false;
    const models = Array.isArray(entry?.models) ? entry.models.filter(Boolean) : [];
    if (enabled && models.length === 0) out.push(key);
  }
  return out;
}

/**
 * Canonical save snapshot for dirty comparison: weights key order is
 * normalized so server round-trips never read as edits.
 */
export function comboSnapshot({ models = [], strategy = "fallback", weights = {}, judge = "" }) {
  const sortedWeights = {};
  for (const k of Object.keys(weights || {}).sort()) sortedWeights[k] = weights[k];
  return {
    models: [...models],
    strategy,
    weights: sortedWeights,
    judge: judge || "",
  };
}

/**
 * Stable per-instance step identities for the route track.
 * The API allows duplicate models, so the model string alone cannot key
 * React rows, dnd-kit sortables, or weight drafts. Reuses previous ids per
 * model (queue order) so reorder/add/remove keep every surviving instance's
 * id; fresh ids are `step-N` skipping taken ones. Pure and fixpoint-stable:
 * `assignStepIds(models, assignStepIds(models, prev))` deep-equals the
 * second call, so render-time derivation is StrictMode-safe.
 * @param {string[]} models Current ordered model strings.
 * @param {{ id: string, model: string }[]} [prevSteps] Previous steps.
 * @returns {{ id: string, model: string }[]}
 */
export function assignStepIds(models, prevSteps = []) {
  const queues = new Map();
  for (const s of prevSteps || []) {
    if (!s || typeof s.id !== "string" || typeof s.model !== "string") continue;
    if (!queues.has(s.model)) queues.set(s.model, []);
    queues.get(s.model).push(s);
  }
  const taken = new Set();
  for (const s of prevSteps || []) if (s && typeof s.id === "string") taken.add(s.id);
  let fresh = 0;
  return (models || []).map((model) => {
    const q = queues.get(model);
    if (q && q.length > 0) return q.shift();
    let id;
    do {
      fresh += 1;
      id = `step-${fresh}`;
    } while (taken.has(id));
    taken.add(id);
    return { id, model };
  });
}

/**
 * Drop keys not in `validIds` (weight drafts/errors for removed steps).
 * @param {Record<string, unknown>} obj
 * @param {Set<string> | string[]} validIds
 */
export function pruneKeys(obj, validIds) {
  const valid = validIds instanceof Set ? validIds : new Set(validIds || []);
  const next = {};
  for (const [k, v] of Object.entries(obj || {})) if (valid.has(k)) next[k] = v;
  return next;
}

/**
 * Sum of usage-today requests for a combo name and/or its member models from
 * `/api/usage/stats?period=today` byModel keys ("model (provider)").
 */
export function usageTodayForCombo(combo, byModel) {
  if (!byModel || typeof byModel !== "object") return 0;
  const name = typeof combo === "string" ? combo : combo?.name;
  const models = Array.isArray(combo?.models) ? combo.models : [];
  let total = 0;
  for (const [key, entry] of Object.entries(byModel)) {
    const raw = entry?.rawModel || String(key).split(" (")[0];
    if (raw === name) {
      total += entry?.requests || 0;
    } else if (models.length > 0) {
      for (const m of models) {
        const bare = m.includes("/") ? m.slice(m.indexOf("/") + 1) : m;
        if (raw === m || raw === bare) {
          total += entry?.requests || 0;
          break;
        }
      }
    }
  }
  return total;
}
