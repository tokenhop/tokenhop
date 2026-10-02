// YAN-334: the brand module selects every logo asset (web, PWA, favicon,
// tray), and BrandMark/BrandLockup render for both brands. Legacy names come
// from the brand module, so this file contains no legacy brand literals.
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRequire } from "node:module";
import { loadModule, restoreBrand } from "../helpers/cliToolsBrand.js";

const require = createRequire(import.meta.url);
const BRAND_CJS = require.resolve("../../src/shared/brand/index.cjs");
const { BRAND_IDS, BRAND, LEGACY } = require(BRAND_CJS);

// The brand module resolves at load time, so require a fresh copy per brand
// (loadModule is only used for component imports, which alias "@/").
function loadBrand(brandId) {
  process.env.NEXT_PUBLIC_BRAND = brandId;
  delete require.cache[BRAND_CJS];
  vi.resetModules();
  return require(BRAND_CJS);
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
// Every brand asset URL maps to a file under public/.
const publicFile = (urlPath) => path.join(REPO_ROOT, "public", urlPath.replace(/^\//, ""));
const trayFile = (name) => path.join(REPO_ROOT, "cli/src/cli/tray", name);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  restoreBrand();
});

describe("brand asset selection", () => {
  it.each(BRAND_IDS)("resolves every declared asset for %s", async (brandId) => {
    const { ACTIVE } = loadBrand(brandId);
    expect(ACTIVE.wordmark).toBe(brandId === BRAND_IDS[1] ? "tokenhop" : "router");
    expect(ACTIVE.faviconIco).toBeTruthy();
    for (const urlPath of [
      ACTIVE.favicon,
      ACTIVE.faviconIco,
      ACTIVE.appIcon192,
      ACTIVE.appIcon512,
    ]) {
      expect(urlPath).toMatch(/^\//);
      expect(fs.existsSync(publicFile(urlPath)), urlPath).toBe(true);
    }
    expect(fs.existsSync(trayFile(`${ACTIVE.trayIconName}.png`))).toBe(true);
    expect(fs.existsSync(trayFile(`${ACTIVE.trayIconName}.ico`))).toBe(true);
    expect(ACTIVE.trayIconTemplate).toBe(brandId === BRAND_IDS[1]);
    if (ACTIVE.trayIconTemplate) {
      expect(fs.existsSync(trayFile(`${ACTIVE.trayIconName}-template.png`))).toBe(true);
    }
  });

  it("keeps the legacy web assets at their current paths", async () => {
    const { ACTIVE } = loadBrand(BRAND_IDS[0]);
    expect(ACTIVE.favicon).toBe(LEGACY.favicon);
    expect(ACTIVE.favicon).toBe("/favicon.svg");
    expect(ACTIVE.appIcon192).toBe("/icons/icon-192.svg");
    expect(ACTIVE.appIcon512).toBe("/icons/icon-512.svg");
    expect(ACTIVE.trayIconName).toBe("icon");
  });

  it("selects the new tokenhop assets", async () => {
    const { ACTIVE } = loadBrand(BRAND_IDS[1]);
    expect(ACTIVE).toStrictEqual(BRAND);
    expect(ACTIVE.favicon).toBe("/brand/favicon.svg");
    expect(ACTIVE.appIcon192).toBe("/brand/icons/icon-192.svg");
    expect(ACTIVE.trayIconName).toBe("icon-tokenhop");
  });

  it("has the brand sources of truth and the README hero in the repo", () => {
    for (const rel of [
      "public/brand/mark.svg",
      "public/brand/lockup.svg",
      "public/brand/mono.svg",
      "images/tokenhop.png",
    ]) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), rel).toBe(true);
    }
  });
});

