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
const setFields = vi.fn();
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
      setFields,
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
const render = (endpointContext) => {
  index = 0;
  return useSetupSettings({ toolId: "cline", apiKeys, defaults: {}, endpointContext });
};

beforeEach(() => {
  slots = [];
  saved = {};
  setField.mockClear();
  setFields.mockClear();
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
    expect(setFields).not.toHaveBeenCalled();
    expect(render().endpoint).toBe("http://host/v1");

    render().pickerProps.onChange("https://custom/v1", { id: "__custom__" });
    expect(setFields).toHaveBeenCalledWith({
      endpoint: "https://custom/v1",
      endpointId: "__custom__",
    });
  });

  it("resolves a saved option id to its current url", () => {
    saved = { endpoint: "https://old/v1", endpointId: "tunnel" };
    const ctx = { tunnelEnabled: true, tunnelPublicUrl: "https://new" };
    const hook = render(ctx);
    expect(hook.endpoint).toBe("https://new/v1");
    expect(hook.pickerProps).toMatchObject({ ...ctx, savedUrl: "https://new/v1" });
  });
});

describe("buildHermesConfig", () => {
  it("keeps a quote or newline in a saved model inside the YAML string", async () => {
    const { buildHermesConfig, MODEL_BLOCK_RE } = await import(
      "../../src/lib/cliToolConfigs/hermes.js"
    );
    const [yaml] = buildHermesConfig({
      baseUrl: "http://127.0.0.1:20128",
      model: 'x"\nevil: 1',
      existingYaml: "other: keep\n",
    });
    expect(yaml.value).not.toMatch(/^evil:/m);
    expect(yaml.value).toContain('default: "x\\"\\nevil: 1"');
    expect(yaml.value.match(MODEL_BLOCK_RE)[0]).toContain("base_url:");
  });
});
