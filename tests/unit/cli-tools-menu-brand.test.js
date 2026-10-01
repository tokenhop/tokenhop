// YAN-332: the CLI menus read Droid/OpenClaw status written under either name.
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { LEGACY, OLD, restoreBrand } from "../helpers/cliToolsBrand.js";

const require = createRequire(import.meta.url);
const MENU = require.resolve("../../cli/src/cli/menus/cliTools.js");
const BRAND_CJS = require.resolve("../../src/shared/brand/index.cjs");

function loadMenu(brand) {
  process.env.NEXT_PUBLIC_BRAND = brand;
  delete require.cache[BRAND_CJS];
  delete require.cache[MENU];
  return require(MENU);
}
afterEach(() => {
  restoreBrand();
  delete require.cache[MENU];
});

const droid = (prefix) => ({
  customModels: [
    { id: "other-1", model: "x" },
    { id: `${prefix}0`, model: "cc/m", baseUrl: "http://h/v1" },
  ],
});
const openclaw = (key) => ({
  models: { providers: { [key]: { baseUrl: "http://h/v1", models: [{ id: "first" }] } } },
  agents: { defaults: { model: { primary: `${key}/cc/m` } } },
});

// Under each brand, the menu reads the other brand's entries too.
describe.each([
  ["9router", "custom:tokenhop-", "tokenhop"],
  ["tokenhop", LEGACY.customModelIdPrefix, OLD],
])("CLI menu status under the %s brand", (brand, prefix, key) => {
  it("droid reads the other brand's ids", () => {
    expect(loadMenu(brand).findDroidCustomModel(droid(prefix))).toMatchObject({ model: "cc/m" });
  });

  it("openclaw reads the other brand's provider", () => {
    const { provider, model } = loadMenu(brand).readOpenClawEntry(openclaw(key));
    expect(provider.baseUrl).toBe("http://h/v1");
    expect(model).toBe("cc/m");
  });
});