describe("brand components", () => {
  const render = async (brandId, specifier, props = {}) => {
    const { default: Component } = await loadModule(brandId, specifier);
    return renderToStaticMarkup(createElement(Component, props));
  };

  it.each(BRAND_IDS)("BrandMark renders with the brand's accessible name (%s)", async (brandId) => {
    const markup = await render(brandId, "@/shared/components/BrandMark.js", { size: 36 });
    expect(markup).toContain(
      `aria-label="${brandId === BRAND_IDS[1] ? "tokenhop" : LEGACY.names[0]}"`,
    );
  });

  it("renders the legacy tile at size 36 exactly like the old sidebar markup", async () => {
    const markup = await render(BRAND_IDS[0], "@/shared/components/BrandMark.js", { size: 36 });
    expect(markup).toContain("-rotate-[8deg]");
    expect(markup).toContain("bg-coral");
    expect(markup).toContain(">9</span>");
    // No snapshot here: the render embeds a legacy name, which brand-guard
    // forbids in new files.
  });

  it("renders the tokenhop mark as inline svg", async () => {
    const markup = await render(BRAND_IDS[1], "@/shared/components/BrandMark.js", { size: 36 });
    expect(markup).toMatch(/^<svg /);
    expect(markup).toContain('fill="var(--signal-coral)"');
    expect(markup).toContain('d="M25 11V41.5C25 48.5 28.8 52 35.5 52H40"');
    expect(markup).toMatchSnapshot("brandmark-tokenhop");
  });

  it.each(BRAND_IDS)("BrandLockup pairs the mark with the wordmark (%s)", async (brandId) => {
    const markup = await render(brandId, "@/shared/components/BrandLockup.js", { size: 36 });
    const expected = brandId === BRAND_IDS[1] ? "tokenhop" : "router";
    expect(markup).toContain(`>${expected}</span>`);
    expect(markup).toContain('aria-hidden="true"');
  });
});

describe("brand mark inside an SVG (routes-map hub)", () => {
  const renderSvg = async (brandId) => {
    const { default: BrandMark } = await loadModule(brandId, "@/shared/components/BrandMark.js");
    return renderToStaticMarkup(
      createElement("svg", null, createElement(BrandMark, { x: 10, y: 20, size: 96 })),
    );
  };

  it("draws the legacy tile and wordmark at the old hub geometry", async () => {
    const markup = await renderSvg(BRAND_IDS[0]);
    expect(markup).toContain('<rect x="10" y="20" width="96" height="96" rx="28"');
    expect(markup).toContain(">9</text>");
    expect(markup).toContain(`>${LEGACY.wordmark}</text>`);
  });

  it("draws the tokenhop mark as a nested svg", async () => {
    const markup = await renderSvg(BRAND_IDS[1]);
    expect(markup).toMatch(/<svg><svg [^>]*x="10" y="20" width="96" height="96"/);
    expect(markup).toContain('d="M25 11V41.5C25 48.5 28.8 52 35.5 52H40"');
    expect(markup).not.toContain(">9</text>");
  });
});

// brand-guard can't see a logo split into a "9" tile and a wordmark element, so
// this keeps every logo going through BrandMark/BrandLockup.
describe("no hardcoded legacy logo outside the brand components", () => {
  const BRAND_COMPONENTS = new Set(["BrandMark.js", "BrandLockup.js"]);
  const LEGACY_LOGO = [
    /-rotate-\[8deg\][^"]*bg-coral|bg-coral[^"]*-rotate-\[8deg\]/, // tilted coral tile
    new RegExp(`>\\s*${LEGACY.wordmark}\\s*<`), // standalone wordmark text node
  ];

  const files = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return files(full);
      return entry.name.endsWith(".js") && !BRAND_COMPONENTS.has(entry.name) ? [full] : [];
    });

  it("finds no legacy tile or wordmark markup in src/", () => {
    const hits = files(path.join(REPO_ROOT, "src")).filter((file) => {
      const code = fs.readFileSync(file, "utf8");
      return LEGACY_LOGO.some((re) => re.test(code));
    });
    expect(hits.map((file) => path.relative(REPO_ROOT, file))).toEqual([]);
  });
});
