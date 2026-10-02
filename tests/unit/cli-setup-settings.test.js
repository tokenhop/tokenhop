import { beforeEach, describe, expect, it, vi } from "vitest";

let slots;
let index;
vi.mock("react", () => ({
  useState(initial) {
    const slot = index++;
    slots[slot] ??= { value: initial };
    return [slots[slot].value, (v) => (slots[slot].value = v)];
  },
}));

const setField = vi.fn();
let saved;
vi.mock("../../src/app/(dashboard)/dashboard/cli-tools/hooks/useToolSettings.js", () => ({
  useToolSettings: () => [
    saved,
    setField,
    {
      loaded: true,
      status: "",
      hasSaved: false,
      differs: [],
      reset: vi.fn(),
      loadFromDisk: vi.fn(),
    },
  ],
}));

import { useSetupSettings } from "../../src/app/(dashboard)/dashboard/cli-tools/hooks/useSetupSettings.js";

const apiKeys = [
  { id: "a", key: "sk-a" },
  { id: "b", key: "sk-b" },
];
const render = () => {
  index = 0;
  return useSetupSettings({ toolId: "cline", apiKeys, defaults: {} });
};

beforeEach(() => {
  slots = [];
  saved = {};
  setField.mockClear();
});

describe("useSetupSettings", () => {
  it("saves a known key by id and keeps a typed raw key out of the DB", () => {
    render().onApiKeyChange("sk-b");
    expect(setField).toHaveBeenCalledWith("apiKeyId", "b");

    setField.mockClear();
    render().onApiKeyChange("sk-typed-secret");
    expect(setField).not.toHaveBeenCalled();
    expect(render().selectedApiKey).toBe("sk-typed-secret");
  });

  it("resolves the saved key id, falling back to the first key when it's gone", () => {
    saved = { apiKeyId: "b" };
    expect(render().selectedApiKey).toBe("sk-b");
    saved = { apiKeyId: "deleted" };
    expect(render().selectedApiKey).toBe("sk-a");
  });

  it("doesn't save the endpoint the picker picks at mount", () => {
    render().pickerProps.onChange("http://host/v1", { init: true });
    expect(setField).not.toHaveBeenCalled();
    expect(render().endpoint).toBe("http://host/v1");

    render().pickerProps.onChange("https://custom/v1");
    expect(setField).toHaveBeenCalledWith("endpoint", "https://custom/v1");
  });
});
