import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import {
  ANTIGRAVITY_HEADERS,
  ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS,
} from "../../open-sse/config/appConstants.js";
import antigravityRegistry from "../../open-sse/providers/registry/antigravity.js";
import geminiRegistry from "../../open-sse/providers/registry/gemini.js";
import {
  ANTIGRAVITY_HUB_USER_AGENT,
  ANTIGRAVITY_HUB_VERSION,
  ANTIGRAVITY_IDE_USER_AGENT,
  ANTIGRAVITY_IDE_VERSION,
} from "../../open-sse/providers/shared.js";
import {
  applyThinking,
  stripThinkingSuffix,
} from "../../open-sse/translator/concerns/thinkingUnified.js";
import { reconcileAntigravityModels } from "../../src/lib/providerModels/googleModels.js";

const here = dirname(fileURLToPath(import.meta.url));

const ARGON_TIERS = ["high", "medium", "low"];
const ARGON_IDS = [...ARGON_TIERS.map((t) => `gemini-4-argon-${t}`), "gemini-4-argon"];

describe("Antigravity hub identity", () => {
  it("pins IDE provisioning and hub generation identities independently", () => {
    expect(ANTIGRAVITY_IDE_VERSION).toBe("2.11.0");
    expect(ANTIGRAVITY_IDE_USER_AGENT).toBe("antigravity/ide/2.11.0 darwin/arm64");
    expect(ANTIGRAVITY_HUB_VERSION).toBe("2.23.0");
    expect(ANTIGRAVITY_HUB_USER_AGENT).toBe("antigravity/hub/2.23.0 darwin/arm64");
    expect(antigravityRegistry.oauth.loadCodeAssistUserAgent).toBe(ANTIGRAVITY_IDE_USER_AGENT);
    expect(ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS["User-Agent"]).toBe(ANTIGRAVITY_IDE_USER_AGENT);
    expect(antigravityRegistry.transport.headers["User-Agent"]).toBe(ANTIGRAVITY_HUB_USER_AGENT);
    expect(ANTIGRAVITY_HEADERS["User-Agent"]).toBe(ANTIGRAVITY_HUB_USER_AGENT);
  });
});

describe("Gemini 4 Argon Antigravity support", () => {
  it("registers Argon bare + tiered models in the antigravity registry", () => {
    const agIds = antigravityRegistry.models.map((m) => m.id);
    for (const id of ARGON_IDS) {
      expect(agIds).toContain(id);
    }
  });

  it("maps tier ids to wire ids with a matching (level) preset; bare routes to medium", () => {
    for (const tier of ARGON_TIERS) {
      expect(getModelUpstreamId("ag", `gemini-4-argon-${tier}`)).toBe(
        `gemini-4-argon-${tier}(${tier})`,
      );
    }
    // Bare `gemini-4-argon` 404s upstream; the alias targets the medium wire id.
    expect(getModelUpstreamId("ag", "gemini-4-argon")).toBe("gemini-4-argon-medium");
  });

  it.each(ARGON_IDS)("resolves capabilities for %s", (id) => {
    const caps = getCapabilitiesForModel("antigravity", id);
    expect(caps.vision).toBe(true);
    expect(caps.audioInput).toBe(true);
    expect(caps.videoInput).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.search).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
    expect(getThinkingLevels("antigravity", id)).toEqual(["low", "medium", "high"]);
  });

  it("does not register Argon in the direct gemini provider registry (Antigravity scope only)", () => {
    const geminiIds = geminiRegistry.models.map((m) => m.id);
    for (const id of ARGON_IDS) {
      expect(geminiIds).not.toContain(id);
    }
  });

  it("lists friendly ids only when the live catalog exposes the wire ids", () => {
    const staticModels = antigravityRegistry.models.filter((m) => ARGON_IDS.includes(m.id));

    // Eligible account: live catalog exposes all three tier wire ids.
    const live = ARGON_TIERS.map((tier) => ({
      id: `gemini-4-argon-${tier}`,
      displayName: `Gemini 4 Argon (${tier})`,
      contextLength: 1048576,
      maxOutputTokens: 65536,
    }));
    const reconciled = reconcileAntigravityModels(live, staticModels);
    expect(reconciled.map((m) => m.id).sort()).toEqual([...ARGON_IDS].sort());
    for (const m of reconciled) {
      expect(m.contextLength).toBe(1048576);
      expect(m.maxOutputTokens).toBe(65536);
    }

    // Non-eligible account: catalog hides Argon → static aliases disappear entirely.
    expect(reconcileAntigravityModels([], staticModels)).toEqual([]);

    // Partial catalog (medium only): bare alias survives (its wire id is medium),
    // the high/low tier ids drop out and the medium wire id is not listed twice.
    expect(
      reconcileAntigravityModels(
        [{ id: "gemini-4-argon-medium", contextLength: 1048576, maxOutputTokens: 65536 }],
        staticModels,
      ).map((m) => m.id),
    ).toEqual(["gemini-4-argon-medium", "gemini-4-argon"]);
  });

  it("keeps the standalone CLI Antigravity menu in sync with Argon tiers", () => {
    const source = readFileSync(join(here, "../../cli/src/cli/menus/providers.js"), "utf8");
    const agCatalog = source.match(/\n {2}ag: \[([\s\S]*?)\n {2}\],/)?.[1] || "";

    expect(agCatalog).toContain("gemini-4-argon-high");
    expect(agCatalog).toContain("gemini-4-argon-medium");
    expect(agCatalog).toContain("gemini-4-argon-low");
  });
});

