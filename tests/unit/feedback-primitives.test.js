import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clipboard = vi.hoisted(() => ({ copyTextToClipboard: vi.fn() }));
vi.mock("../../src/shared/components/formPrimitives.js", () => clipboard);

let slots;
let index;
vi.mock("react", () => ({
  useState(initial) {
    const slot = index++;
    slots[slot] ??= { value: initial };
    return [
      slots[slot].value,
      (value) => {
        slots[slot].value = value;
      },
    ];
  },
  useRef(initial) {
    const slot = index++;
    slots[slot] ??= { current: initial };
    return slots[slot];
  },
  useCallback(fn) {
    return fn;
  },
  useEffect(fn) {
    fn();
  },
}));

import { useCopyToClipboard } from "../../src/shared/hooks/useCopyToClipboard.js";
import { toastRole, useNotificationStore } from "../../src/store/notificationStore.js";

const renderHook = () => {
  index = 0;
  return useCopyToClipboard(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  slots = [];
  index = 0;
  clipboard.copyTextToClipboard.mockReset();
  useNotificationStore.getState().clearAll();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("clipboard feedback", () => {
  it("awaits a rejected write and never announces success", async () => {
    clipboard.copyTextToClipboard.mockRejectedValue(new Error("permission denied"));
    const { copy } = renderHook();
    expect(await copy("secret", "key")).toBe(false);
    expect(clipboard.copyTextToClipboard).toHaveBeenCalledWith("secret");
    expect(renderHook()).toMatchObject({ copied: null, error: "key" });
  });

  it("only reports a successful copy after the write resolves", async () => {
    let resolve;
    clipboard.copyTextToClipboard.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = renderHook().copy("value", "key");
    expect(renderHook().copied).toBeNull();
    resolve();
    expect(await pending).toBe(true);
    expect(renderHook()).toMatchObject({ copied: "key", error: null });
  });
});

describe("toast store", () => {
  it("keeps optional undo action and announces errors as alerts", () => {
    const onSelect = vi.fn();
    const action = { label: "Undo", onSelect };
    const id = useNotificationStore.getState().error("Could not save", { action });
    const [entry] = useNotificationStore.getState().notifications;
    expect(entry).toMatchObject({ id, type: "error", action });
    expect(toastRole(entry.type)).toBe("alert");
    expect(toastRole("success")).toBe("status");
  });

  it("keeps existing title calls working", () => {
    useNotificationStore.getState().error("Failed", "Old title");
    expect(useNotificationStore.getState().notifications[0].title).toBe("Old title");
  });
});
