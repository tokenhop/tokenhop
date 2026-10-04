/**
 * YAN-363 bounded video parity (active providers: xai/openrouter/vertex).
 *
 * Schema fixture policy: the gatewayVideoJobs table SQL lives in
 * src/lib/db/repos/gatewayVideoJobsRepo.js and is installed here explicitly
 * (fake adapter starts with the table present unless a test opts out). The
 * handler never creates schema at request time; caller migration activates it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE = "workspace-a";
const OTHER_WORKSPACE = "workspace-b";

const VIDEO_TABLE_SQL = `CREATE TABLE IF NOT EXISTS gatewayVideoJobs (
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  jobId TEXT NOT NULL,
  provider TEXT NOT NULL,
  connectionId TEXT NOT NULL,
  modelId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, provider, jobId)
)`;

// Minimal adapter stand-in: real repo functions run against it, so SQL shape
// and scoping stay the repo's own; only storage is in-memory.
function createVideoJobStore({ schema = true } = {}) {
  const jobs = new Map(); // `${workspaceId}|${provider}|${jobId}` -> row
  const connections = [];
  return {
    schema,
    jobs,
    connections,
    get(sql, params = []) {
      if (sql.startsWith("SELECT value FROM _meta")) {
        return { value: params[0] === "apiKeysHashedVersion" ? "1" : "0123456789abcdef" };
      }
      if (sql.includes("sqlite_master")) {
        return schema ? { name: "gatewayVideoJobs" } : undefined;
      }
      if (
        sql.startsWith(
          "SELECT * FROM gatewayVideoJobs WHERE workspaceId = ? AND provider = ? AND jobId = ?",
        )
      ) {
        return jobs.get(`${params[0]}|${params[1]}|${params[2]}`) || null;
      }
      return undefined;
    },
    all(sql, params = []) {
      if (sql.startsWith("SELECT * FROM providerConnections")) {
        return connections.filter((c) => c.workspaceId === params[0] && c.isActive === 1);
      }
      if (sql.startsWith("SELECT * FROM gatewayVideoJobs WHERE workspaceId = ? AND jobId = ?")) {
        return [...jobs.values()].filter(
          (r) => r.workspaceId === params[0] && r.jobId === params[1],
        );
      }
      return [];
    },
    run(sql, params = []) {
      if (sql.startsWith("INSERT INTO gatewayVideoJobs")) {
        const [workspaceId, jobId, provider, connectionId, modelId, createdAt] = params;
        jobs.set(`${workspaceId}|${provider}|${jobId}`, {
          workspaceId,
          jobId,
          provider,
          connectionId,
          modelId,
          createdAt,
        });
        return { changes: 1 };
      }
      return { changes: 0 };
    },
    transaction(fn) {
      return fn();
    },
    exec(sql) {
      if (sql === VIDEO_TABLE_SQL) this.schema = true;
    },
  };
}

const mocks = vi.hoisted(() => ({
  resolveGatewayAuth: vi.fn(),
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  getProviderConnectionByIdUnscoped: vi.fn(),
  getSettings: vi.fn(),
  markAccountUnavailable: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  fetch: vi.fn(),
  adapter: null,
}));

vi.mock("@/lib/auth/gatewayAuth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveGatewayAuth: mocks.resolveGatewayAuth,
}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: () => null,
  isValidApiKey: async () => false,
}));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: mocks.getModelInfo }));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getProviderConnectionByIdUnscoped: mocks.getProviderConnectionByIdUnscoped,
}));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: async () => mocks.adapter }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  maskKey: vi.fn(),
}));

import { handleVideoCreate, handleVideoGet } from "@/sse/handlers/videoGeneration.js";
import { header } from "@/shared/brand";

const principal = (overrides = {}) =>
  Object.freeze({
    via: "apiKey",
    apiKeyId: "key-a",
    workspaceId: WORKSPACE,
    userId: "user-a",
    scopes: Object.freeze({ allowedModels: [], allowedCombos: [] }),
    ...overrides,
  });
const restricted = (allowedModels) =>
  principal({ scopes: Object.freeze({ allowedModels, allowedCombos: [] }) });

const post = (raw, contentType = "application/json") =>
  new Request("http://localhost/v1/videos/generations", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: raw,
  });
const get = (jobId, headers = {}) =>
  new Request(`http://localhost/v1/videos/${jobId}`, { headers });

const upstreamJson = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
/** Queue exactly one expected upstream response from a helper-built body. */
const upstreamOnce = async (response) => {
  mocks.fetch.mockResolvedValueOnce(upstreamJson(JSON.parse(await response.clone().text())));
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveGatewayAuth.mockResolvedValue({ principal: principal(), legacy: false });
  mocks.adapter = createVideoJobStore(); // explicit schema fixture: table present
  mocks.getSettings.mockResolvedValue({ requireApiKey: false });
  mocks.getProviderConnectionByIdUnscoped.mockResolvedValue({ id: "conn-any", provider: "xai" });
  mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
  // Workspace-scoped model resolution stand-in: canonical provider/model only,
  // never for a foreign workspace.
  mocks.getModelInfo.mockImplementation(async (modelStr, _options) => {
    if (!String(modelStr).includes("/")) return { provider: "openai", model: modelStr };
    const [provider, model] = String(modelStr).split("/");
    if (!["xai", "openrouter", "vertex"].includes(provider)) return {};
    return { provider, model };
  });
  // Workspace-scoped credentials stand-in: same shape getProviderCredentials
  // enforces for gateway principals (foreign workspace resolves to nothing).
  // Legacy (no principal) keeps today's unscoped selection.
  mocks.getProviderCredentials.mockImplementation(async (provider, _exclude, _model, options) => {
    if (options?.principal) {
      if (options.principal.workspaceId !== WORKSPACE) return null;
      const id = options.preferredConnectionId || `conn-${provider}`;
      return { connectionId: id, connectionName: id, accessToken: `token-${provider}` };
    }
    const id = options?.preferredConnectionId || `conn-${provider}`;
    return { connectionId: id, connectionName: id, accessToken: `token-${provider}` };
  });
  global.fetch = mocks.fetch;
});

