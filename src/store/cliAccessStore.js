/**
 * CLI access store (YAN-415). Set once any /api/cli-tools/* request gets the
 * guard's local-only refusal, so pages show one notice instead of per-card
 * errors and Retry buttons that can never succeed. Access does not change
 * within a browser session, so the flag never resets.
 */

import { create } from "zustand";

export const useCliAccessStore = create(() => ({ localOnly: false }));

/** Plain action: fetchers call it without adding a hook dependency. */
export const markLocalOnly = () => useCliAccessStore.setState({ localOnly: true });
