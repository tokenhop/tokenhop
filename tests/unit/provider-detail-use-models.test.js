import { beforeEach, describe, expect, it, vi } from "vitest";

let slots;
let index;
vi.mock("react", () => ({
  useState(initial) {
    const slot = index++;
    slots[slot] ??= { value: typeof initial === "function" ? initial() : initial };
    return [
      slots[slot].value,
      (update) => {
        slots[slot].value = typeof update === "function" ? update(slots[slot].value) : update;
      },
    ];
  },
  useCallback(fn) {
    return fn;
  },
  useEffect() {},
}));

import { useModels } from "../../src/app/(dashboard)/dashboard/providers/detail/useModels.js";
import { useNotificationStore } from "../../src/store/notificationStore.js";

const notifyError = vi.fn();
const renderHook = () => {
  index = 0;
  return useModels({
    providerId: "compatible",
    storageAlias: "compatible",
    staticModels: [],
    catalogModels: [{ id: "model-a" }],
    notifyError,
  });
};
const response = (body = {}, ok = true) => ({ ok, json: async () => body });
const queue = (...responses) => {
  for (const item of responses) fetch.mockResolvedValueOnce(item);
};

beforeEach(() => {
  slots = [];
  index = 0;
  notifyError.mockReset();
  vi.stubGlobal("fetch", vi.fn());
  useNotificationStore.getState().clearAll();
});

describe("provider model failures", () => {
  it("reports every failed load GET without wiping existing state", async () => {
    queue(
      response({ aliases: { old: "compatible/model-a" } }),
      response({ models: [] }),
      response({ ids: [] }),
    );
    expect(await renderHook().load()).toBe(true);
    queue(
      response({ error: "aliases failed" }, false),
      response({ error: "custom failed" }, false),
      response({ error: "disabled failed" }, false),
    );
    expect(await renderHook().load()).toBe(false);
    expect(notifyError.mock.calls.map(([message]) => message)).toEqual([
      "aliases failed",
      "custom failed",
      "disabled failed",
    ]);
    expect(renderHook().modelAliases).toEqual({ old: "compatible/model-a" });
  });

  it("restores thinking mode when GET or PATCH fails", async () => {
    queue(response({ providerThinking: { compatible: { mode: "high" } } }));
    expect(await renderHook().loadThinking()).toBe(true);
    queue(response({ error: "settings unavailable" }, false));
    expect(await renderHook().changeThinking("low")).toBe(false);
    expect(renderHook().thinkingMode).toBe("high");
    queue(response({ providerThinking: {} }), response({ error: "write denied" }, false));
    expect(await renderHook().changeThinking("low")).toBe(false);
    expect(renderHook().thinkingMode).toBe("high");
    expect(notifyError.mock.calls.map(([message]) => message)).toEqual([
      "settings unavailable",
      "write denied",
    ]);
  });

  it("reports failed writes, avoids refresh, and returns false", async () => {
    const operations = [
      (hook) => hook.setAlias("model-a", "short"),
      (hook) => hook.deleteAlias("short"),
      (hook) => hook.addCustomModel("custom"),
      (hook) => hook.deleteCustomModel("custom"),
      (hook) => hook.disableModel("model-a"),
      (hook) => hook.enableModel("model-a"),
      (hook) => hook.enableAll(),
    ];
    const hook = renderHook();
    for (const action of operations) {
      fetch.mockReset();
      queue(response({ error: "server rejected" }, false));
      expect(await action(hook)).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    expect(notifyError).toHaveBeenCalledTimes(operations.length);
    expect(useNotificationStore.getState().notifications).toEqual([]);
  });

  it("reports failed refresh after successful write instead of claiming success", async () => {
    queue(response(), response({ error: "reload rejected" }, false));
    expect(await renderHook().disableModel("model-a")).toBe(false);
    expect(notifyError).toHaveBeenCalledWith("reload rejected");
  });

  it("restores custom model type and caps via Undo after successful removal", async () => {
    const original = {
      providerAlias: "compatible",
      id: "custom",
      type: "llm",
      name: "Named custom model",
      caps: { vision: true },
    };
    queue(response({ aliases: {} }), response({ models: [original] }), response({ ids: [] }));
    await renderHook().load();
    queue(response(), response({ models: [] }));
    expect(await renderHook().deleteCustomModel("custom")).toBe(true);
    const [toast] = useNotificationStore.getState().notifications;
    expect(toast.action.label).toBe("Undo");
    queue(response(), response({ models: [original] }));
    await toast.action.onSelect();
    const post = fetch.mock.calls.findLast(
      ([url, options]) => url === "/api/models/custom" && options?.method === "POST",
    );
    expect(JSON.parse(post[1].body)).toEqual({
      providerAlias: "compatible",
      id: "custom",
      type: "llm",
      name: "Named custom model",
      caps: { vision: true },
    });
    expect(renderHook().customModels).toEqual([original]);
  });

  it("restores alias mapping via Undo after successful removal", async () => {
    queue(
      response({ aliases: { short: "compatible/model-a" } }),
      response({ models: [] }),
      response({ ids: [] }),
    );
    await renderHook().load();
    queue(response(), response({ aliases: {} }));
    expect(await renderHook().deleteAlias("short")).toBe(true);
    const [toast] = useNotificationStore.getState().notifications;
    queue(response(), response({ aliases: { short: "compatible/model-a" } }));
    await toast.action.onSelect();
    const put = fetch.mock.calls.findLast(
      ([url, options]) => url === "/api/models/alias" && options?.method === "PUT",
    );
    expect(JSON.parse(put[1].body)).toEqual({ alias: "short", model: "compatible/model-a" });
  });

  it("reports disabled-batch confirmation failure without an unhandled rejection", async () => {
    let confirm;
    const requestConfirm = (options) => {
      confirm = options.onConfirm;
    };
    await renderHook().disableAll(["model-a"], requestConfirm);
    queue(response({ error: "batch denied" }, false));
    expect(await confirm()).toBe(false);
    expect(notifyError).toHaveBeenCalledWith("batch denied");
  });

  it("checks test response status even if body says ok", async () => {
    queue(response({ ok: true, error: "test blocked" }, false));
    expect(await renderHook().testModel("model-a")).toBe(false);
    expect(renderHook().testResults["model-a"]).toBe("error");
    expect(notifyError).toHaveBeenCalledWith("test blocked");
  });
});
