// Shared harness for the CLI-tool brand migration tests (YAN-331, YAN-332).
// HOME is a per-file temp dir (tests/setup), never the real one: importing this
// throws if it isn't (see isolatedHome.js).
import { vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { assertIsolatedHome, removeUnderHome } from "./isolatedHome.js";

const require = createRequire(import.meta.url);
const BRAND_CJS = require.resolve("../../src/shared/brand/index.cjs");
// Legacy names come from the brand module; they don't depend on the active brand.
export const { LEGACY } = require(BRAND_CJS);
export const OLD = LEGACY.clientConfigKeys[0];
export const OLD_NAME = LEGACY.clientConfigKeys[1];
const FIXTURES = path.join(import.meta.dirname, "../fixtures/legacy/cli-tools");
export const home = assertIsolatedHome();
const savedBrand = process.env.NEXT_PUBLIC_BRAND;

// The brand resolves at load time, so every case loads fresh modules.
export async function loadModule(brand, specifier) {
  process.env.NEXT_PUBLIC_BRAND = brand;
  delete require.cache[BRAND_CJS];
  vi.resetModules();
  return import(specifier);
}
export const load = (brand, route) => loadModule(brand, `@/app/api/cli-tools/${route}/route.js`);

export function restoreBrand() {
  if (savedBrand === undefined) delete process.env.NEXT_PUBLIC_BRAND;
  else process.env.NEXT_PUBLIC_BRAND = savedBrand;
  delete require.cache[BRAND_CJS];
}

export const fixture = (name) => fs.readFile(path.join(FIXTURES, name), "utf-8");
export const write = async (rel, content) => {
  const p = path.join(home, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
  return p;
};
export const read = (rel) => fs.readFile(path.join(home, rel), "utf-8");
export const readJson = async (rel) => JSON.parse(await read(rel));
export const exists = (rel) =>
  fs.access(path.join(home, rel)).then(
    () => true,
    () => false,
  );
export const clearHome = (dirs) => removeUnderHome(dirs, home);
export const post = (body, method = "POST") =>
  new Request("http://localhost/x", { method, body: JSON.stringify(body) });
export const json = (res) => res.json();
