import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  leaveOverSentinel,
  requestComboNavigation,
  takeDeferredForward,
} from "../../src/shared/components/combos/comboSave.js";

const source = (file) => readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");

describe("combo palette navigation guard", () => {
  it("asks before a dirty jump; cancel leaves the draft; confirm discards first", () => {
    const events = [];
    let pending = null;
    const request = (action) => {
      pending = action;
    };
    requestComboNavigation(
      true,
      request,
      () => events.push("discard"),
      () => events.push("navigate"),
    );
    expect(events).toEqual([]);
    pending = null; // Keep editing
    expect(events).toEqual([]);
    requestComboNavigation(
      true,
      request,
      () => events.push("discard"),
      () => events.push("navigate"),
    );
    pending(); // Discard changes
    expect(events).toEqual(["discard", "navigate"]);
  });

  it("runs clean navigation without a dialog or discard", () => {
    const request = vi.fn();
    const discard = vi.fn();
    const navigate = vi.fn();
    requestComboNavigation(false, request, discard, navigate);
    expect(request).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("consumes the Back sentinel before a confirmed leave: one history entry added", () => {
    const back = vi.fn();
    const navigate = vi.fn();
    const state = { armed: true, pendingForward: null };
    leaveOverSentinel(state, back, navigate);
    expect(state).toEqual({ armed: false, pendingForward: navigate });
    expect(back).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    // The sentinel's popstate then runs the deferred navigation exactly once.
    const forward = takeDeferredForward(state);
    expect(state.pendingForward).toBeNull();
    forward();
    expect(navigate).toHaveBeenCalledOnce();
    expect(takeDeferredForward(state)).toBeNull();
  });

  it("a second leave while the sentinel pop is in flight replaces the first", () => {
    const back = vi.fn();
    const first = vi.fn();
    const second = vi.fn();
    const state = { armed: true, pendingForward: null };
    leaveOverSentinel(state, back, first);
    leaveOverSentinel(state, back, second);
    expect(back).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    takeDeferredForward(state)();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("navigates in place when no sentinel is armed", () => {
    const back = vi.fn();
    const navigate = vi.fn();
    leaveOverSentinel({ armed: false, pendingForward: null }, back, navigate);
    expect(back).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("wires palette and g chords through the mounted combo guard", () => {
    const palette = source("shared/components/CommandPaletteProvider.js");
    const page = source("app/(dashboard)/dashboard/combos/CombosPageClient.js");
    const hook = source("shared/components/combos/useUnsavedComboGuard.js");
    expect(palette).toContain("registerRouteGuard");
    expect(palette).toMatch(/navigate\(\(\) => router\.push\(run\.href\), run\.href\)/);
    expect(palette).toMatch(/navigate\(\(\) => router\.push\(result\.href\), result\.href\)/);
    expect(page).toContain("registerRouteGuard(guard)");
    expect(page).toContain("guard.requestNavigation(() => {");
    expect(hook).toContain("leaveOverSentinel");
    // Same-URL palette pick is a no-op: never discards the draft.
    expect(hook).toMatch(/=== window\.location\.href\s*\)\s*return;/);
  });
});
