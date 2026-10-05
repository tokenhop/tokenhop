// Post-write hooks shared by the settings and workspace settings routes.
// Combo rotation/poller/autoping need the same invalidation on both paths;
// only the stored object differs (instance blob vs merged workspace view).
import { resetComboRotation } from "open-sse/services/combo.js";

/**
 * Runtime invalidation after a settings write. Lazy imports keep the heavy
 * provider graphs out of the route's static graph.
 * @param {object} body The patched keys (drives which hooks fire).
 * @param {object} settings The stored result (drives autoping config).
 */
export function runSettingsSideEffects(body, settings) {
  // Invalidate combo rotation state when strategy settings change
  if (
    Object.hasOwn(body, "comboStrategy") ||
    Object.hasOwn(body, "comboStickyRoundRobinLimit") ||
    Object.hasOwn(body, "comboStrategies") ||
    Object.hasOwn(body, "comboStrategyPatch")
  ) {
    resetComboRotation();
  }

  if (
    Object.hasOwn(body, "fallbackStrategy") ||
    Object.hasOwn(body, "stickyRoundRobinLimit") ||
    Object.hasOwn(body, "providerStrategies")
  ) {
    // Reset in-memory SWRR state when account strategy changes. Lazy import keeps
    // auth.js's DB imports out of the route's static graph.
    import("@/sse/services/auth")
      .then(({ resetAccountSelection }) => resetAccountSelection?.())
      .catch((error) => console.warn("[AccountSelection] reset failed:", error.message));
  }

  if (Object.hasOwn(body, "claudeAutoPing") || Object.hasOwn(body, "codexAutoPing")) {
    // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
    // Re-read the full preference union (not the single written view) so one
    // workspace disabling autoPing never stops another workspace's opt-in.
    import("@/shared/services/quotaAutoPing")
      .then(({ configureQuotaAutoPing }) =>
        import("@/lib/db/index.js").then(({ getSettings, listEffectivePreferencesUnscoped }) =>
          Promise.all([getSettings(), listEffectivePreferencesUnscoped().catch(() => null)]).then(
            ([instance, list]) =>
              configureQuotaAutoPing(
                Array.isArray(list) && list.length > 0 ? [instance, ...list] : instance,
              ),
          ),
        ),
      )
      .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
  }

  if (
    Object.hasOwn(body, "fallbackStrategy") ||
    Object.hasOwn(body, "providerStrategies") ||
    Object.hasOwn(body, "comboStrategies") ||
    Object.hasOwn(body, "comboStrategy") ||
    Object.hasOwn(body, "comboStrategyPatch")
  ) {
    // Weighted gating changed: start/stop the snapshot backfill poller (YAN-259).
    import("@/shared/services/quotaSnapshotPoller")
      .then(({ syncQuotaSnapshotPoller }) => {
        syncQuotaSnapshotPoller();
      })
      .catch((error) =>
        console.warn("[QuotaSnapshotPoller] settings update failed:", error.message),
      );
  }
}
