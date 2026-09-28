/**
 * Signal design-token contrast gate (YAN-275).
 *
 * Parses the Signal custom properties for `:root` (light) and `.dark` from
 * `src/app/globals.css` and asserts the WCAG 2.2 AA pairs the design system
 * requires (see `docs/redesign/design-system.md` §2):
 * - text/muted/subtle on bg/panel/raised ≥ 4.5
 * - coral-ink, lime-ink, sky, ok, warn, err as text on panel ≥ 4.5
 * - on-lime on lime ≥ 4.5 (both themes)
 * - toggle track vs knob ≥ 3 (both themes; the pair the spec requires at 3:1)
 * - line vs panel ≥ 1.1 (approved 1px hairline is ~1.3:1; 3:1 would abandon the token)
 *
 * Provider monogram contrast is asserted in signal-display-primitives.test.js.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compositeOver, contrastRatio } from "../../src/shared/utils/contrast.js";

const here = dirname(fileURLToPath(import.meta.url));
// tests/unit/signal-contrast.test.js -> repo root -> src/app/globals.css
const repoRoot = resolve(here, "..", "..");
const css = readFileSync(resolve(repoRoot, "src/app/globals.css"), "utf8");

/** Extract `--signal-*` custom properties from every matching top-level block. */
function signalProps(selector) {
  const props = {};
  for (const block of css.matchAll(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`, "gm"))) {
    for (const [, name, value] of block[1].matchAll(/(--signal-[\w-]+)\s*:\s*([^;]+);/g)) {
      props[name] = value.trim();
    }
  }
  if (Object.keys(props).length === 0) {
    throw new Error(`signal-contrast: no ${selector} block in globals.css`);
  }
  return props;
}

const light = signalProps(":root");

const dark = signalProps(String.raw`\.dark`);

const TEXT_MIN = 4.5;
const UI_MIN = 3;

describe("signal token contrast", () => {
  for (const [name, props] of [
    ["light", light],
    ["dark", dark],
  ]) {
    describe(name, () => {
      it("parses all required signal roles", () => {
        for (const role of [
          "bg",
          "panel",
          "raised",
          "line",
          "text",
          "muted",
          "subtle",
          "coral",
          "coral-ink",
          "coral-bg",
          "lime",
          "lime-ink",
          "lime-bg",
          "on-lime",
          "sky",
          "sky-bg",
          "ok",
          "ok-bg",
          "warn",
          "warn-bg",
          "err",
          "err-bg",
          "toggle-on",
          "toggle-knob-on",
        ]) {
          expect(props[`--signal-${role}`], `${name} --signal-${role}`).toBeTruthy();
        }
      });

      it("text/muted/subtle on bg/panel/raised >= 4.5", () => {
        for (const fg of ["text", "muted", "subtle"]) {
          for (const surface of ["bg", "panel", "raised"]) {
            const ratio = contrastRatio(props[`--signal-${fg}`], props[`--signal-${surface}`]);
            expect(
              ratio,
              `${name} ${fg} on ${surface} = ${ratio.toFixed(2)}`,
            ).toBeGreaterThanOrEqual(TEXT_MIN);
          }
        }
      });

      it("accent/status ink on panel >= 4.5", () => {
        for (const fg of ["coral-ink", "lime-ink", "sky", "ok", "warn", "err"]) {
          const ratio = contrastRatio(props[`--signal-${fg}`], props["--signal-panel"]);
          expect(ratio, `${name} ${fg} on panel = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
            TEXT_MIN,
          );
        }
      });

      it("on-lime on lime >= 4.5", () => {
        const ratio = contrastRatio(props["--signal-on-lime"], props["--signal-lime"]);
        expect(ratio, `${name} on-lime on lime = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
          TEXT_MIN,
        );
      });

      it("accent text on its *-bg tint (over panel) >= 4.5", () => {
        for (const accent of ["coral", "lime", "sky", "ok", "warn", "err"]) {
          const bg = compositeOver(props[`--signal-${accent}-bg`], props["--signal-panel"]);
          // Pills pair tint bgs with the *-ink role (light coral/lime swap in their
          // darker ink; dark accents use the same accent as ink).
          const fg = props[`--signal-${accent}-ink`] ?? props[`--signal-${accent}`];
          const ratio = contrastRatio(fg, bg);
          expect(ratio, `${name} ${accent} on tint = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
            TEXT_MIN,
          );
        }
      });

      it("on-coral glyphs (checkbox check) on coral >= 3", () => {
        const ratio = contrastRatio(props["--signal-on-coral"], props["--signal-coral"]);
        expect(ratio, `${name} on-coral on coral = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
          UI_MIN,
        );
      });

      it("toggle track vs knob >= 3", () => {
        const ratio = contrastRatio(props["--signal-toggle-on"], props["--signal-toggle-knob-on"]);
        expect(ratio, `${name} toggle = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(UI_MIN);
      });

      it("line vs panel is a visible hairline", () => {
        const ratio = contrastRatio(props["--signal-line"], props["--signal-panel"]);
        expect(ratio, `${name} line vs panel = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(1.1);
      });

      it("terminal surface differs from panel", () => {
        expect(light["--signal-terminal-bg"]).not.toBe(props["--signal-panel"]);
      });
    });
  }

  describe("terminal (theme-independent, dark in both themes)", () => {
    it("is declared once, outside the theme-scoped blocks", () => {
      expect(light["--signal-terminal-bg"]).toBeTruthy();
      expect(dark["--signal-terminal-bg"]).toBeUndefined();
      expect(dark["--signal-terminal-text"]).toBeUndefined();
    });

    it("text, timestamp and level colors on the terminal surface >= 4.5", () => {
      const bg = light["--signal-terminal-bg"];
      for (const role of ["text", "time", "log", "info", "warn", "error", "debug"]) {
        const fg = light[`--signal-terminal-${role}`];
        expect(fg, `--signal-terminal-${role}`).toBeTruthy();
        const ratio = contrastRatio(fg, bg);
        expect(ratio, `terminal ${role} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(TEXT_MIN);
      }
    });
  });

  // Provider monogram contrast (white on every brand tile) lives in
  // signal-display-primitives.test.js next to the brand map (YAN-277).
});

