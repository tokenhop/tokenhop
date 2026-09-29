import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  EDGE_STATE_LABEL,
  edgeLabel,
  edgeStyle,
  fallbackText,
  idleCaption,
  isIdle,
  capProviders,
  mergeRoutes,
  overlayLiveSignal,
} from "@/shared/utils/routesMap.js";

const NOW = new Date("2026-09-29T12:00:00Z").getTime();
const ago = (ms) => new Date(NOW - ms).toISOString();

function windowModel(overrides = {}) {
  return {
    clients: [],
    providers: [],
    edges: [],
    fallbacks: [],
    ...overrides,
  };
}

describe("edgeStyle", () => {
  it("maps every edge state to a Signal token", () => {
    expect(edgeStyle("flowing")).toMatchObject({
      stroke: "var(--signal-lime-ink)",
      animated: true,
    });
    expect(edgeStyle("cooling").stroke).toBe("var(--signal-warn)");
    expect(edgeStyle("cooling").animated).toBe(false);
    expect(edgeStyle("idle").stroke).toBe("var(--signal-line)");
    expect(edgeStyle("error").stroke).toBe("var(--signal-err)");
  });

  it("falls back to the idle style for unknown states", () => {
    expect(edgeStyle("nonsense").stroke).toBe("var(--signal-line)");
  });

  it("uses dashed strokes only for flowing and cooling", () => {
    expect(edgeStyle("flowing").dash).toBeTruthy();
    expect(edgeStyle("cooling").dash).toBeTruthy();
    expect(edgeStyle("idle").dash).toBeNull();
    expect(edgeStyle("error").dash).toBeNull();
  });
});

describe("edgeLabel", () => {
  it("describes a live client edge with state, count and last activity", () => {
    expect(
      edgeLabel(
        {
          from: "Claude Code",
          to: "claude",
          state: "flowing",
          count: 12,
          lastAt: ago(30_000),
        },
        NOW,
      ),
    ).toBe("Claude Code to claude: Flowing, 12 requests, last 30s.");
  });

  it("omits the client half for idle provider edges", () => {
    expect(edgeLabel({ from: null, to: "openrouter", state: "idle", count: 0 })).toBe(
      "openrouter: Idle.",
    );
  });
});

describe("fallbackText", () => {
  it("explains a fallback with its cooldown", () => {
    expect(
      fallbackText(
        {
          fromName: "Gemini CLI",
          toName: "OpenRouter",
          cooldownUntil: new Date(NOW + 120_000).toISOString(),
        },
        NOW,
      ),
    ).toBe(
      "Gemini CLI hit a rate limit. Its traffic is falling back to OpenRouter (resets in 2m).",
    );
  });

  it("keeps a plain tail when the cooldown is unknown", () => {
    expect(fallbackText({ fromName: "A", toName: "B", cooldownUntil: null }, NOW)).toBe(
      "A hit a rate limit. Its traffic is falling back to B while it cools down.",
    );
  });
});

