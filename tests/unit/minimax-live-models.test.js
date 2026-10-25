// Live MiniMax Coding (api.minimax.io) and MiniMax (China, api.minimaxi.com)
// API-key catalogs seen by the dashboard and /v1/models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import {
  createProviderConnectionUnscoped,
  deleteProviderConnectionsByProviderUnscoped,
} from "@/models/index.js";
import { getProviderAlias } from "@/shared/constants/providers";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import { parseMinimaxModels } from "@/lib/providerModels/apiKeyModels.js";
import {
  getModelsByProviderId,
  getModelSupportedFormats,
  getModelTargetFormat,
} from "open-sse/config/providerModels.js";

const PROVIDERS = ["minimax", "minimax-cn"];
const HOSTS = ["https://api.minimax.io/", "https://api.minimaxi.com/"];

let respond;
const calls = [];

beforeEach(async () => {
  calls.length = 0;
  respond = () => new Response("unexpected", { status: 500 });
  clearLiveModelsCache();
  for (const p of PROVIDERS) await deleteProviderConnectionsByProviderUnscoped(p);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (url, init = {}) => {
    if (!HOSTS.some((h) => String(url).startsWith(h))) return nativeFetch(url, init);
    calls.push({ url: String(url), auth: init.headers?.Authorization });
    return respond(String(url));
  });
});

afterEach(() => vi.unstubAllGlobals());

const connect = (provider, apiKey) =>
  createProviderConnectionUnscoped({
    provider,
    authType: "apikey",
    apiKey,
    testStatus: "active",
  });

const dashboardModels = async (id) => {
  const res = await GET(new Request(`http://localhost/api/providers/${id}/models`), {
    params: Promise.resolve({ id }),
  });
  return res.json();
};

const staticTtsIds = (provider) =>
  getModelsByProviderId(provider)
    .filter((m) => (m.kind || m.type) === "tts")
    .map((m) => m.id);

const list = (...ids) => ({ object: "list", data: ids.map((id) => ({ id, owned_by: "minimax" })) });

describe("parseMinimaxModels", () => {
  it("names ids from the registry, falling back to the id", () => {
    const models = parseMinimaxModels(list("MiniMax-M2.7", "brand-new-model"), "minimax");
    expect(models.slice(0, 2)).toEqual([
      { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
      { id: "brand-new-model", name: "brand-new-model" },
    ]);
  });

  it("dedupes ids and drops empty ones", () => {
    const body = { data: [{ id: "MiniMax-M3" }, { id: "MiniMax-M3" }, { id: "" }, {}] };
    const ids = parseMinimaxModels(body, "minimax").map((m) => m.id);
    expect(ids.filter((id) => id === "MiniMax-M3")).toHaveLength(1);
    expect(ids).not.toContain("");
  });

  it("classifies kinds: static ids keep theirs, unknown speech-* drops, the rest is chat", () => {
    const models = parseMinimaxModels(
      list("MiniMax-M3", "speech-3.0-hd", "speech-02-hd", "MiniMax-M9"),
      "minimax",
    );
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["MiniMax-M3"].kind).toBeUndefined();
    expect(byId["MiniMax-M9"].kind).toBeUndefined();
    expect(byId["speech-02-hd"].kind).toBe("tts");
    // The TTS dispatcher can't route a bare unknown id (it reads it as a voice).
    expect(byId["speech-3.0-hd"]).toBeUndefined();
  });

  it("lists unknown image ids only where the provider serves image", () => {
    const body = list("MiniMax-M2.7", "image-02", "minimax-image-01");
    const global = parseMinimaxModels(body, "minimax");
    expect(global.find((m) => m.id === "image-02")).toMatchObject({ kind: "image" });
    expect(global.find((m) => m.id === "minimax-image-01")).toMatchObject({ kind: "image" });
    const cn = parseMinimaxModels(body, "minimax-cn").map((m) => m.id);
    expect(cn).not.toContain("image-02");
    expect(cn).not.toContain("minimax-image-01");
  });

  it("drops video, music and Hailuo ids that have no route", () => {
    const ids = parseMinimaxModels(
      list(
        "MiniMax-M2.7",
        "MiniMax-Hailuo-2.3",
        "video-01",
        "music-2.5",
        "T2V-01",
        "S2V-01",
        "embo-01",
        "MiniMax-H3",
        "MiniMax-H3-Highspeed",
        "asr-1.0",
      ),
      "minimax",
    ).map((m) => m.id);
    expect(ids).toContain("MiniMax-M2.7");
    for (const dropped of [
      "MiniMax-Hailuo-2.3",
      "video-01",
      "music-2.5",
      "T2V-01",
      "S2V-01",
      "embo-01",
      "MiniMax-H3",
      "MiniMax-H3-Highspeed",
      "asr-1.0",
    ]) {
      expect(ids).not.toContain(dropped);
    }
  });

  it.each(PROVIDERS)(
    "%s: current M-series chat ids are never caught by the drop rules",
    (provider) => {
      const chat = ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1"];
      const ids = parseMinimaxModels(list(...chat), provider).map((m) => m.id);
      expect(ids).toEqual(expect.arrayContaining(chat));
    },
  );

  it("adds back static tts/image rows the live list lacks", () => {
    const global = parseMinimaxModels(list("MiniMax-M2.7"), "minimax");
    expect(global).toContainEqual({
      id: "minimax-image-01",
      name: "MiniMax Image 01",
      kind: "image",
    });
    expect(global.filter((m) => m.kind === "tts").map((m) => m.id)).toEqual(
      staticTtsIds("minimax"),
    );
    expect(global.map((m) => m.id)).not.toContain("MiniMax-M2.1");

    const cn = parseMinimaxModels(list("MiniMax-M2.7"), "minimax-cn");
    expect(cn.filter((m) => m.kind === "tts").map((m) => m.id)).toEqual(staticTtsIds("minimax-cn"));
    expect(cn.some((m) => m.kind === "image")).toBe(false);
  });

  it("returns nothing for an empty live list", () => {
    expect(parseMinimaxModels({ data: [] }, "minimax")).toEqual([]);
    expect(parseMinimaxModels({}, "minimax-cn")).toEqual([]);
  });

  it("returns nothing when only unrouted ids are listed", () => {
    expect(parseMinimaxModels(list("video-01", "music-2.5"), "minimax")).toEqual([]);
  });
});

