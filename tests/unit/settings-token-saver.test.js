import { describe, it, expect } from "vitest";

import {
  TOKEN_SAVER_DEFAULTS,
  cavemanLevelDescription,
  coerceCavemanLevel,
  coercePonytailLevel,
  isHeadroomUrlFromEnv,
  isWenyanLocale,
  ponytailLevelDescription,
  visibleCavemanLevels,
} from "@/app/(dashboard)/dashboard/settings/sections/tokenSaverHelpers.js";
import { mergeWithDefaults } from "@/lib/db/repos/settingsRepo.js";

describe("token saver helpers", () => {
  it("defaults match the settings repo", () => {
    const merged = mergeWithDefaults({});
    for (const [key, value] of Object.entries(TOKEN_SAVER_DEFAULTS)) {
      expect(merged[key], key).toEqual(value);
    }
  });

  it("hides wenyan levels outside CJK locales", () => {
    expect(isWenyanLocale("zh-CN")).toBe(true);
    expect(isWenyanLocale("zh-TW")).toBe(true);
    expect(isWenyanLocale("en")).toBe(false);
    expect(visibleCavemanLevels("en").some((lvl) => lvl.wenyan)).toBe(false);
    expect(visibleCavemanLevels("zh-CN").some((lvl) => lvl.wenyan)).toBe(true);
  });

  it("coerces wenyan levels to ultra where unsupported", () => {
    expect(coerceCavemanLevel("en", "wenyan")).toBe("ultra");
    expect(coerceCavemanLevel("zh-CN", "wenyan")).toBe("wenyan");
    expect(coerceCavemanLevel("en", "full")).toBe("full");
    expect(coerceCavemanLevel("en", "bogus")).toBe("full");
  });

  it("describes caveman and ponytail levels, coerces ponytail", () => {
    expect(cavemanLevelDescription("lite")).toBeTruthy();
    expect(cavemanLevelDescription("bogus")).toBe("");
    expect(ponytailLevelDescription("ultra")).toBeTruthy();
    expect(ponytailLevelDescription("bogus")).toBe("");
    expect(coercePonytailLevel("lite")).toBe("lite");
    expect(coercePonytailLevel("bogus")).toBe("full");
  });

  it("reads the headroom .env override flag without guessing", () => {
    expect(isHeadroomUrlFromEnv({ headroomUrlFromEnv: true })).toBe(true);
    expect(isHeadroomUrlFromEnv({})).toBe(false);
    expect(isHeadroomUrlFromEnv(undefined)).toBe(false);
  });
});