describe("Gemini 4 Argon thinking regression tests", () => {
  it.each(["high", "medium", "low"])(
    "sets nested request.generationConfig.thinkingConfig with level '%s' without stripping it",
    (tier) => {
      const publicModel = `gemini-4-argon-${tier}`;
      const upstreamModel = getModelUpstreamId("ag", publicModel);
      const body = {
        model: stripThinkingSuffix(upstreamModel),
        request: {
          contents: [{ role: "user", parts: [{ text: "solve this" }] }],
          generationConfig: {},
        },
      };

      applyThinking("antigravity", upstreamModel, body, "antigravity");
      const finalBody = new AntigravityExecutor().transformRequest(publicModel, body, true, {
        projectId: "project-argon",
        connectionId: "connection-argon",
      });

      expect(upstreamModel).toBe(`gemini-4-argon-${tier}(${tier})`);
      expect(finalBody.model).toBe(`gemini-4-argon-${tier}`);
      expect(finalBody.request.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: tier,
        includeThoughts: true,
      });
      // Ensure the executor did not strip thinkingConfig from request.generationConfig
      expect(finalBody.request.generationConfig).toHaveProperty("thinkingConfig");
      expect(finalBody.request.generationConfig.thinkingConfig.thinkingLevel).toBe(tier);
    },
  );

  it("bare gemini-4-argon with reasoning_effort='high' steers both wire model and thinkingLevel to high", () => {
    const publicModel = "gemini-4-argon";
    const upstreamModel = getModelUpstreamId("ag", publicModel);
    expect(upstreamModel).toBe("gemini-4-argon-medium");

    const body = {
      model: stripThinkingSuffix(upstreamModel),
      reasoning_effort: "high",
      request: {
        contents: [{ role: "user", parts: [{ text: "prove P!=NP" }] }],
        generationConfig: {},
      },
    };

    applyThinking("antigravity", upstreamModel, body, "antigravity");
    const finalBody = new AntigravityExecutor().transformRequest(publicModel, body, true, {
      projectId: "project-argon",
      connectionId: "connection-argon",
    });

    expect(finalBody.model).toBe("gemini-4-argon-high");
    expect(finalBody.request.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "high",
      includeThoughts: true,
    });
    expect(finalBody.request.generationConfig.thinkingConfig).not.toHaveProperty("thinkingBudget");
  });

  it("bare gemini-4-argon with explicit (high) suffix steers both wire model and thinkingLevel to high", () => {
    const requestedModel = "gemini-4-argon(high)";
    const upstreamModel = getModelUpstreamId("ag", requestedModel);
    expect(upstreamModel).toBe("gemini-4-argon-medium(high)");

    const body = {
      model: stripThinkingSuffix(upstreamModel),
      request: {
        contents: [{ role: "user", parts: [{ text: "prove P!=NP" }] }],
        generationConfig: {},
      },
    };

    applyThinking("antigravity", upstreamModel, body, "antigravity");
    const finalBody = new AntigravityExecutor().transformRequest(requestedModel, body, true, {
      projectId: "project-argon",
      connectionId: "connection-argon",
    });

    expect(finalBody.model).toBe("gemini-4-argon-high");
    expect(finalBody.request.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "high",
      includeThoughts: true,
    });
  });

  it("bare gemini-4-argon default (no overrides) defaults to medium wire model and thinkingLevel", () => {
    const publicModel = "gemini-4-argon";
    const upstreamModel = getModelUpstreamId("ag", publicModel);
    expect(upstreamModel).toBe("gemini-4-argon-medium");

    const body = {
      model: stripThinkingSuffix(upstreamModel),
      request: {
        contents: [{ role: "user", parts: [{ text: "hello argon" }] }],
        generationConfig: {},
      },
    };

    applyThinking("antigravity", upstreamModel, body, "antigravity");
    const finalBody = new AntigravityExecutor().transformRequest(publicModel, body, true, {
      projectId: "project-argon",
      connectionId: "connection-argon",
    });

    expect(finalBody.model).toBe("gemini-4-argon-medium");
    expect(finalBody.request.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "medium",
      includeThoughts: true,
    });
  });

  it("explicit tier id wins over body effort: gemini-4-argon-high + effort low stays high/high", () => {
    const publicModel = "gemini-4-argon-high";
    const upstreamModel = getModelUpstreamId("ag", publicModel);
    const body = {
      model: stripThinkingSuffix(upstreamModel),
      reasoning_effort: "low",
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: {},
      },
    };

    applyThinking("antigravity", upstreamModel, body, "antigravity");
    const finalBody = new AntigravityExecutor().transformRequest(publicModel, body, true, {
      projectId: "project-argon",
      connectionId: "connection-argon",
    });

    expect(finalBody.model).toBe("gemini-4-argon-high");
    expect(finalBody.request.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "high",
      includeThoughts: true,
    });
    expect(finalBody.request.generationConfig.thinkingConfig).not.toHaveProperty("thinkingBudget");
  });

  it("explicit tier id wins over suffix: gemini-4-argon-high(low) stays high/high", () => {
    const requestedModel = "gemini-4-argon-high(low)";
    const upstreamModel = getModelUpstreamId("ag", requestedModel);
    const body = {
      model: stripThinkingSuffix(upstreamModel),
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: {},
      },
    };

    applyThinking("antigravity", upstreamModel, body, "antigravity");
    const finalBody = new AntigravityExecutor().transformRequest(requestedModel, body, true, {
      projectId: "project-argon",
      connectionId: "connection-argon",
    });

    expect(finalBody.model).toBe("gemini-4-argon-high");
    expect(finalBody.request.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "high",
      includeThoughts: true,
    });
  });

  it("bare gemini-4-argon with reasoning_effort='none' maps to low with includeThoughts: true", () => {
    const publicModel = "gemini-4-argon";
    const upstreamModel = getModelUpstreamId("ag", publicModel);
    const body = {
      model: stripThinkingSuffix(upstreamModel),
      reasoning_effort: "none",
      request: {
        contents: [{ role: "user", parts: [{ text: "unthought" }] }],
        generationConfig: {},
      },
    };

    applyThinking("antigravity", upstreamModel, body, "antigravity");
    const finalBody = new AntigravityExecutor().transformRequest(publicModel, body, true, {
      projectId: "project-argon",
      connectionId: "connection-argon",
    });

    expect(finalBody.model).toBe("gemini-4-argon-low");
    expect(finalBody.request.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "low",
      includeThoughts: true,
    });
  });
});
