import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FOCUS_THROTTLE_MS,
  STALE_MS,
  getSnapshot,
  loadResource,
  onHomeFocus,
  resetHomeResourceStore,
  subscribe,
} from "@/app/(dashboard)/dashboard/home/homeResourceStore.js";

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

describe("Home resource store", () => {
  let fetchMock;

  beforeEach(() => {
    resetHomeResourceStore();
    fetchMock = vi.fn(async (url) => ok({ url }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", { hidden: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shares one GET between hooks that mount together, and re-reads on a new key", async () => {
    subscribe("/api/settings", () => {});
    subscribe("/api/settings", () => {});
    await Promise.all([
      loadResource("/api/settings", { key: 0 }),
      loadResource("/api/settings", { key: 0 }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await loadResource("/api/settings", { key: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes only stale data on focus, throttled", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    subscribe("/api/keys", () => {});
    subscribe("/api/combos", () => {});
    await Promise.all([loadResource("/api/keys"), loadResource("/api/combos")]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(onHomeFocus(now + 10_000)).toBe(0); // fresh: nothing re-read
    const stale = now + STALE_MS + 1;
    expect(onHomeFocus(stale)).toBe(2); // one GET per stale URL
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // Date.now is pinned, so the data is still stale; only the throttle holds it back.
    expect(onHomeFocus(stale + 1_000)).toBe(0);
    expect(onHomeFocus(stale + FOCUS_THROTTLE_MS)).toBe(2);
  });

  it("keeps the last good data when a refresh fails", async () => {
    subscribe("/api/providers", () => {});
    await loadResource("/api/providers");
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    });
    await loadResource("/api/providers", { key: 1 });
    expect(getSnapshot("/api/providers")).toEqual({
      data: { url: "/api/providers" },
      error: "boom",
      loading: false,
    });
  });
});
