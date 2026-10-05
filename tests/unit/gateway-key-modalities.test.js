import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveGatewayAuth: vi.fn(),
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  getComboModels: vi.fn(),
  getComboByName: vi.fn(),
  core: vi.fn(),
  saveRequestUsage: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));
vi.mock("@/lib/auth/gatewayAuth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveGatewayAuth: mocks.resolveGatewayAuth,
}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: () => "raw-client-secret",
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
  // YAN-364: tts.js / imageGeneration.js import this alongside getModelInfo +
  // getComboModels; the mocks drive its return per test.
  getComboByName: mocks.getComboByName,
}));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getComboByName: mocks.getComboByName }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}) }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("../../src/sse/services/comboHeadroom.js", () => ({ loadComboHeadroomFn: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  maskKey: vi.fn(),
}));
vi.mock("../../open-sse/handlers/embeddingsCore.js", () => ({ handleEmbeddingsCore: mocks.core }));
vi.mock("../../open-sse/handlers/ttsCore.js", () => ({ handleTtsCore: mocks.core }));
vi.mock("../../open-sse/handlers/sttCore.js", () => ({ handleSttCore: mocks.core }));
vi.mock("../../open-sse/handlers/imageGenerationCore.js", () => ({
  handleImageGenerationCore: mocks.core,
}));

import { handleEmbeddings } from "../../src/sse/handlers/embeddings.js";
import { handleTts } from "../../src/sse/handlers/tts.js";
import { handleStt } from "../../src/sse/handlers/stt.js";
import { handleImageGeneration } from "../../src/sse/handlers/imageGeneration.js";

const principal = Object.freeze({
  via: "apiKey",
  apiKeyId: "key-a",
  workspaceId: "workspace-a",
  userId: "user-a",
  scopes: { allowedModels: ["openai/model"], allowedCombos: ["combo-a"] },
});
const modalities = [
  ["embeddings", handleEmbeddings, { input: "hello" }],
  ["tts", handleTts, { input: "hello" }],
  ["stt", handleStt, null],
  ["images", handleImageGeneration, { prompt: "hello" }],
];
function request(fields, model = "alias", headers = {}) {
  if (fields === null) {
    const body = new FormData();
    body.set("model", model);
    body.set("file", new Blob(["audio"]), "audio.wav");
    return new Request("http://localhost/v1/audio/transcriptions", {
      method: "POST",
      body,
      headers,
    });
  }
  return new Request("http://localhost/v1/test", {
    method: "POST",
    body: JSON.stringify({ model, ...fields }),
    headers,
  });
}

