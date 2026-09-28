import { describe, expect, it, vi } from "vitest";
import { onceAsync, prefetchOnIdle } from "@/shared/utils/paletteLazy.js";

describe("palette lazy loaders", () => {
  it("shares an in-flight load and runs it only once", async () => {
    const load = vi.fn().mockResolvedValue({ ready: true });
    const ensure = onceAsync(load);
    const first = ensure();
    expect(ensure()).toBe(first);
    expect(await first).toEqual({ ready: true });
    expect(await ensure()).toEqual({ ready: true });
    expect(load).toHaveBeenCalledOnce();
  });

  it("retries after a failed chunk import", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("chunk failed")).mockResolvedValue("ok");
    const ensure = onceAsync(load);
    await expect(ensure()).rejects.toThrow("chunk failed");
    await expect(ensure()).resolves.toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("uses and cancels the browser idle callback", () => {
    const requestIdleCallback = vi.fn().mockReturnValue(7);
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal("window", { requestIdleCallback, cancelIdleCallback });
    try {
      const task = vi.fn();
      const cancel = prefetchOnIdle(task);
      expect(requestIdleCallback).toHaveBeenCalledWith(task, { timeout: 2000 });
      cancel();
      expect(cancelIdleCallback).toHaveBeenCalledWith(7);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses and cancels the timeout fallback", () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn();
      const cancel = prefetchOnIdle(task);
      cancel();
      vi.runAllTimers();
      expect(task).not.toHaveBeenCalled();
      prefetchOnIdle(task);
      vi.advanceTimersByTime(1500);
      expect(task).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