describe("mergeRoutes", () => {
  it("adds providers missing from the window as idle nodes with idle edges", () => {
    const merged = mergeRoutes(
      windowModel({
        providers: [{ id: "claude", name: "Claude", state: "flowing", count: 3 }],
        edges: [
          { from: "Claude Code", to: "claude", count: 3, lastAt: ago(1000), state: "flowing" },
        ],
      }),
      [{ provider: "openrouter", name: "OpenRouter" }],
    );
    expect(merged.providers.map((p) => [p.id, p.state])).toEqual([
      ["claude", "flowing"],
      ["openrouter", "idle"],
    ]);
    expect(merged.edges).toHaveLength(2);
    expect(merged.edges[1]).toMatchObject({ from: null, to: "openrouter", state: "idle" });
  });

  it("does not duplicate providers already in the window", () => {
    const merged = mergeRoutes(
      windowModel({ providers: [{ id: "claude", name: "Claude", state: "idle", count: 0 }] }),
      [
        { provider: "claude", name: "Claude", nodeName: "Work account" },
        { provider: "kimi", name: "Kimi" },
      ],
    );
    expect(merged.providers.map((p) => p.id)).toEqual(["claude", "kimi"]);
    expect(merged.providers.find((p) => p.id === "claude").name).toBe("Claude");
    expect(merged.edges.map((e) => e.to)).toEqual(["claude", "kimi"]);
  });

  it("synthesizes a warning edge for a cooling provider with no request", () => {
    const merged = mergeRoutes(
      windowModel({ providers: [{ id: "kimi", name: "Kimi", state: "cooling", count: 0 }] }),
    );
    expect(merged.edges).toEqual([
      { from: null, to: "kimi", count: 0, lastAt: null, state: "cooling" },
    ]);
  });

  it("matches provider ids case-insensitively and prefers the node name", () => {
    const merged = mergeRoutes(windowModel(), [{ provider: "GLM", nodeName: "Zhipu" }]);
    expect(merged.providers).toHaveLength(1);
    expect(merged.providers[0].name).toBe("Zhipu");
  });

  it("tolerates a null window model", () => {
    const merged = mergeRoutes(null, [{ provider: "kimi", name: "Kimi" }]);
    expect(merged.providers).toHaveLength(1);
    expect(merged.edges).toHaveLength(1);
  });
});

describe("overlayLiveSignal", () => {
  const base = windowModel({
    providers: [
      { id: "claude", name: "Claude", state: "idle", count: 0 },
      { id: "kimi", name: "Kimi", state: "cooling", count: 0 },
    ],
    edges: [{ from: null, to: "claude", state: "idle", count: 0 }],
  });

  it("promotes idle providers with in-flight requests to flowing", () => {
    const overlaid = overlayLiveSignal(base, {
      activeRequests: [{ provider: "Claude", count: 2 }],
    });
    expect(overlaid.providers.find((p) => p.id === "claude").state).toBe("flowing");
    expect(overlaid.edges[0].state).toBe("flowing");
  });

  it("marks the error provider and keeps cooling despite in-flight retries", () => {
    const overlaid = overlayLiveSignal(base, {
      activeRequests: [
        { provider: "claude", count: 1 },
        { provider: "kimi", count: 1 },
      ],
      errorProvider: "claude",
    });
    expect(overlaid.providers.find((p) => p.id === "claude").state).toBe("error");
    expect(overlaid.providers.find((p) => p.id === "kimi").state).toBe("cooling");
  });

  it("ignores providers the model does not know", () => {
    const overlaid = overlayLiveSignal(base, { activeRequests: [{ provider: "zzz", count: 1 }] });
    expect(overlaid.providers).toHaveLength(2);
  });

  it("matches edge targets case-insensitively", () => {
    const model = windowModel({
      providers: [{ id: "Claude", name: "Claude", state: "idle", count: 0 }],
      edges: [{ from: "x", to: "claude", state: "idle", count: 0 }],
    });
    const overlaid = overlayLiveSignal(model, {
      activeRequests: [{ provider: "CLAUDE", count: 1 }],
    });
    expect(overlaid.edges[0].state).toBe("flowing");
  });

  it("returns the same model object when the stream changes nothing", () => {
    const overlaid = overlayLiveSignal(base, { activeRequests: [], lastProvider: "claude" });
    expect(overlaid).toBe(base);
  });
});

describe("isIdle", () => {
  it("is idle when every provider sits idle with no client traffic", () => {
    expect(isIdle(windowModel({ providers: [{ id: "a", state: "idle" }] }))).toBe(true);
  });

  it("is not idle with flowing, cooling or error providers", () => {
    for (const state of ["flowing", "cooling", "error"]) {
      expect(isIdle(windowModel({ providers: [{ id: "a", state }] }))).toBe(false);
    }
  });

  it("is not idle with client edges even if providers look idle", () => {
    expect(
      isIdle(
        windowModel({
          providers: [{ id: "a", state: "idle" }],
          edges: [{ from: "Claude Code", to: "a", state: "idle" }],
        }),
      ),
    ).toBe(false);
  });

  it("treats an empty model as idle", () => {
    expect(isIdle(windowModel())).toBe(true);
  });
});