describe("gateway modality handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveGatewayAuth.mockResolvedValue({ principal, legacy: false });
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "model" });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getComboByName.mockResolvedValue(null);
    mocks.getProviderCredentials.mockImplementation(
      async (_provider, _exclude, _model, options) => {
        // Workspace-scoped service stand-in: principals only get workspace-a's
        // connections; legacy requests (no principal) keep today's unscoped behavior.
        if (options?.principal && options.principal.workspaceId !== "workspace-a") return null;
        return { connectionId: "connection-a", connectionName: "A", apiKey: "upstream-secret" };
      },
    );
    mocks.core.mockImplementation(async () => ({
      success: true,
      response: Response.json({ ok: true }),
      usage: { prompt_tokens: 12, total_tokens: 12 },
    }));
    mocks.saveRequestUsage.mockResolvedValue(undefined);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
  });

  it.each(modalities)(
    "%s reaches mocked upstream with workspace credentials",
    async (_name, handler, fields) => {
      const response = await handler(request(fields));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(mocks.core).toHaveBeenCalledTimes(1);
      expect(mocks.getModelInfo).toHaveBeenCalledWith("alias", { principal });
      expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
        "openai",
        expect.any(Set),
        "model",
        expect.objectContaining({ principal }),
      );
    },
  );

  it.each(modalities)(
    "%s denied workspace has zero upstream calls",
    async (_name, handler, fields) => {
      const deniedPrincipal = Object.freeze({ ...principal, workspaceId: "workspace-b" });
      mocks.resolveGatewayAuth.mockResolvedValue({ principal: deniedPrincipal, legacy: false });
      const response = await handler(request(fields));
      expect(response.status).toBe(400);
      expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
      expect(mocks.getProviderCredentials.mock.calls[0][3].principal).toBe(deniedPrincipal);
      expect(mocks.core).not.toHaveBeenCalled();
    },
  );

  it.each(modalities)(
    "%s returns resolver failure without routing",
    async (_name, handler, fields) => {
      const denied = Response.json({ error: "Invalid API key" }, { status: 401 });
      mocks.resolveGatewayAuth.mockResolvedValue(denied);
      expect(await handler(request(fields))).toBe(denied);
      expect(mocks.getModelInfo).not.toHaveBeenCalled();
      expect(mocks.core).not.toHaveBeenCalled();
    },
  );

  it.each(modalities)(
    "%s denies canonical model before credentials",
    async (_name, handler, fields) => {
      mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "forbidden" });
      expect((await handler(request(fields))).status).toBe(403);
      expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
      expect(mocks.core).not.toHaveBeenCalled();
    },
  );

  it("embeddings usage carries IDs, never raw hashed key", async () => {
    await handleEmbeddings(request({ input: "hello" }));
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: null,
        apiKeyId: "key-a",
        workspaceId: "workspace-a",
        userId: "user-a",
      }),
    );
  });

  it.each(modalities)(
    "%s threads principal into every account retry",
    async (_name, handler, fields) => {
      mocks.core.mockResolvedValueOnce({ success: false, status: 429, error: "busy" });
      expect((await handler(request(fields))).status).toBe(200);
      expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
      for (const call of mocks.getProviderCredentials.mock.calls)
        expect(call[3].principal).toBe(principal);
    },
  );

  it.each([modalities[1], modalities[3]])(
    "%s denies combo ID before expansion",
    async (_name, handler, fields) => {
      mocks.getComboByName.mockResolvedValue({ id: "combo-denied" });
      mocks.getComboModels.mockResolvedValue(["openai/model"]);
      expect((await handler(request(fields, "combo"))).status).toBe(403);
      expect(mocks.getComboModels).not.toHaveBeenCalled();
      expect(mocks.core).not.toHaveBeenCalled();
    },
  );

  it.each([modalities[1], modalities[3]])(
    "%s checks canonical combo leaf",
    async (_name, handler, fields) => {
      mocks.getComboByName.mockResolvedValue({ id: "combo-a" });
      mocks.getComboModels.mockResolvedValue(["openai/forbidden"]);
      mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "forbidden" });
      expect((await handler(request(fields, "combo"))).status).toBe(403);
      expect(mocks.getModelInfo).toHaveBeenCalledWith("openai/forbidden", { principal });
      expect(mocks.core).not.toHaveBeenCalled();
    },
  );

  // resolveGatewayAuth legacy branch: principal is null and the caller keeps
  // today's raw-key behavior — no principal threading, no target restrictions.
  it.each(modalities)(
    "%s legacy branch routes without principal scoping",
    async (_name, handler, fields) => {
      mocks.resolveGatewayAuth.mockResolvedValue({ principal: null, legacy: true });
      const response = await handler(request(fields));
      expect(response.status).toBe(200);
      expect(mocks.getModelInfo).toHaveBeenCalledWith("alias", {});
      expect(mocks.core).toHaveBeenCalledTimes(1);
      for (const call of mocks.getProviderCredentials.mock.calls)
        expect(call[3]).not.toHaveProperty("principal");
    },
  );

  // noAuth image providers (real NO_AUTH_PROVIDERS set): the allowlist check
  // still runs before core even though no credentials are ever fetched.
  it.each(["sdwebui", "comfyui"])(
    "images %s is scope-checked before credential-free core",
    async (provider) => {
      mocks.getModelInfo.mockResolvedValue({ provider, model: "sd-v1-5" });
      expect((await handleImageGeneration(request({ prompt: "hi" }))).status).toBe(403); // not in allowedModels
      expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
      expect(mocks.core).not.toHaveBeenCalled();

      mocks.resolveGatewayAuth.mockResolvedValue({
        principal: Object.freeze({
          ...principal,
          scopes: { allowedModels: [`${provider}/sd-v1-5`], allowedCombos: [] },
        }),
        legacy: false,
      });
      expect((await handleImageGeneration(request({ prompt: "hi" }))).status).toBe(200);
      expect(mocks.core).toHaveBeenCalledTimes(1);
      expect(mocks.core.mock.calls[0][0].credentials).toBeNull();
      expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    },
  );

  // Non-credential tts/stt (real registry: edge-tts is noAuth; sdwebui has no
  // stt serviceKind so it is not in stt's CREDENTIALED_PROVIDERS): allowlist
  // check still runs before the credential-free core call.
  it("tts non-credential provider is scope-checked before core", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "edge-tts", model: "voice" });
    expect((await handleTts(request({ input: "hi" }))).status).toBe(403);
    expect(mocks.core).not.toHaveBeenCalled();
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    mocks.resolveGatewayAuth.mockResolvedValue({
      principal: Object.freeze({
        ...principal,
        scopes: { allowedModels: ["edge-tts/voice"], allowedCombos: [] },
      }),
      legacy: false,
    });
    expect((await handleTts(request({ input: "hi" }))).status).toBe(200);
    expect(mocks.core).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("stt non-credential provider is scope-checked before core", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "sdwebui", model: "sd-v1-5" });
    expect((await handleStt(request(null))).status).toBe(403);
    expect(mocks.core).not.toHaveBeenCalled();
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    mocks.resolveGatewayAuth.mockResolvedValue({
      principal: Object.freeze({
        ...principal,
        scopes: { allowedModels: ["sdwebui/sd-v1-5"], allowedCombos: [] },
      }),
      legacy: false,
    });
    expect((await handleStt(request(null))).status).toBe(200);
    expect(mocks.core).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  // Mixed combo against the REAL combo service (never mocked here): a 403
  // deny is classified by the real fallback policy (ERROR_RULES status 403 →
  // shouldFallback), so the forbidden leaf is skipped and the next allowed
  // leaf serves. The forbidden leaf never reaches the upstream core.
  it("tts combo skips a forbidden leaf and serves the allowed one via real combo fallback", async () => {
    mocks.getComboByName.mockResolvedValue({ id: "combo-a" });
    mocks.getComboModels.mockResolvedValue(["openai/forbidden", "openai/model"]);
    mocks.getModelInfo.mockImplementation(async (modelStr) =>
      modelStr === "openai/forbidden"
        ? { provider: "openai", model: "forbidden" }
        : { provider: "openai", model: "model" },
    );
    const response = await handleTts(request({ input: "hi" }, "combo"));
    expect(response.status).toBe(200);
    expect(mocks.getModelInfo).toHaveBeenCalledWith("openai/forbidden", { principal });
    expect(mocks.getModelInfo).toHaveBeenCalledWith("openai/model", { principal });
    expect(mocks.core).toHaveBeenCalledTimes(1);
    expect(mocks.core.mock.calls[0][0].model).toBe("model");
    expect(mocks.core.mock.calls[0][0].credentials).toMatchObject({ apiKey: "upstream-secret" });
  });

  it("tts combo with only forbidden leaves ends 403, core never called", async () => {
    mocks.getComboByName.mockResolvedValue({ id: "combo-a" });
    mocks.getComboModels.mockResolvedValue(["openai/forbidden", "openai/forbidden-2"]);
    mocks.getModelInfo.mockImplementation(async (modelStr) => ({
      provider: "openai",
      model: modelStr.split("/")[1],
    }));
    expect((await handleTts(request({ input: "hi" }, "combo"))).status).toBe(403);
    expect(mocks.core).not.toHaveBeenCalled();
  });
});
