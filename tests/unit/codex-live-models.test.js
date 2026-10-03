// Live model catalog for OpenAI Codex (ChatGPT subscription) connections, as seen by
// the dashboard (GET /api/providers/[id]/models) and the gateway (/v1/models).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const tokenMocks = vi.hoisted(() => ({
  refreshCodexToken: vi.fn(),
  updateProviderCredentials: vi.fn(async () => true),
}));
vi.mock("@/sse/services/tokenRefresh", async (importOriginal) => ({
  ...(await importOriginal()),
  ...tokenMocks,
}));

import { GET } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import {
  createProviderConnectionUnscoped,
  deleteProviderConnectionsByProviderUnscoped,
} from "@/models/index.js";
import { getProviderAlias } from "@/shared/constants/providers";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import { parseCodexModels } from "@/lib/providerModels/codexModels.js";
import { CODEX_CLI_VERSION } from "open-sse/config/appConstants.js";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/models";

// Every static chat base id, so the "missing static ids" warning stays quiet by default.
const STATIC_BASE_IDS = getModelsByProviderId("codex")
  .filter(
    (m) =>
      (m.kind || m.type || "llm") === "llm" &&
      !m.id.endsWith("-review") &&
      m.upstreamModelId !== m.id,
  )
  .map((m) => m.id);

const entry = (slug, extra = {}) => ({
  slug,
  display_name: `Live ${slug}`,
  visibility: "list",
  base_instructions: "prompt",
  ...extra,
});
const catalog = (slugs, extra = []) => ({ models: [...slugs.map((s) => entry(s)), ...extra] });
const FULL = catalog(
  ["gpt-live-9", ...STATIC_BASE_IDS],
  [entry("gpt-hidden-9", { visibility: "hide" })],
);

let calls;
let respond;
beforeEach(async () => {
  calls = [];
  respond = () => Response.json(FULL);
  clearLiveModelsCache();
  tokenMocks.refreshCodexToken.mockReset();
  tokenMocks.updateProviderCredentials.mockClear();
  await deleteProviderConnectionsByProviderUnscoped("codex");
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (url, init) => {
    if (!String(url).startsWith(CODEX_URL)) return nativeFetch(url, init);
    calls.push({ url: String(url), headers: init.headers });
    return respond(init.headers);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const seedCodex = (extra = {}) =>
  createProviderConnectionUnscoped({
    provider: "codex",
    authType: "oauth",
    accessToken: `at-${Date.now()}-${Math.random()}`,
    refreshToken: "rt-codex",
    testStatus: "active",
    ...extra,
  });

async function dashboardModels(connectionId) {
  const res = await GET(new Request(`http://localhost/api/providers/${connectionId}/models`), {
    params: Promise.resolve({ id: connectionId }),
  });
  return { status: res.status, body: await res.json() };
}

describe("parseCodexModels", () => {
  it("maps upstream entries to slim models with review variants", () => {
    const models = parseCodexModels({
      models: [
        entry("gpt-x", { description: "d", context_window: 272000 }),
        entry("gpt-h", { visibility: "none" }),
        entry("gpt-img", { type: "image" }),
      ],
    });
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(Object.keys(byId)).toEqual([
      "gpt-x",
      "gpt-x-review",
      "gpt-h",
      "gpt-h-review",
      "gpt-img",
    ]);
    expect(byId["gpt-x"]).toEqual({
      id: "gpt-x",
      name: "Live gpt-x",
      description: "d",
      contextLength: 272000,
    });
    expect(byId["gpt-x-review"]).toMatchObject({
      upstreamModelId: "gpt-x",
      quotaFamily: "review",
    });
    expect(byId["gpt-h"].hidden).toBe(true);
    expect(byId["gpt-img"].kind).toBe("image");
  });
});

describe("Codex live models (dashboard)", () => {
  it("fetches with the CLI client_version and lists live + static extras, hiding hidden ids", async () => {
    const conn = await seedCodex();
    const { status, body } = await dashboardModels(conn.id);

    expect(status).toBe(200);
    expect(calls[0].url).toContain(`client_version=${CODEX_CLI_VERSION}`);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${conn.accessToken}`);
    expect(calls[0].headers.originator).toBe("codex_cli_rs");
    const ids = body.models.map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "gpt-live-9",
        "gpt-live-9-review",
        "gpt-image-2",
        "codex-auto-review",
      ]),
    );
    expect(ids).not.toContain("gpt-hidden-9");
    expect(body.warning).toBeUndefined();
  });

  it("refreshes the token on 401, persists it and retries", async () => {
    const conn = await seedCodex();
    tokenMocks.refreshCodexToken.mockResolvedValue({
      accessToken: "at-new",
      refreshToken: "rt-new",
    });
    respond = (headers) =>
      headers.Authorization === "Bearer at-new"
        ? Response.json(FULL)
        : new Response("expired", { status: 401 });

    const { body } = await dashboardModels(conn.id);

    expect(tokenMocks.refreshCodexToken).toHaveBeenCalledWith("rt-codex");
    expect(tokenMocks.updateProviderCredentials).toHaveBeenCalledWith(
      conn.id,
      expect.objectContaining({ accessToken: "at-new" }),
    );
    expect(body.models.map((m) => m.id)).toContain("gpt-live-9");
  });

  it("returns an empty list with a warning when upstream fails", async () => {
    const conn = await seedCodex();
    respond = () => new Response("down", { status: 500 });
    const { status, body } = await dashboardModels(conn.id);
    expect(status).toBe(200);
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/Failed to fetch Codex models: 500/);
  });

  it("warns to bump CODEX_CLI_VERSION when static ids are missing from the live list", async () => {
    const conn = await seedCodex();
    respond = () => Response.json(catalog(STATIC_BASE_IDS.filter((id) => id !== "gpt-5.5")));
    const { body } = await dashboardModels(conn.id);
    expect(body.warning).toMatch(/gpt-5\.5/);
    expect(body.warning).toMatch(/CODEX_CLI_VERSION/);
  });
});

describe("Codex live models (/v1/models)", () => {
  const alias = getProviderAlias("codex");

  it("lists live chat ids with review variants and hidden ids, keeping image models out", async () => {
    await seedCodex();
    const llm = (await buildModelsList(["llm"])).map((m) => m.id);
    expect(llm).toEqual(
      expect.arrayContaining([
        `${alias}/gpt-live-9`,
        `${alias}/gpt-live-9-review`,
        `${alias}/gpt-hidden-9`,
      ]),
    );
    expect(llm).not.toContain(`${alias}/gpt-image-2`);

    const image = (await buildModelsList(["image"])).map((m) => m.id);
    expect(image).toContain(`${alias}/gpt-image-2`);
  });

  it("skips the live fetch when the connection has explicit enabledModels", async () => {
    await seedCodex({ providerSpecificData: { enabledModels: ["gpt-5.5"] } });
    const llm = (await buildModelsList(["llm"])).map((m) => m.id);
    expect(calls).toHaveLength(0);
    expect(llm).toContain(`${alias}/gpt-5.5`);
  });
});
