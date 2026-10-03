// Live Ollama Cloud and Ollama Local catalogs seen by the dashboard and /v1/models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { GET } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { createProviderConnection, deleteProviderConnectionsByProvider } from "@/models/index.js";
import { getProviderAlias } from "@/shared/constants/providers";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import { parseOllamaTags } from "@/lib/providerModels/ollamaModels.js";

const HOSTS = ["https://ollama.com/", "http://localhost:11434/", "http://gpu-box:11434/"];
let respond;
const calls = [];

beforeEach(async () => {
  calls.length = 0;
  respond = () => new Response("unexpected", { status: 500 });
  clearLiveModelsCache();
  for (const p of ["ollama", "ollama-local"]) await deleteProviderConnectionsByProvider(p);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (url, init = {}) => {
    if (!HOSTS.some((h) => String(url).startsWith(h))) return nativeFetch(url, init);
    calls.push({ url: String(url), auth: init.headers?.Authorization });
    return respond(String(url));
  });
});
afterEach(() => vi.unstubAllGlobals());

async function dashboardModels(id) {
  const res = await GET(new Request(`http://localhost/api/providers/${id}/models`), {
    params: Promise.resolve({ id }),
  });
  return res.json();
}

const tags = (...entries) => Response.json({ models: entries });

it("parseOllamaTags maps model/name to id, dedupes and drops embedding models", () => {
  const body = {
    models: [
      { name: "glm-5.3", model: "glm-5.3", details: { family: "" } },
      { name: "llama3.2:latest", model: "llama3.2:latest", details: { family: "llama" } },
      { name: "only-name" },
      { name: "glm-5.3", model: "glm-5.3" },
      { name: "nomic-embed-text:latest", model: "nomic-embed-text:latest" },
      { name: "mxbai:latest", model: "mxbai:latest", details: { families: ["bert"] } },
      { name: "  " },
    ],
  };
  expect(parseOllamaTags(body)).toEqual([
    { id: "glm-5.3", name: "glm-5.3" },
    { id: "llama3.2:latest", name: "llama3.2:latest" },
    { id: "only-name", name: "only-name" },
  ]);
  expect(parseOllamaTags(null)).toEqual([]);
});

describe("live catalogs end to end", () => {
  it("ollama cloud lists live models on the dashboard and in /v1/models", async () => {
    respond = () => tags({ name: "glm-9", model: "glm-9" });
    const conn = await createProviderConnection({
      provider: "ollama",
      authType: "apikey",
      apiKey: "ol-test",
      testStatus: "active",
    });

    const body = await dashboardModels(conn.id);
    expect(body).toMatchObject({ models: [{ id: "glm-9" }] });
    expect(body.warning).toBeUndefined();
    expect(calls[0]).toEqual({ url: "https://ollama.com/api/tags", auth: "Bearer ol-test" });

    const alias = getProviderAlias("ollama");
    expect((await buildModelsList(["llm"])).map((m) => m.id)).toContain(`${alias}/glm-9`);
  });

  it("ollama local reads the configured host", async () => {
    respond = () => tags({ name: "qwen3:8b", model: "qwen3:8b" });
    const conn = await createProviderConnection({
      provider: "ollama-local",
      authType: "apikey",
      testStatus: "active",
      providerSpecificData: { baseUrl: "http://gpu-box:11434/" },
    });

    const body = await dashboardModels(conn.id);
    expect(calls[0]).toEqual({ url: "http://gpu-box:11434/api/tags", auth: undefined });
    expect(body.models.map((m) => m.id)).toEqual(["qwen3:8b"]);

    const alias = getProviderAlias("ollama-local");
    expect((await buildModelsList(["llm"])).map((m) => m.id)).toContain(`${alias}/qwen3:8b`);
  });

  it("ollama local warns when the daemon is down", async () => {
    respond = () => {
      throw new TypeError("fetch failed");
    };
    const conn = await createProviderConnection({
      provider: "ollama-local",
      authType: "apikey",
      testStatus: "active",
    });

    const body = await dashboardModels(conn.id);
    expect(body.models).toEqual([]);
    expect(body.warning).toBe("Ollama not reachable at http://localhost:11434");
  });
});