describe("tailwind @theme utility contract", () => {
  const themeBlock = css.match(/@theme inline \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const declared = new Set([...themeBlock.matchAll(/--color-([\w-]+)\s*:/g)].map((m) => m[1]));
  const src = resolve(repoRoot, "src");
  const source = readdirSync(src, { recursive: true })
    .filter((file) => /\.[jt]sx?$/.test(file))
    .map((file) => readFileSync(resolve(src, file), "utf8"))
    .join("\n");

  it("exposes Signal semantic roles and shadows without legacy aliases", () => {
    for (const role of [
      "bg",
      "panel",
      "raised",
      "line",
      "text",
      "muted",
      "subtle",
      "coral",
      "coral-ink",
      "coral-bg",
      "on-coral",
      "lime",
      "lime-ink",
      "lime-bg",
      "on-lime",
      "sky",
      "sky-bg",
      "ok",
      "ok-bg",
      "warn",
      "warn-bg",
      "err",
      "err-bg",
      "scrim",
      "toggle-on",
      "toggle-knob-on",
      "terminal-bg",
    ]) {
      expect(declared.has(role), `missing --color-${role}`).toBe(true);
    }
    expect(themeBlock).toMatch(/--shadow-card:\s*var\(--signal-shadow-card\)/);
    expect(themeBlock).toMatch(/--shadow-focus:\s*var\(--signal-focus-ring\)/);
    expect(css).not.toMatch(
      /--color-(?:primary(?:-fill|-hover)?|brand-\d+|bg-(?:alt|subtle|hover|light|dark)|surface(?:-[\w-]+)?|sidebar(?:-[\w-]+)?|border(?:-subtle|-light|-dark)?|text-(?:main|primary|muted|subtle)(?:-light|-dark)?|accent|danger|success|warning|info)\s*:/,
    );
    expect(css).not.toMatch(/--(?:radius-brand(?:-lg)?|shadow-(?:soft|warm|elev|elevated))\s*:/);
  });

  it("source uses Signal utilities, not legacy aliases or bg-background", () => {
    const legacyUtility =
      /\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|accent|caret|decoration|placeholder|selection)-(?:primary(?:-hover|-fill)?|brand-\d+|bg-(?:alt|subtle|hover|light|dark)|surface(?:-[\w-]+)?|sidebar(?:-[\w-]+)?|border-subtle|text-(?:main|primary|muted|subtle)(?:-light|-dark)?|accent|danger|success|warning|info)(?![\w-])|\b(?:rounded-brand(?:-lg)?|shadow-(?:soft|warm|elev|elevated))(?![\w-])/g;
    const offenders = [...new Set(source.match(legacyUtility) ?? [])];
    expect(offenders, `legacy utilities in: ${offenders.join(", ")}`).toEqual([]);
    expect(source).not.toMatch(
      /\b(?:bg|text|border|ring|divide|from|via|to|fill|stroke)-(?:background|error|success|surface|sidebar|primary(?:-hover|-fill)?|brand-\d+)(?![\w-])/,
    );
  });

  it("every Signal color utility in src exists in @theme inline", () => {
    const signalRoles = [...declared].sort((a, b) => b.length - a.length).join("|");
    const utilities = new RegExp(
      `\\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|accent|caret|decoration|placeholder|selection)-(${signalRoles})(?![\\w-])`,
      "g",
    );
    const used = [...source.matchAll(utilities)].map((match) => match[1]);
    expect(used.length, "Signal utilities must be scanned from src").toBeGreaterThan(0);
    expect([...new Set(used.filter((role) => !declared.has(role)))]).toEqual([]);
  });
});