describe("gateway video create (hashed storage)", () => {
  const PROVIDERS = [
    ["xai", "xai/grok-video", "https://api.x.ai/v1/videos/generations"],
    ["openrouter", "openrouter/veo", "https://openrouter.ai/api/v1/videos"],
  ];

  it.each(PROVIDERS)(
    "%s: scopes canonical model, records provenance, no format break",
    async (provider, modelId, url) => {
      mocks.resolveGatewayAuth.mockResolvedValue({ principal: principal(), legacy: false });
      await upstreamOnce(upstreamJson({ request_id: `${provider}-job`, status: "pending" }));

      const response = await handleVideoCreate(
        post(JSON.stringify({ model: modelId, prompt: "a cat" })),
        "generations",
      );

      expect(response.status).toBe(200);
      expect(mocks.getModelInfo).toHaveBeenCalledWith(modelId, { principal: principal() });
      expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
        provider,
        expect.any(Set),
        modelId.split("/")[1],
        expect.objectContaining({ principal: principal() }),
      );
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      const [fetchUrl, init] = mocks.fetch.mock.calls[0];
      expect(fetchUrl).toBe(url);
      expect(JSON.parse(init.body)).toEqual({ model: modelId.split("/")[1], prompt: "a cat" });
      // Response stays intact after the provenance clone: body + connection header.
      expect(await response.json()).toEqual({ request_id: `${provider}-job`, status: "pending" });
      expect(response.headers.get(header("connection-id"))).toBe(`conn-${provider}`);
      const rows = mocks.adapter.jobs;
      expect(rows.size).toBe(1);
      expect([...rows.values()][0]).toMatchObject({
        workspaceId: WORKSPACE,
        jobId: `${provider}-job`,
        provider,
        connectionId: `conn-${provider}`,
        modelId,
      });
    },
  );

  it("vertex: mapped id is the authoritative upstream name (base64url operation)", async () => {
    mocks.resolveGatewayAuth.mockResolvedValue({ principal: principal(), legacy: false });
    const operationName =
      "projects/p1/locations/us-central1/publishers/google/models/veo-3/operations/op-9";
    mocks.fetch.mockResolvedValueOnce(upstreamJson({ name: operationName }));
    mocks.getProviderCredentials.mockResolvedValueOnce({
      connectionId: "conn-vertex",
      connectionName: "vertex",
      accessToken: "tok",
      projectId: "p1",
    });

    const response = await handleVideoCreate(
      post(JSON.stringify({ model: "vertex/veo-3", prompt: "a cat" })),
      "generations",
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const expectedId = Buffer.from(operationName, "utf8").toString("base64url");
    expect(body.id).toBe(expectedId);
    // Create URL carries the decoded authoritative name's model segment only.
    expect(mocks.fetch.mock.calls[0][0]).toContain(
      "/publishers/google/models/veo-3:predictLongRunning",
    );
    expect([...mocks.adapter.jobs.values()][0]).toMatchObject({
      workspaceId: WORKSPACE,
      jobId: expectedId,
      provider: "vertex",
      connectionId: "conn-vertex",
      modelId: "vertex/veo-3",
    });
  });

  it("restricted key: allowed model passes, forbidden model is denied before any upstream", async () => {
    mocks.resolveGatewayAuth.mockResolvedValue({
      principal: restricted(["xai/grok-video"]),
      legacy: false,
    });
    await upstreamOnce(upstreamJson({ request_id: "job-ok" }));
    expect(
      (
        await handleVideoCreate(
          post(JSON.stringify({ model: "xai/grok-video", prompt: "x" })),
          "generations",
        )
      ).status,
    ).toBe(200);

    mocks.fetch.mockClear();
    mocks.getProviderCredentials.mockClear();
    expect(
      (
        await handleVideoCreate(
          post(JSON.stringify({ model: "xai/other-video", prompt: "x" })),
          "generations",
        )
      ).status,
    ).toBe(403);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("cross-workspace key resolves zero workspace connections, zero upstream calls", async () => {
    mocks.resolveGatewayAuth.mockResolvedValue({
      principal: principal({ workspaceId: OTHER_WORKSPACE }),
      legacy: false,
    });
    await upstreamOnce(upstreamJson({ request_id: "job-x" }));
    const response = await handleVideoCreate(
      post(JSON.stringify({ model: "xai/grok-video", prompt: "x" })),
      "generations",
    );
    expect(response.status).toBe(400);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderCredentials.mock.calls[0][3].principal.workspaceId).toBe(
      OTHER_WORKSPACE,
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("multipart: bare model sniffed for scope, bytes forwarded byte-exact", async () => {
    mocks.resolveGatewayAuth.mockResolvedValue({
      principal: restricted(["xai/grok-video"]),
      legacy: false,
    });
    await upstreamOnce(upstreamJson({ request_id: "mp-1" }));
    const boundary = "----gatewayVideoBoundary";
    const field = (name, value) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const raw = `${field("model", "grok-video")}${field("prompt", "edit")}--${boundary}--\r\n`;

    const response = await handleVideoCreate(
      post(raw, `multipart/form-data; boundary=${boundary}`),
      "edits",
    );

    expect(response.status).toBe(200);
    // Bare multipart id resolves through the default video provider scope.
    expect(mocks.getModelInfo).toHaveBeenCalledWith(
      "grok-video",
      expect.objectContaining({ principal: expect.anything() }),
    );
    const [, init] = mocks.fetch.mock.calls[0];
    expect(Buffer.from(init.body).toString()).toBe(raw); // original bytes, boundary intact
  });

  it("multipart: prefixed model rejected; duplicate model parts are 400 for any key, zero upstream", async () => {
    mocks.resolveGatewayAuth.mockResolvedValue({
      principal: restricted(["xai/grok-video"]),
      legacy: false,
    });
    const boundary = "----gatewayVideoPrefixed";
    const field = (name, value) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    // Prefixed model cannot be stripped without re-encoding the body.
    const prefixed = `${field("model", "xai/grok-video")}${field("prompt", "x")}--${boundary}--\r\n`;
    expect(
      (
        await handleVideoCreate(
          post(prefixed, `multipart/form-data; boundary=${boundary}`),
          "edits",
        )
      ).status,
    ).toBe(400);

    // Duplicate model parts: ambiguous — 400 for a restricted key...
    const duplicated = `${field("model", "grok-video")}${field("model", "other-video")}--${boundary}--\r\n`;
    expect(
      (
        await handleVideoCreate(
          post(duplicated, `multipart/form-data; boundary=${boundary}`),
          "edits",
        )
      ).status,
    ).toBe(400);

    // ...and for an UNRESTRICTED key too: never forwarded (upstream parsers
    // may be last-wins on a billable job), never any upstream/credential call.
    mocks.resolveGatewayAuth.mockResolvedValue({ principal: principal(), legacy: false });
    mocks.fetch.mockClear();
    mocks.getProviderCredentials.mockClear();
    expect(
      (
        await handleVideoCreate(
          post(duplicated, `multipart/form-data; boundary=${boundary}`),
          "edits",
        )
      ).status,
    ).toBe(400);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.adapter.jobs.size).toBe(0);
  });

  it("multipart without model: restricted key denied as ambiguous, unrestricted passes", async () => {
    const boundary = "----gatewayVideoNoModel";
    const raw = `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nedit\r\n--${boundary}--\r\n`;
    mocks.resolveGatewayAuth.mockResolvedValue({
      principal: restricted(["xai/grok-video"]),
      legacy: false,
    });
    expect(
      (await handleVideoCreate(post(raw, `multipart/form-data; boundary=${boundary}`), "edits"))
        .status,
    ).toBe(403);

    mocks.resolveGatewayAuth.mockResolvedValue({ principal: principal(), legacy: false });
    await upstreamOnce(upstreamJson({ request_id: "mp-2" }));
    expect(
      (await handleVideoCreate(post(raw, `multipart/form-data; boundary=${boundary}`), "edits"))
        .status,
    ).toBe(200);
  });

  it("provenance record failure never fails an accepted job, and poll then denies restricted keys", async () => {
    mocks.resolveGatewayAuth.mockResolvedValue({ principal: principal(), legacy: false });
    await upstreamOnce(upstreamJson({ request_id: "recfail-1" }));
    const failingRun = mocks.adapter.run.bind(mocks.adapter);
    mocks.adapter.run = (sql, params) => {
      if (sql.startsWith("INSERT INTO gatewayVideoJobs")) {
        throw new Error("disk I/O error");
      }
      return failingRun(sql, params);
    };

    const response = await handleVideoCreate(
      post(JSON.stringify({ model: "xai/grok-video", prompt: "x" })),
      "generations",
    );

    expect(response.status).toBe(200); // accepted job survives the record failure
    expect(mocks.adapter.jobs.size).toBe(0);
    // Unmapped + restricted key: denied ambiguous; unrestricted key may poll
    // via its own workspace credentials (approved legacy exception).
    mocks.resolveGatewayAuth.mockResolvedValue({
      principal: restricted(["xai/grok-video"]),
      legacy: false,
    });
    expect((await handleVideoGet(get("recfail-1"), "recfail-1")).status).toBe(403);
  });

  it("creation rotation records provenance for the connection that actually served", async () => {
    mocks.resolveGatewayAuth.mockResolvedValue({ principal: principal(), legacy: false });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.getProviderCredentials
      .mockResolvedValueOnce({
        connectionId: "conn-xai-1",
        connectionName: "one",
        accessToken: "token-1",
      })
      .mockResolvedValueOnce({
        connectionId: "conn-xai-2",
        connectionName: "two",
        accessToken: "token-2",
      });
    mocks.fetch
      .mockResolvedValueOnce(upstreamJson({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(upstreamJson({ request_id: "rot-1", status: "pending" }));

    const response = await handleVideoCreate(
      post(JSON.stringify({ model: "xai/grok-video", prompt: "x" })),
      "generations",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get(header("connection-id"))).toBe("conn-xai-2");
    const row = [...mocks.adapter.jobs.values()][0];
    expect(row).toMatchObject({ jobId: "rot-1", provider: "xai", connectionId: "conn-xai-2" });
  });

  it("missing job store fails closed (503) before the billable upstream call", async () => {
    mocks.resolveGatewayAuth.mockResolvedValue({ principal: principal(), legacy: false });
    mocks.adapter = createVideoJobStore({ schema: false });
    expect(
      (
        await handleVideoCreate(
          post(JSON.stringify({ model: "xai/grok-video", prompt: "x" })),
          "generations",
        )
      ).status,
    ).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe("gateway video poll (hashed storage)", () => {
  async function createJob(modelId, jobId = "job-1", provider = modelId.split("/")[0]) {
    mocks.resolveGatewayAuth.mockResolvedValue({ principal: principal(), legacy: false });
    await upstreamOnce(upstreamJson({ request_id: jobId, status: "pending" }));
    expect(
      (
        await handleVideoCreate(
          post(JSON.stringify({ model: modelId, prompt: "x" })),
          "generations",
        )
      ).status,
    ).toBe(200);
    mocks.fetch.mockReset();
    mocks.getProviderCredentials.mockClear(); // poll assertions count only the poll
    return provider;
  }

  it("known mapping: same workspace + current key model → poll via recorded connection", async () => {
    await createJob("xai/grok-video", "poll-1");
    mocks.fetch.mockResolvedValueOnce(upstreamJson({ status: "pending", progress: 10 }));

    const response = await handleVideoGet(get("poll-1"), "poll-1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "pending", progress: 10 });
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "xai",
      null,
      "grok-video",
      expect.objectContaining({ preferredConnectionId: "conn-xai", principal: principal() }),
    );
    expect(mocks.fetch.mock.calls[0][0]).toBe("https://api.x.ai/v1/videos/poll-1");
    expect(response.headers.get(header("connection-id"))).toBe("conn-xai");
  });

  it("known mapping: restricted key without the recorded model is denied, no upstream", async () => {
    await createJob("xai/grok-video", "poll-2");
    mocks.resolveGatewayAuth.mockResolvedValue({
      principal: restricted(["vertex/veo-3"]),
      legacy: false,
    });
    expect((await handleVideoGet(get("poll-2"), "poll-2")).status).toBe(403);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("known mapping: header naming a different connection never rebinds the job", async () => {
    await createJob("xai/grok-video", "poll-3");
    expect(
      (await handleVideoGet(get("poll-3", { "x-connection-id": "conn-other" }), "poll-3")).status,
    ).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("ambiguous duplicate mappings are denied without global fallback", async () => {
    mocks.adapter.jobs.set(`${WORKSPACE}|xai|dup`, {
      workspaceId: WORKSPACE,
      jobId: "dup",
      provider: "xai",
      connectionId: "conn-xai",
      modelId: "xai/grok-video",
      createdAt: new Date().toISOString(),
    });
    mocks.adapter.jobs.set(`${WORKSPACE}|openrouter|dup`, {
      workspaceId: WORKSPACE,
      jobId: "dup",
      provider: "openrouter",
      connectionId: "conn-openrouter",
      modelId: "openrouter/veo",
      createdAt: new Date().toISOString(),
    });
    expect((await handleVideoGet(get("dup"), "dup")).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("unmapped job: unrestricted key polls via workspace-owned connection only", async () => {
    mocks.resolveGatewayAuth.mockResolvedValue({ principal: principal(), legacy: false });
    // Unrestricted key, no header: default provider with workspace credentials.
    mocks.fetch.mockResolvedValueOnce(upstreamJson({ status: "pending" }));
    expect((await handleVideoGet(get("unmapped-1"), "unmapped-1")).status).toBe(200);

    // Unrestricted key, header pinned to a connection NOT owned by the
    // workspace: resolves to nothing — deny, never a global fallback.
    mocks.fetch.mockClear();
    mocks.getProviderCredentials.mockClear();
    expect(
      (await handleVideoGet(get("unmapped-2", { "x-connection-id": "conn-xai" }), "unmapped-2"))
        .status,
    ).toBe(403);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("unmapped job: restricted key is denied as ambiguous, no upstream", async () => {
    mocks.resolveGatewayAuth.mockResolvedValue({
      principal: restricted(["xai/grok-video"]),
      legacy: false,
    });
    expect((await handleVideoGet(get("unmapped-3"), "unmapped-3")).status).toBe(403);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("cross-workspace lookup is scoped: a foreign id is unmapped, own creds still apply", async () => {
    await createJob("xai/grok-video", "foreign-1");
    mocks.resolveGatewayAuth.mockResolvedValue({
      principal: principal({ workspaceId: OTHER_WORKSPACE }),
      legacy: false,
    });
    // Foreign id: unmapped here, unrestricted → default provider via OWN (empty)
    // workspace → 400, zero upstream. Proves no cross-workspace credential use.
    expect((await handleVideoGet(get("foreign-1"), "foreign-1")).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
    // Same id with a foreign connection pin: denied before credentials.
    mocks.getProviderCredentials.mockClear();
    expect(
      (await handleVideoGet(get("foreign-1", { "x-connection-id": "conn-xai" }), "foreign-1"))
        .status,
    ).toBe(403);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });
});

describe("legacy video behavior (pristine)", () => {
  it("legacy storage keeps today's auth, unscoped routing, and records no provenance", async () => {
    // Legacy storage: no hashed markers → resolveVideoAuth takes the original
    // requireValidApiKey path (settings requireApiKey=false via mocked localDb).
    const legacyAdapter = createVideoJobStore();
    legacyAdapter.get = (sql, params = []) => {
      if (sql.startsWith("SELECT value FROM _meta")) return undefined; // no markers
      return createVideoJobStore().get(sql, params);
    };
    mocks.adapter = legacyAdapter;
    await upstreamOnce(upstreamJson({ request_id: "legacy-job" }));

    const response = await handleVideoCreate(
      post(JSON.stringify({ model: "xai/grok-video", prompt: "x" })),
      "generations",
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveGatewayAuth).not.toHaveBeenCalled(); // legacy never resolves a principal
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "xai",
      expect.any(Set),
      "grok-video",
      expect.not.objectContaining({ principal: expect.anything() }),
    );
    expect(mocks.adapter.jobs.size).toBe(0); // no provenance recorded in legacy mode
    expect(response.headers.get(header("connection-id"))).toBe("conn-xai");

    // Legacy poll: unscoped provider resolution via the connection-id header.
    mocks.getProviderConnectionByIdUnscoped.mockResolvedValue({ id: "conn-5", provider: "xai" });
    mocks.fetch.mockResolvedValueOnce(upstreamJson({ status: "pending" }));
    expect(
      (await handleVideoGet(get("legacy-job", { "x-connection-id": "conn-5" }), "legacy-job"))
        .status,
    ).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenLastCalledWith(
      "xai",
      null,
      null,
      expect.objectContaining({ preferredConnectionId: "conn-5" }),
    );
  });
});
