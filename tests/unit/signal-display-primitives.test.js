import { describe, expect, it } from "vitest";
import {
  LEGACY_PILL_VARIANTS,
  PILL_SIZES,
  PILL_VARIANTS,
  meterVariant,
  meterValue,
  pillClasses,
  resolvePillVariant,
  statusVariant,
  TABLE_HEAD_CELL,
  TABLE_HEAD_ROW,
  TERMINAL_LEVELS,
  terminalLevelClass,
} from "../../src/shared/components/displayPrimitives.js";
import { readdirSync } from "node:fs";
import {
  PROVIDER_BRANDS,
  getProviderBrand,
  resolveProviderId,
} from "../../src/shared/constants/providerBrands.js";
import {
  getProviderIconSrc,
  markProviderIconMissing,
} from "../../src/shared/utils/providerIcon.js";
import { contrastRatio } from "../../src/shared/utils/contrast.js";

describe("Signal meter", () => {
  it.each([
    [0, "err"],
    [20, "err"],
    [21, "warn"],
    [45, "warn"],
    [46, "ok"],
    [100, "ok"],
  ])("maps %i percent to %s", (value, variant) => {
    expect(meterVariant(value)).toBe(variant);
    expect(meterValue(value)).toBe(value);
  });
  it("uses dedicated unlimited and credit fills", () => {
    expect(meterVariant(0, "unlimited")).toBe("live");
    expect(meterVariant(0, "credits")).toBe("info");
  });
  it("clamps display values and rejects invalid input", () => {
    expect(meterValue(-10)).toBe(0);
    expect(meterValue(120)).toBe(100);
    expect(() => meterVariant(Number.NaN)).toThrow();
    expect(() => meterVariant(30, "unknown")).toThrow();
  });
});

describe("Signal status", () => {
  it.each([
    ["connected", "ok"],
    ["healthy", "ok"],
    ["active", "ok"],
    ["cooldown", "warn"],
    ["warning", "warn"],
    ["low", "warn"],
    ["error", "err"],
    ["empty", "err"],
    ["oauth", "info"],
    ["api-key", "brand"],
    ["live", "live"],
    ["disabled", "neutral"],
  ])("maps %s to %s", (status, variant) => {
    expect(statusVariant(status)).toBe(variant);
  });
  it("rejects unknown status", () => expect(() => statusVariant("unknown")).toThrow());
});

describe("provider monogram colors", () => {
  it("keeps white text >= 4.5:1 for every registry brand", () => {
    expect(Object.keys(PROVIDER_BRANDS).length).toBeGreaterThan(40);
    for (const [id, brand] of Object.entries(PROVIDER_BRANDS)) {
      expect(brand.monogram, id).toBeTruthy();
      expect(contrastRatio("#ffffff", brand.color), id).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("provider logo resolution", () => {
  it("resolves ids, aliases and alias/model strings to the registry id", () => {
    expect(resolveProviderId("claude")).toBe("claude");
    expect(resolveProviderId("cc")).toBe("claude");
    expect(resolveProviderId("cc/claude-sonnet-4")).toBe("claude");
    expect(resolveProviderId("mc/muse-spark")).toBe("meta-code");
    // Same precedence as the router: registry id beats a colliding alias, aliases[] resolve.
    expect(resolveProviderId("mmf")).toBe("mmf");
    expect(resolveProviderId("kimi-coding/k2")).toBe("kimi");
    expect(resolveProviderId("CC")).toBe("claude");
    expect(resolveProviderId("ag/gemini")).toBe("antigravity");
    expect(resolveProviderId("bb/model")).toBe("blackbox");
  });
  it("compatible nodes inherit family brand and logo", () => {
    expect(getProviderBrand("openai-compatible-abc123").monogram).toBe("OC");
    expect(getProviderIconSrc("openai-compatible-abc123")).toBe("/providers/oai-cc.webp");
    expect(getProviderIconSrc("anthropic-compatible-x")).toBe("/providers/anthropic-m.webp");
  });
  it("caches missing compatible-family logo across generated node ids", () => {
    markProviderIconMissing("openai-compatible-missing-test");
    expect(getProviderIconSrc("openai-compatible-other-test")).toBeNull();
  });
  it("every registry brand logo points at a shipped file", async () => {
    const { default: registry } = await import("../../open-sse/providers/registry/index.js");
    const shipped = new Set(readdirSync(new URL("../../public/providers", import.meta.url)));
    expect(getProviderIconSrc("meta-code")).toBe("/providers/meta-code.svg");
    for (const entry of registry.filter((provider) => provider.display)) {
      expect(shipped.has(getProviderIconSrc(entry.id).split("/").pop()), entry.id).toBe(true);
    }
  });
  it("every PNG logo has a regenerated WebP twin", async () => {
    const dir = new URL("../../public/providers", import.meta.url);
    const shipped = readdirSync(dir);
    const pngs = shipped.filter((name) => name.endsWith(".png"));
    expect(pngs.length).toBeGreaterThan(0);
    for (const name of pngs) {
      expect(shipped, name).toContain(name.replace(/\.png$/, ".webp"));
    }
  });
});

describe("pill variant normalization", () => {
  it.each(Object.entries(LEGACY_PILL_VARIANTS))("maps legacy %s to %s", (legacy, signal) => {
    expect(resolvePillVariant(legacy)).toBe(signal);
    expect(pillClasses(legacy, "md")).toBe(pillClasses(signal, "md"));
  });

  it("resolves status words the same way as statusVariant", () => {
    for (const status of ["connected", "cooldown", "empty", "oauth", "api-key", "disabled"]) {
      expect(resolvePillVariant(status)).toBe(statusVariant(status));
      expect(pillClasses(status)).toContain(PILL_VARIANTS[statusVariant(status)]);
    }
  });

  it("keeps legacy xs at the compact pill height", () => {
    expect(PILL_SIZES.xs).toBe(PILL_SIZES.sm);
    expect(pillClasses("success", "xs")).toBe(`${PILL_VARIANTS.ok} ${PILL_SIZES.sm}`);
  });

  it("rejects unknown variants and sizes", () => {
    expect(() => resolvePillVariant("enterprise")).toThrow('unknown variant "enterprise"');
    expect(() => pillClasses("ok", "xl")).toThrow('unknown size "xl"');
  });
});

describe("terminal level classes", () => {
  it("maps every level to a fixed-light .signal-terminal-* class", () => {
    for (const level of ["LOG", "INFO", "WARN", "ERROR", "DEBUG"]) {
      expect(terminalLevelClass(level)).toBe(`signal-terminal-${level.toLowerCase()}`);
    }
    expect(Object.keys(TERMINAL_LEVELS)).toHaveLength(5);
  });
  it("rejects unknown levels", () => expect(() => terminalLevelClass("TRACE")).toThrow());
});

describe("table header", () => {
  it("stays sentence case with no background tint", () => {
    expect(TABLE_HEAD_ROW).toBe("border-b border-line");
    for (const classes of [TABLE_HEAD_ROW, TABLE_HEAD_CELL]) {
      expect(classes).not.toContain("uppercase");
      expect(classes).not.toContain("bg-");
    }
    expect(TABLE_HEAD_CELL).toContain("text-muted");
    expect(TABLE_HEAD_CELL).toContain("font-semibold");
  });
});
