/**
 * CLI access store (YAN-415). Set once any /api/cli-tools/* request gets the
 * guard's local-only refusal, so pages show one notice instead of per-card
 * errors and Retry buttons that can never succeed. Access does not change
 * within a browser session, so the flag never resets.
 *
 * YAN-374: a multi-user member (no instance.hostOps) gets the same
 * export-only UI via `markNoHost()`, which sets `localOnly` too and adds
 * `noHost`. `noHost` is distinct because remote admins (localOnly, hostOps
 * held) legitimately use `/api/cli-tool-settings` and `/api/cli-tool-presets`;
 * members must not call them (403), so they keep choices in memory instead.
 *
 * HIGH3: `markNoHost`/`clearNoHost` wipe the tool-settings and preset caches
 * so a member never sees another principal's host-fetched state, and never
 * keeps a promoted user's host state after their access flips. `remoteProbe`
 * keeps `localOnly`'s provenance: a genuine remote-dashboard probe survives
 * `clearNoHost`.
 */

import { create } from "zustand";

export const useCliAccessStore = create(() => ({
  localOnly: false,
  noHost: false,
  remoteProbe: false,
  keyCanCreate: false,
  identity: null,
  generation: 0,
}));

/** Plain action: fetchers call it without adding a hook dependency. */
export const markLocalOnly = () =>
  useCliAccessStore.setState({ localOnly: true, remoteProbe: true });

// Late-bound to avoid the eval-time cycle (the stores import this module).
const cacheResets = [];
/** Registered by toolSettingsStore / cliEndpointPresets; used only by the actions. */
export function onMemberCacheReset(fn) {
  cacheResets.push(fn);
}
export const resetCliCaches = () => {
  useCliAccessStore.setState((s) => ({ generation: s.generation + 1, keyCanCreate: false }));
  cacheResets.forEach((fn) => {
    fn();
  });
};

/**
 * Auth identity, role or workspace changes invalidate all principal-owned
 * caches. Login/logout are full-page navigations (location.assign/reload),
 * so there is no cross-session SPA state to clear — this covers in-session
 * identity flips (role or workspace change on the same page).
 */
export function syncCliIdentity(identity, noHost) {
  const previous = useCliAccessStore.getState().identity;
  if (previous !== identity && (previous !== null || identity !== null)) resetCliCaches();
  useCliAccessStore.setState({ identity });
  if (noHost) markNoHost();
  else clearNoHost();
}

/** Non-host principal: export-only UI, no host-gated routes, caches cleared. */
export function markNoHost() {
  if (useCliAccessStore.getState().noHost) return;
  useCliAccessStore.setState({ localOnly: true, noHost: true });
  resetCliCaches();
}

/**
 * Role regained host access (e.g. promoted): undo only what `markNoHost` set.
 * A remote dashboard (`remoteProbe` from `markLocalOnly`) stays localOnly.
 */
export function clearNoHost() {
  if (!useCliAccessStore.getState().noHost) return;
  useCliAccessStore.setState((s) => ({ localOnly: s.remoteProbe, noHost: false }));
  // Drop the member's memory-only choices; nothing was persisted for them.
  resetCliCaches();
}

/** Whether the signed-in principal may create workspace keys (key context). */
export const setKeyCanCreate = (value) => useCliAccessStore.setState({ keyCanCreate: !!value });
