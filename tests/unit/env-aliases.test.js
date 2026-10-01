// YAN-326: user-settable TOKENHOP_* env vars accept their legacy spelling.
// Legacy fixtures first; the brand module's readEnv owns precedence and warn-once
// (tests/unit/brand.test.js), so these only prove each call site goes through it.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const BRAND_CJS = require.resolve("../../src/shared/brand/index.cjs");
const XAI_VIDEO = require.resolve("../../cli/src/cli/commands/xaiVideo.js");
// xaiVideo prefers the copy the CLI build packs into cli/src/shared/ when it exists.
const PACKED_BRAND_CJS = join(dirname(XAI_VIDEO), "..", "..", "shared", "brand", "index.cjs");
const NEXT_CONFIG = pathToFileURL(require.resolve("../../next.config.mjs")).href;
const { LEGACY } = require(BRAND_CJS);

// Each var's legacy spelling as it shipped (handbook §9 inventory).
const BODY_SIZE_LEGACY = `${LEGACY.envPrefixes[0]}PROXY_CLIENT_MAX_BODY_SIZE`;
const API_KEY_LEGACY = `${LEGACY.envPrefixes[1]}API_KEY`;
const VARS = [
  "TOKENHOP_PROXY_CLIENT_MAX_BODY_SIZE",
  BODY_SIZE_LEGACY,
  "TOKENHOP_API_KEY",
  API_KEY_LEGACY,
];
const savedBrand = process.env.NEXT_PUBLIC_BRAND;

beforeEach(() => {
  for (const name of VARS) delete process.env[name];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const name of VARS) delete process.env[name];
  if (savedBrand === undefined) delete process.env.NEXT_PUBLIC_BRAND;
  else process.env.NEXT_PUBLIC_BRAND = savedBrand;
  vi.restoreAllMocks();
});

let configLoads = 0;
// next.config.mjs reads the env at import; a query string forces a fresh evaluation.
async function bodySizeLimit() {
  const { default: config } = await import(`${NEXT_CONFIG}?load=${++configLoads}`);
  return config.experimental.proxyClientMaxBodySize;
}

describe("PROXY_CLIENT_MAX_BODY_SIZE (next.config.mjs, build time)", () => {
  it("honours the legacy name", async () => {
    process.env[BODY_SIZE_LEGACY] = "64mb";
    expect(await bodySizeLimit()).toBe("64mb");
  });

  it("honours the new name, which wins over the legacy one", async () => {
    process.env.TOKENHOP_PROXY_CLIENT_MAX_BODY_SIZE = "256mb";
    expect(await bodySizeLimit()).toBe("256mb");
    process.env[BODY_SIZE_LEGACY] = "64mb";
    expect(await bodySizeLimit()).toBe("256mb");
  });

  it("defaults to 128mb", async () => {
    expect(await bodySizeLimit()).toBe("128mb");
  });
});

// Fresh brand + command modules so the active brand and warn-once memory reset.
function loadXaiVideo(brand) {
  if (brand === undefined) delete process.env.NEXT_PUBLIC_BRAND;
  else process.env.NEXT_PUBLIC_BRAND = brand;
  for (const file of [BRAND_CJS, PACKED_BRAND_CJS, XAI_VIDEO]) {
    if (existsSync(file)) delete require.cache[file];
  }
  return require(XAI_VIDEO);
}

describe("API_KEY (cli xai video)", () => {
  it("honours the legacy name with one warning under the tokenhop brand", () => {
    process.env[API_KEY_LEGACY] = "legacy-key";
    const warn = vi.mocked(console.warn);
    const { parseArgs } = loadXaiVideo("tokenhop");
    expect(parseArgs([]).apiKey).toBe("legacy-key");
    expect(parseArgs([]).apiKey).toBe("legacy-key");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(`"${API_KEY_LEGACY}" → use "TOKENHOP_API_KEY"`);
  });

  it("honours the legacy name silently under the default brand", () => {
    process.env[API_KEY_LEGACY] = "legacy-key";
    const warn = vi.mocked(console.warn);
    expect(loadXaiVideo().parseArgs([]).apiKey).toBe("legacy-key");
    expect(warn).not.toHaveBeenCalled();
  });

  it("prefers the new name when both are set", () => {
    process.env[API_KEY_LEGACY] = "legacy-key";
    process.env.TOKENHOP_API_KEY = "new-key";
    expect(loadXaiVideo("tokenhop").parseArgs([]).apiKey).toBe("new-key");
  });

  it("is null when neither is set", () => {
    expect(loadXaiVideo().parseArgs([]).apiKey).toBeNull();
  });
});
