// Live OpenCode Go catalog (YAN-197): dashboard + /v1/models, and the
// transport inferred for ids the registry doesn't know yet.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { createProviderConnection, deleteProviderConnectionsByProvider } from "@/models/index.js";
import { getProviderAlias } from "@/shared/constants/providers";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import {
  PROVIDER_ID_TO_ALIAS,
  getModelSupportedFormats,
  getModelTargetFormat,
} from "../../open-sse/config/providerModels.js";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";

const URL_ = "https://opencode.ai/zen/go/v1/models";
let respond;
const calls = [];

beforeEach(async () => {
  calls.length = 0;
  clearLiveModelsCache();
  await deleteProviderConnectionsByProvider("opencode-go");
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (url, init = {}) => {
    if (String(url) !== URL_) return nativeFetch(url, init);
    calls.push(init.headers?.Authorization);
    return respond();
  });
});

afterEach(() => vi.unstubAllGlobals());

const dashboardModels = async (id) => {
  const res = await GET(new Request(`http://localhost/api/providers/${id}/models`), {
    params: Promise.resolve({ id }),
  });
  return res.json();
};

const connect = () =>
  createProviderConnection({
    provider: "opencode-go",
    authType: "apikey",
    apiKey: "sk-go",
    testStatus: "active",
  });

describe("OpenCode Go live catalog", () => {
  it("lists live ids with registry names on the dashboard and in /v1/models", async () => {
    respond = () => Response.json({ data: [{ id: "glm-5.3" }, { id: "grok-4.7" }] });
    const conn = await connect();

    const body = await dashboardModels(conn.id);
    expect(body.warning).toBeUndefined();
    expect(body.models).toEqual([
      { id: "glm-5.3", name: "GLM 5.3" },
      { id: "grok-4.7", name: "grok-4.7" },
    ]);
    expect(calls[0]).toBe("Bearer sk-go");

    const ids = (await buildModelsList(["llm"])).map((m) => m.id);
    expect(ids).toContain(`${getProviderAlias("opencode-go")}/grok-4.7`);
  });

  it("warns without echoing the key when upstream rejects it", async () => {
    respond = () => new Response("bad sk-go", { status: 401 });
    const body = await dashboardModels((await connect()).id);
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/401/);
    expect(body.warning).not.toContain("sk-go");
  });
});

describe("transport for live-only ids", () => {
  it.each([
    ["grok-4.7", "openai-responses", ["openai-responses"]],
    ["gpt-6-luna", "openai-responses", ["openai-responses"]],
    ["qwen3.5-plus", null, ["openai", "claude"]],
    ["minimax-m4", null, ["openai", "claude"]],
    ["mimo-v2.6-pro", null, ["openai"]],
    ["gpt-oss-120b", null, ["openai"]],
  ])("%s", (id, target, formats) => {
    expect(getModelTargetFormat("opencode-go", id)).toBe(target);
    expect(getModelSupportedFormats("opencode-go", id)).toEqual(formats);
  });

  it("is keyed by the alias chatCore passes", () => {
    const alias = PROVIDER_ID_TO_ALIAS["opencode-go"] || "opencode-go";
    expect(getModelTargetFormat(alias, "grok-4.7(high)")).toBe("openai-responses");
  });

  it("keeps registry metadata for known ids and leaves other providers alone", () => {
    expect(getModelSupportedFormats("opencode-go", "deepseek-v4-pro")).toEqual([
      "openai",
      "claude",
      "openai-responses",
    ]);
    expect(getModelSupportedFormats("glm", "glm-9-live")).toBeNull();
  });

  it("sends inferred responses-only ids to /responses", () => {
    const url = new OpenCodeGoExecutor().buildUrl("grok-4.7(high)", true);
    expect(url).toBe("https://opencode.ai/zen/go/v1/responses");
  });
});
