import { describe, expect, it } from "vitest";
import {
  normalizeLiveModelId,
  mergeLiveWithStatic,
  selectModelsToImport,
} from "@/shared/utils/liveModels.js";
import { LIVE_MODEL_PROVIDERS } from "@/shared/constants/providers.js";

describe("LIVE_MODEL_PROVIDERS", () => {
  it("is derived from the registry features.liveModels flag", () => {
    expect([...LIVE_MODEL_PROVIDERS].sort()).toEqual([
      "anthropic",
      "antigravity",
      "bazaarlink",
      "cerebras",
      "chutes",
      "claude",
      "cline",
      "clinepass",
      "codex",
      "cursor",
      "deepseek",
      "fireworks",
      "gemini",
      "gemini-cli",
      "github",
      "grok-cli",
      "groq",
      "hyperbolic",
      "kimchi",
      "kiro",
      "llm7",
      "mistral",
      "nebius",
      "nvidia",
      "ollama",
      "ollama-local",
      "openai",
      "opencode",
      "opencode-go",
      "openrouter",
      "perplexity-agent",
      "qoder",
      "sambanova",
      "siliconflow",
      "together",
      "venice",
      "vercel-ai-gateway",
      "xai",
      "zed",
    ]);
  });
});

describe("normalizeLiveModelId", () => {
  it("strips the qoder/ prefix for qoder only", () => {
    expect(normalizeLiveModelId("qoder", "qoder/auto")).toBe("auto");
    expect(normalizeLiveModelId("qoder", "auto")).toBe("auto");
    expect(normalizeLiveModelId("cline", "qoder/auto")).toBe("qoder/auto");
  });

  it("leaves other providers' ids unchanged", () => {
    expect(normalizeLiveModelId("cline", "anthropic/claude-opus-4.6")).toBe(
      "anthropic/claude-opus-4.6",
    );
    expect(normalizeLiveModelId("claude", "claude-opus-5-5")).toBe("claude-opus-5-5");
  });

  it("returns null for missing, blank, non-string or prefix-only ids", () => {
    expect(normalizeLiveModelId("cursor", undefined)).toBeNull();
    expect(normalizeLiveModelId("cursor", "")).toBeNull();
    expect(normalizeLiveModelId("cursor", "   ")).toBeNull();
    expect(normalizeLiveModelId("cursor", 42)).toBeNull();
    expect(normalizeLiveModelId("qoder", "qoder/")).toBeNull();
  });
});

describe("mergeLiveWithStatic", () => {
  const staticModels = [
    {
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5 (curated)",
      type: "llm",
      capabilities: ["vision"],
    },
    { id: "claude-static-only", name: "Static Only" },
  ];

  it("lets curated static metadata win over live fields for known ids", () => {
    const merged = mergeLiveWithStatic(
      "claude",
      [{ id: "claude-opus-5-5", name: "Claude Opus 5.5", createdAt: "2026-01-01" }],
      staticModels,
    );
    expect(merged).toEqual([
      {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5 (curated)",
        type: "llm",
        capabilities: ["vision"],
        createdAt: "2026-01-01",
      },
    ]);
  });

  it("keeps live-only models, defaulting name to id, and drops static-only ones", () => {
    const merged = mergeLiveWithStatic(
      "claude",
      [
        { id: "claude-new", createdAt: "2026-02-02" },
        { id: "claude-named", name: "Named" },
      ],
      staticModels,
    );
    expect(merged).toEqual([
      { id: "claude-new", name: "claude-new", createdAt: "2026-02-02" },
      { id: "claude-named", name: "Named" },
    ]);
  });

  it("matches curated entries per kind when one id is both chat and stt", () => {
    const merged = mergeLiveWithStatic(
      "gemini",
      [{ id: "gemini-2.5-pro", name: "live" }],
      [
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (STT)", kind: "stt" },
      ],
    );
    expect(merged).toEqual([{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }]);
  });

  it("normalizes qoder ids before matching the static list", () => {
    const merged = mergeLiveWithStatic(
      "qoder",
      [{ id: "qoder/auto", name: "Auto (live)" }],
      [{ id: "auto", name: "Auto" }],
    );
    expect(merged).toEqual([{ id: "auto", name: "Auto" }]);
  });

  it("drops invalid entries and dedupes by normalized id (first wins)", () => {
    const merged = mergeLiveWithStatic(
      "qoder",
      [
        null,
        "qoder/auto",
        { name: "no id" },
        { id: "" },
        { id: "qoder/lite", name: "Lite A" },
        { id: "lite", name: "Lite B" },
      ],
      [],
    );
    expect(merged).toEqual([{ id: "lite", name: "Lite A" }]);
  });

  it("tolerates non-array inputs", () => {
    expect(mergeLiveWithStatic("cursor", undefined, undefined)).toEqual([]);
    expect(mergeLiveWithStatic("cursor", [{ id: "a" }], null)).toEqual([{ id: "a", name: "a" }]);
  });
});

describe("selectModelsToImport", () => {
  const base = {
    providerId: "qoder",
    providerStorageAlias: "qd",
    staticModels: [{ id: "auto" }],
    customModels: [],
    modelAliases: {},
  };

  it("returns normalized ids not already present, deduped, in upstream order", () => {
    const ids = selectModelsToImport({
      ...base,
      liveModels: [
        { id: "qoder/auto" },
        { id: "qoder/ultimate" },
        { id: "ultimate" },
        { id: "qoder/lite" },
      ],
    });
    expect(ids).toEqual(["ultimate", "lite"]);
  });

  it("skips ids already registered as llm custom models under the same provider alias", () => {
    const ids = selectModelsToImport({
      ...base,
      liveModels: [{ id: "qoder/a" }, { id: "qoder/b" }, { id: "qoder/c" }, { id: "qoder/d" }],
      customModels: [
        { providerAlias: "qd", id: "a", type: "llm" },
        { providerAlias: "qd", id: "b" },
        { providerAlias: "qd", id: "c", kind: "embedding" },
        { providerAlias: "other", id: "d", type: "llm" },
      ],
    });
    expect(ids).toEqual(["c", "d"]);
  });

  it("skips ids already targeted by a model alias", () => {
    const ids = selectModelsToImport({
      ...base,
      providerId: "cline",
      providerStorageAlias: "cl",
      staticModels: [],
      liveModels: [{ id: "anthropic/claude-opus-4.6" }, { id: "openai/gpt-5.4" }],
      modelAliases: { opus: "cl/anthropic/claude-opus-4.6", other: "cc/openai/gpt-5.4" },
    });
    expect(ids).toEqual(["openai/gpt-5.4"]);
  });

  it("skips non-chat live entries, which would otherwise be imported as llm", () => {
    const ids = selectModelsToImport({
      ...base,
      liveModels: [{ id: "chat" }, { id: "img", kind: "image" }, { id: "img2", type: "image" }],
    });
    expect(ids).toEqual(["chat"]);
  });

  it("skips hidden live entries", () => {
    const ids = selectModelsToImport({
      ...base,
      liveModels: [{ id: "shown" }, { id: "secret", hidden: true }],
    });
    expect(ids).toEqual(["shown"]);
  });

  it("returns an empty list for empty or invalid live catalogs", () => {
    expect(selectModelsToImport({ ...base, liveModels: [] })).toEqual([]);
    expect(selectModelsToImport({ ...base, liveModels: undefined })).toEqual([]);
    expect(selectModelsToImport({ ...base, liveModels: [null, {}, { id: "  " }] })).toEqual([]);
  });
});