describe("registry routing metadata", () => {
  it.each(PROVIDERS)(
    "%s: static MiniMax-M3 is claude-format; a live-only id gets no forced format",
    (provider) => {
      expect(getModelTargetFormat(provider, "MiniMax-M3")).toBe("claude");
      expect(getModelTargetFormat(provider, "MiniMax-M9")).toBeNull();
      expect(getModelSupportedFormats(provider, "MiniMax-M9")).toBeNull();
    },
  );
});

describe("live catalogs end to end", () => {
  it.each([
    ["minimax", "https://api.minimax.io/v1/models", "mm-test", "acme-global"],
    ["minimax-cn", "https://api.minimaxi.com/v1/models", "mm-cn-test", "acme-cn"],
  ])("%s lists from its host into the dashboard and /v1/models", async (provider, url, key, id) => {
    respond = () => Response.json(list("MiniMax-M2.7", id));
    const conn = await connect(provider, key);

    const body = await dashboardModels(conn.id);
    expect(body.warning).toBeUndefined();
    expect(body.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(["MiniMax-M2.7", id, "speech-2.8-hd"]),
    );
    expect(body.models.map((m) => m.id)).not.toContain("MiniMax-M2.1");
    expect(calls[0]).toEqual({ url, auth: `Bearer ${key}` });

    const alias = getProviderAlias(provider);
    expect((await buildModelsList(["llm"])).map((m) => m.id)).toContain(`${alias}/${id}`);
  });

  it("buildModelsList keeps kinds apart: chat excludes tts/dropped statics, tts and image list theirs", async () => {
    respond = () => Response.json(list("MiniMax-M2.7", "acme-chat"));
    await connect("minimax", "mm-kinds");
    await connect("minimax-cn", "mm-cn-kinds");
    const alias = getProviderAlias("minimax");
    const cnAlias = getProviderAlias("minimax-cn");

    const llm = (await buildModelsList(["llm"])).map((m) => m.id);
    expect(llm).toContain(`${alias}/acme-chat`);
    expect(llm).not.toContain(`${alias}/speech-2.8-hd`);
    expect(llm).not.toContain(`${alias}/MiniMax-M2.1`);

    const tts = (await buildModelsList(["tts"])).map((m) => m.id);
    expect(tts).toContain(`${alias}/speech-2.8-hd`);
    expect(tts).toContain(`${cnAlias}/speech-2.8-hd`);

    const image = (await buildModelsList(["image"])).map((m) => m.id);
    expect(image).toContain(`${alias}/minimax-image-01`);
  });

  it("200 with an empty list warns that no live models were returned", async () => {
    respond = () => Response.json({ object: "list", data: [] });
    const conn = await connect("minimax", "mm-empty");

    const body = await dashboardModels(conn.id);
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/returned no live models/);
  });

  it.each([
    ["minimax", "https://api.minimax.io/v1/models"],
    ["minimax-cn", "https://api.minimaxi.com/v1/models"],
  ])("%s failure returns no models with a key-free warning", async (provider, url) => {
    respond = () => new Response("bad key mm-secret", { status: 401 });
    const conn = await connect(provider, "mm-secret");

    const body = await dashboardModels(conn.id);
    expect(calls[0].url).toBe(url);
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/401/);
    expect(body.warning).not.toContain("mm-secret");
  });
});
