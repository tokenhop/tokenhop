// YAN-334: the tray picks its icon per brand and platform — macOS gets the
// mono template glyph for tokenhop, Windows the .ico, others the .png.
import { createRequire } from "node:module";
import { beforeEach, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const TRAY = require.resolve("../../cli/src/cli/tray/tray.js");
const BRAND_CJS = require.resolve("../../src/shared/brand/index.cjs");
const { BRAND_IDS } = require(BRAND_CJS);

const ORIGINAL_PLATFORM = process.platform;

function loadTray(brandId, platform) {
  process.env.NEXT_PUBLIC_BRAND = brandId;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  delete require.cache[TRAY];
  delete require.cache[BRAND_CJS];
  return require(TRAY);
}

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_BRAND;
  Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
  delete require.cache[TRAY];
  delete require.cache[BRAND_CJS];
});

it.each(BRAND_IDS)("resolves the tray icon per platform (%s)", (brandId) => {
  const isTokenhop = brandId === BRAND_IDS[1];
  const name = isTokenhop ? "icon-tokenhop" : "icon";
  const expectFile = {
    darwin: `${name}${isTokenhop ? "-template" : ""}.png`,
    win32: `${name}.ico`,
    linux: `${name}.png`,
  };
  for (const platform of ["darwin", "win32", "linux"]) {
    const { trayIconFile } = loadTray(brandId, platform);
    expect(trayIconFile(), `${brandId} on ${platform}`).toBe(expectFile[platform]);
  }
});
