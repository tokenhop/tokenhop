import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  debounce,
  fieldReducer,
  initialFieldState,
  patchSetting,
} from "@/app/(dashboard)/dashboard/settings/useSettingsField.js";

describe("fieldReducer", () => {
  it("starts idle with the server value", () => {
    expect(initialFieldState(true)).toEqual({
      value: true,
      savedValue: true,
      status: "idle",
      error: "",
    });
  });

  it("optimistic toggle updates value and marks saving", () => {
    const next = fieldReducer(initialFieldState(true), { type: "optimistic", value: false });
    expect(next).toMatchObject({ value: false, savedValue: true, status: "saving" });
  });

  it("saved commits the value and clears errors", () => {
    const saving = fieldReducer(initialFieldState(true), { type: "optimistic", value: false });
    const next = fieldReducer(saving, { type: "saved", value: false });
    expect(next).toMatchObject({ value: false, savedValue: false, status: "saved", error: "" });
  });

  it("failed rolls back to the last saved value with the server error", () => {
    const saving = fieldReducer(initialFieldState(true), { type: "optimistic", value: false });
    const next = fieldReducer(saving, { type: "failed", error: "Invalid value" });
    expect(next).toMatchObject({ value: true, savedValue: true, status: "error" });
    expect(next.error).toBe("Invalid value");
  });

  it("clear-error resets status and message", () => {
    const failed = fieldReducer(initialFieldState(true), { type: "failed", error: "Bad" });
    const next = fieldReducer(failed, { type: "clear-error" });
    expect(next).toMatchObject({ status: "idle", error: "" });
    expect(next.savedValue).toBe(true);
  });

  it("external sync only adopts server values when idle or saved", () => {
    const saving = fieldReducer(initialFieldState(true), { type: "optimistic", value: false });
    expect(fieldReducer(saving, { type: "sync", value: true }).value).toBe(false);
    expect(fieldReducer(initialFieldState(false), { type: "sync", value: true }).value).toBe(true);
  });
});

describe("debounce helper", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once after the delay with the latest value", async () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);
    debounced("a");
    debounced("b");
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("b");
  });

  it("cancel drops the pending call", async () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);
    debounced("a");
    debounced.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("patchSetting", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends a single-key PATCH and returns the echoed settings", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ requireLogin: false })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(patchSetting("requireLogin", false)).resolves.toEqual({ requireLogin: false });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ requireLogin: false });
  });

  it("throws the server validation error for inline display", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ error: "Invalid authMode" }), { status: 400 }),
      ),
    );
    await expect(patchSetting("authMode", "x")).rejects.toThrow("Invalid authMode");
  });
});
