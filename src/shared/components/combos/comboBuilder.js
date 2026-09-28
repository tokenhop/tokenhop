/**
 * Pure route-builder helpers for the Combos redesign (YAN-298).
 *
 * Pure module: no React, no imports from src/. Mirrors the semantics of
 * `src/app/(dashboard)/dashboard/combos/page.js` (parseWeight 0-1000,
 * weightOf fallback to saved ?? 1, headroom-scaled shares) and the board
 * copy in `docs/redesign/boards/project/Combos.dc.html`.
 */

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
];

/** Strategy id → StatusPill variant, matching the board. */
export const STRATEGY_PILL = {
  fallback: "brand",
  "round-robin": "info",
  weighted: "live",
  fusion: "warn",
};

export const STRATEGY_EXPLAINERS = {
  fallback:
    "Every request starts at #1. On a rate limit, auth error or outage, 9router moves down the list without your client noticing.",
  "round-robin":
    "Each request goes to the next model in the list, spreading load and quota evenly.",
  weighted:
    "Traffic splits by weight, then shifts away from accounts that are running low on quota.",
  fusion:
    "Every model in the panel answers in parallel. The judge reads them all and returns the best reply.",
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

function numOr(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Headroom-scaled traffic shares, one per weight, in percent to 1 decimal.
 * Matches page behavior: weight 0 → share 0; total 0 → all 0.
 * Missing weights default to 1; non-finite/negative headroom defaults to 1.
 */
export function weightShare(weights = [], headroom = []) {
  const len = Math.max(weights?.length || 0, headroom?.length || 0);
  const effective = Array.from({ length: len }, (_, i) => {
    const w = numOr(weights?.[i], 1);
    const rawH = headroom?.[i];
    const h = rawH === undefined || rawH === null ? 1 : Number(rawH);
    const hh = Number.isFinite(h) && h >= 0 ? h : 1;
    return w * hh;
  });
  const total = effective.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return effective.map(() => 0);
  return effective.map((v) => Math.round((v / total) * 1000) / 10);
}

/** Weight 0 means the model is fallback-only (never picked first). */
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
