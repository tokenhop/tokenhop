// Budget notice toasts (YAN-1830). The usage stream forwards live notices
// only, but an EventSource reconnect or a second tab must still never show
// the same notice twice. Shown notices persist in localStorage as
// `id → { sig, until }`: `id` is `${budgetId}:${kind}:${windowStart}`, `sig`
// the limit signature it was sent for (a re-armed notice after a limit change
// shows again), `until` its window's reset. Entries past their reset are
// pruned on every write; the map is capped. Storage that is missing or throws
// (disabled, SecurityError, quota) falls back to showing the toast.
import { translate } from "@/i18n/runtime";
import { noticeSignature } from "@/shared/utils/budgetNotice.js";

export const SHOWN_KEY = "tokenhop.budgetNotices.shown";
const MAX_ENTRIES = 200;

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // SecurityError: storage blocked for this origin
  }
}

function read(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(SHOWN_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Record `notice` as shown. True when this call is the first to show it (the
 * caller toasts), false for a repeat. Storage failures fall back to showing.
 * @param {{ id: string, kind: string, resetAt: string|null }} notice
 * @param {Storage|null} [storage]
 * @param {number} [now]
 */
export function claimNoticeToast(notice, storage = defaultStorage(), now = Date.now()) {
  if (!notice || typeof notice.id !== "string") return false;
  if (!storage) return true;
  const sig = noticeSignature(notice, notice.kind);
  const shown = read(storage);
  if (shown[notice.id]?.sig === sig) return false;
  const kept = Object.entries(shown).filter(
    ([, v]) => v && (v.until == null || Date.parse(v.until) > now),
  );
  kept.push([notice.id, { sig, until: notice.resetAt ?? null }]);
  try {
    storage.setItem(SHOWN_KEY, JSON.stringify(Object.fromEntries(kept.slice(-MAX_ENTRIES))));
  } catch {}
  return true;
}

// Fixed strings per kind and scope, so each is one extractable literal.
const SOFT_MESSAGES = {
  workspace: () => translate("A workspace budget passed its soft limit."),
  key: () => translate("An API key budget passed its soft limit."),
  membership: () => translate("A member budget passed its soft limit."),
  grant: () => translate("A grant budget passed its soft limit."),
  user: () => translate("A user budget passed its soft limit."),
};
const HARD_MESSAGES = {
  workspace: () =>
    translate(
      "A request was rejected because it would exceed a workspace budget. Smaller requests may still pass until it resets.",
    ),
  key: () =>
    translate(
      "A request was rejected because it would exceed an API key budget. Smaller requests may still pass until it resets.",
    ),
  membership: () =>
    translate(
      "A request was rejected because it would exceed a member budget. Smaller requests may still pass until it resets.",
    ),
  grant: () =>
    translate(
      "A request was rejected because it would exceed a grant budget. Smaller requests may still pass until it resets.",
    ),
  user: () =>
    translate(
      "A request was rejected because it would exceed a user budget. Smaller requests may still pass until it resets.",
    ),
};

/** Toast input for the notification store. */
export function noticeToast(notice) {
  if (notice.kind === "hard") {
    return {
      type: "error",
      title: translate("Budget limit hit"),
      message: (HARD_MESSAGES[notice.scopeType] ?? HARD_MESSAGES.workspace)(),
      duration: 10000,
    };
  }
  return {
    type: "warning",
    title: translate("Soft limit reached"),
    message: (SOFT_MESSAGES[notice.scopeType] ?? SOFT_MESSAGES.workspace)(),
    duration: 8000,
  };
}
