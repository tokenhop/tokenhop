// YAN-378: images/search/speech/transcriptions/video create route parity,
// video provenance polling and models/info. Metering/voice catalogs and chat
// families live in tenant-isolation-gateway.test.js; controls in its sibling.
// Caller ID echoes alone may be normalized; routing/auth/resources remain real.
// No latency benchmark; static registry metadata is public, not tenant data.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, fetchCalls, savedEnv } = vi.hoisted(() => {
  const savedEnv = {
    TOKENHOP_MULTI_USER: process.env.TOKENHOP_MULTI_USER,
    TOKENHOP_MASTER_KEY: process.env.TOKENHOP_MASTER_KEY,
  };
  process.env.TOKENHOP_MULTI_USER = "on";
  return { executeMock: vi.fn(), fetchCalls: [], savedEnv };
});
vi.stubGlobal(
  "fetch",
  vi.fn(async (url, init) => {
    fetchCalls.push({ url: String(url), headers: new Headers(init?.headers) });
    return Response.json({ data: [] });
  }),
);
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute: executeMock }),
}));
vi.mock("@/lib/providerModels/liveResolvers.js", async (importOriginal) => ({
  ...(await importOriginal()),
  hasLiveModelResolver: () => false,
}));

import { POST as imagesPost } from "@/app/api/v1/images/generations/route.js";
import { POST as searchPost } from "@/app/api/v1/search/route.js";
import { POST as speechPost } from "@/app/api/v1/audio/speech/route.js";
import { POST as transcriptionsPost } from "@/app/api/v1/audio/transcriptions/route.js";
import { POST as videoPost } from "@/app/api/v1/videos/generations/route.js";
import { POST as videoEditsPost } from "@/app/api/v1/videos/edits/route.js";
import { POST as videoExtensionsPost } from "@/app/api/v1/videos/extensions/route.js";
import { GET as videoGet } from "@/app/api/v1/videos/[id]/route.js";
import { GET as modelInfoGet } from "@/app/api/v1/models/info/route.js";
import { recordGatewayVideoJobSync } from "@/lib/db/repos/gatewayVideoJobsRepo.js";
import {
  TOKEN_A,
  TOKEN_B,
  post,
  req,
  restoreEnv,
  seedGatewayWorld,
} from "../helpers/tenantIsolation/gatewayWorld.js";

let world;
beforeEach(async () => {
  fetchCalls.length = 0;
  executeMock.mockReset();
  world = await seedGatewayWorld();
});
afterAll(() => restoreEnv(savedEnv));

const jsonCall = (handler, path, fields) => (model) =>
  handler(post(`http://localhost/v1/${path}`, { ...fields, model }));
const transcription = (model) => {
  const body = new FormData();
  body.set("model", model);
  body.set("file", new Blob(["audio"], { type: "audio/wav" }), "sample.wav");
  return transcriptionsPost(
    new Request("http://localhost/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN_B}` },
      body,
    }),
  );
};
const noCredentials = "No credentials for provider: openai";
const noVideoCredentials = "No credentials for provider: xai";
const routes = [
  [
    "images/generations",
    jsonCall(imagesPost, "images/generations", { prompt: "hi" }),
    noCredentials,
  ],
  ["search", jsonCall(searchPost, "search", { query: "hi" }), (id) => `Unknown provider: ${id}`],
  [
    "audio/speech",
    jsonCall(speechPost, "audio/speech", { input: "hi", voice: "alloy" }),
    noCredentials,
  ],
  ["audio/transcriptions", transcription, noCredentials],
  [
    "videos/generations",
    jsonCall(videoPost, "videos/generations", { prompt: "hi" }),
    noVideoCredentials,
  ],
  [
    "videos/edits",
    jsonCall(videoEditsPost, "videos/edits", {
      prompt: "hi",
      video: { url: "https://example.test/video.mp4" },
    }),
    noVideoCredentials,
  ],
  [
    "videos/extensions",
    jsonCall(videoExtensionsPost, "videos/extensions", {
      prompt: "hi",
      video: { url: "https://example.test/video.mp4" },
    }),
    noVideoCredentials,
  ],
];

describe("additional workspace-scoped entry points", () => {
  it.each(routes)(
    "%s: scoped name parity without dispatch",
    async (_path, call, expectedMessage) => {
      const unknown = "unknown-w1";
      const normalize = (body, id) => JSON.stringify(body).replaceAll(id, "<id>");
      for (const name of ["combo-w1", "alias-w1"]) {
        const other = await call(name);
        const missing = await call(unknown);
        const otherBody = await other.json();
        const missingBody = await missing.json();
        expect(other.status).toBe(400);
        expect(missing.status).toBe(400);
        const message = (id) =>
          typeof expectedMessage === "function" ? expectedMessage(id) : expectedMessage;
        expect(otherBody.error.message).toBe(message(name));
        expect(missingBody.error.message).toBe(message(unknown));
        expect(normalize(otherBody, name)).toBe(normalize(missingBody, unknown));
        expect(fetchCalls).toEqual([]);
        expect(executeMock).not.toHaveBeenCalled();
      }
    },
  );

  it("video creation ignores another workspace's connection pin without dispatch", async () => {
    world.conn("conn-video-w1", "xai", "wA");
    const request = post("http://localhost/v1/videos/generations", {
      model: "xai/grok-imagine-video",
      prompt: "hi",
    });
    request.headers.set("x-connection-id", "conn-video-w1");
    const response = await videoPost(request);
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe(noVideoCredentials);
    expect(fetchCalls).toEqual([]);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("models/info: other-workspace custom model and unknown id answer the same", async () => {
    const id = "openai/custom-w1-model";
    const missingId = "openai/unknown-w1";
    const other = await modelInfoGet(
      req(`http://localhost/v1/models/info?id=${encodeURIComponent(id)}`),
    );
    const missing = await modelInfoGet(
      req(`http://localhost/v1/models/info?id=${encodeURIComponent(missingId)}`),
    );
    const otherBody = await other.json();
    const missingBody = await missing.json();
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(JSON.stringify(otherBody).replaceAll(id, "<id>")).toBe(
      JSON.stringify(missingBody).replaceAll(missingId, "<id>"),
    );
    expect(fetchCalls).toEqual([]);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("models/info: built-in registry metadata is identical for both workspaces' keys", async () => {
    // Public static registry data, not tenant data; same body regardless of
    // which workspace owns an openai connection.
    const url = "http://localhost/v1/models/info?id=openai%2Fgpt-4o";
    const fromB = await modelInfoGet(req(url, TOKEN_B));
    const fromA = await modelInfoGet(req(url, TOKEN_A));
    expect(fromB.status).toBe(200);
    expect(await fromB.json()).toEqual(await fromA.json());
    expect(fetchCalls).toEqual([]);
  });

  it("videos/[id]: scoped provenance parity without dispatch", async () => {
    world.conn("conn-video-w1", "xai", "wA");
    recordGatewayVideoJobSync(world.db, {
      workspaceId: "wA",
      jobId: "job-w1",
      provider: "xai",
      connectionId: "conn-video-w1",
      modelId: "xai/grok-imagine-video",
    });
    const call = (id) =>
      videoGet(req(`http://localhost/v1/videos/${id}`), {
        params: Promise.resolve({ id }),
      });
    const other = await call("job-w1");
    const missing = await call("unknown-w1");
    expect(other.status).toBe(400);
    expect(missing.status).toBe(400);
    const body = await other.json();
    expect(body.error.message).toBe(noVideoCredentials);
    expect(body).toEqual(await missing.json());
    expect(fetchCalls).toEqual([]);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
