//Fails when scripts/gen-provider-display.mjs output drifts behind the registry.
import { describe, expect, it } from "vitest";
import { buildProviderDisplay } from "../../scripts/gen-provider-display.mjs";
import {
  PROVIDER_ALIASES,
  PROVIDER_DISPLAY,
  PROVIDER_UI_ALIASES,
} from "../src/shared/constants/providerDisplay.generated.js";

describe("provider display snapshot", () => {
  it("matches the registry", async () => {
    const { default: registry } = await import("../../open-sse/providers/registry/index.js");
    const expected = buildProviderDisplay(registry);
    expect(PROVIDER_DISPLAY).toEqual(expected.providers);
    expect(PROVIDER_ALIASES).toEqual(expected.aliases);
    expect(PROVIDER_UI_ALIASES).toEqual(expected.uiAliases);
  });
});