describe("capProviders", () => {
  const model = windowModel({
    providers: [
      { id: "busy", state: "flowing", count: 9 },
      { id: "cool", state: "cooling", count: 0 },
      { id: "idle-a", state: "idle", count: 0 },
      { id: "idle-b", state: "idle", count: 0 },
      { id: "idle-c", state: "idle", count: 0 },
    ],
    edges: [
      { from: "c1", to: "busy", state: "flowing" },
      { from: null, to: "idle-a", state: "idle" },
      { from: null, to: "idle-b", state: "idle" },
      { from: null, to: "idle-c", state: "idle" },
    ],
  });

  it("truncates only idle providers and reports the remainder", () => {
    const capped = capProviders(model, 4);
    expect(capped.providers.map((p) => p.id)).toEqual(["busy", "cool", "idle-a", "idle-b"]);
    expect(capped.hiddenProviders).toBe(1);
    expect(capped.edges.map((e) => e.to)).toEqual(["busy", "idle-a", "idle-b"]);
  });

  it("never drops a provider with traffic or a cooldown", () => {
    const capped = capProviders(model, 2);
    expect(capped.providers.map((p) => p.id)).toEqual(["busy", "cool"]);
    expect(capped.hiddenProviders).toBe(3);
  });

  it("returns the same model when everything fits", () => {
    expect(capProviders(model, 5).providers).toHaveLength(5);
    expect(capProviders(model, 5).hiddenProviders).toBe(0);
  });
});

describe("idleCaption", () => {
  it("stays empty until the last activity is known", () => {
    expect(idleCaption(undefined, "en", NOW)).toBe("");
  });

  it("stays empty when there was never a request", () => {
    expect(idleCaption(null, "en", NOW)).toBe("");
  });

  it("names the last request time", () => {
    expect(idleCaption(ago(2 * 60 * 60 * 1000), "en", NOW)).toBe(
      "Idle — last request 2 hours ago.",
    );
  });
});

describe("routes map CSS guards", async () => {
  const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");

  it("crossfades edge state changes within 400ms", () => {
    const match = css.match(/\.routes-map-edge[^{]*\{[^}]*transition:([^;]+);/);
    expect(match).toBeTruthy();
    for (const duration of match[1].matchAll(/(\d+)ms/g)) {
      expect(Number(duration[1])).toBeLessThanOrEqual(400);
    }
  });

  it("disables the crossfade under reduced motion", () => {
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{\s*\.routes-map-edge[^{]*\{\s*transition: none;/,
    );
  });

  it("shows edge labels on hover and keyboard focus", () => {
    expect(css).toMatch(/\.routes-map-edge:hover [^{]*\.routes-map-edge-label/);
    expect(css).toMatch(/\.routes-map-edge:focus-visible [^{]*\.routes-map-edge-label/);
  });

  it("removes the legacy topology flow and React Flow control CSS", () => {
    expect(css).not.toMatch(/topology-edge-flow|react-flow-controls/);
  });

  it("keeps the shared flow loop at or below 3 Hz", () => {
    expect(css).toMatch(/--animate-flow: flow 1\.1s linear infinite/);
    expect(css).not.toMatch(/steps\(\d\)/);
  });

  it("stops the request-log spinner under reduced motion", () => {
    const spin = css.indexOf(".animate-spin {\n  animation: spin");
    const guard = css.indexOf("@media (prefers-reduced-motion: reduce)", spin);
    expect(spin).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(spin);
    expect(css.slice(guard)).toMatch(
      /^@media \(prefers-reduced-motion: reduce\) \{\s*\.animate-spin \{\s*animation: none;\s*\}\s*\}/,
    );
  });

  it("keeps every edge state labelled for screen readers", () => {
    expect(EDGE_STATE_LABEL).toEqual({
      error: "Error",
      cooling: "Cooling down",
      flowing: "Flowing",
      idle: "Idle",
    });
  });
});
