import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SENT, SCAN, NO_LEAKS } from "../helpers/tenantSecretFixture.js";
import { collectFilesText, findSecretLeaks, leakSummary } from "../helpers/secretScan.js";
import { collectCredentialSecrets } from "../../open-sse/utils/redact.js";

// ─── 3. Deep request logger file output ───────────────────────────────────

describe("deep request logger file output", () => {
  const savedFlag = process.env.ENABLE_REQUEST_LOGS;
  const savedCwd = process.cwd();
  let tmp;
  let logsDir;
  let loggerModule;

  beforeAll(async () => {
    process.env.ENABLE_REQUEST_LOGS = "true";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sent378-logs-"));
    process.chdir(tmp);
    logsDir = path.join(tmp, "logs");
    vi.resetModules();
    loggerModule = await import("open-sse/utils/requestLogger.js");
  });

  afterAll(() => {
    loggerModule.notifyRequestLogsEnabled(false);
    process.chdir(savedCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedFlag === undefined) delete process.env.ENABLE_REQUEST_LOGS;
    else process.env.ENABLE_REQUEST_LOGS = savedFlag;
  });

  async function freshLogger(tag) {
    fs.rmSync(logsDir, { recursive: true, force: true });
    const logger = await loggerModule.createRequestLogger("openai", "openai", `sent378-${tag}`);
    expect(logger.sessionPath, "logging session must be created").toBeTruthy();
    return logger;
  }

  // Opaque base64 under `input` is not identifiable as a credential. Keep it
  // as a positive control here; DB/response scans still use every sentinel.
  const loggerSentinels = Object.fromEntries(
    Object.entries(SCAN).filter(([name]) => name !== "base64Hash"),
  );
  const logLeaks = () =>
    collectFilesText(logsDir).flatMap((f) =>
      findSecretLeaks(f.text, { sentinels: loggerSentinels, shapes: ["jwt"] }).map((l) => ({
        ...l,
        at: `${f.name}:${l.at}`,
      })),
    );

  it("masks credential headers in request log files", async () => {
    const logger = await freshLogger("headers");
    logger.logClientRawRequest(
      "/v1/chat/completions",
      { model: "sent378-model" },
      {
        authorization: `Bearer ${SENT.bearerJwt}`,
        "x-api-key": SENT.connectionApiKey,
        cookie: `session=${SENT.password}`,
      },
    );
    logger.logTargetRequest(
      "https://upstream.example/v1/chat/completions",
      { "x-goog-api-key": SENT.oauthAccessToken },
      { model: "sent378-model" },
    );
    logger.logProviderResponse(200, "OK", { "set-cookie": SENT.password }, { ok: true });
    expect(leakSummary(logLeaks()), `logged headers: ${NO_LEAKS}`).toBe("");
  });

  it("redacts credential values in logged request bodies", async () => {
    const logger = await freshLogger("bodies");
    logger.logClientRawRequest(
      "/v1/chat/completions",
      { model: "m", apiKey: SENT.connectionApiKey, nested: { token: SENT.oauthRefreshToken } },
      {},
    );
    logger.logRawRequest(
      { messages: [{ role: "user", content: `key ${SENT.oauthAccessToken}` }] },
      {},
    );
    logger.logOpenAIRequest({ metadata: { bearer: SENT.bearerJwt } });
    logger.logTargetRequest(
      "https://upstream.example/v1",
      {},
      {
        input: SENT.base64Hash,
        api_key: SENT.oauthAccessToken,
      },
    );
    expect(leakSummary(logLeaks()), `logged bodies: ${NO_LEAKS}`).toBe("");
    expect(
      JSON.parse(fs.readFileSync(path.join(logger.sessionPath, "4_req_target.json"), "utf8")).body
        .input,
    ).toBe(SENT.base64Hash);
  });

  it("redacts credential values in logged upstream URL query strings", async () => {
    const logger = await freshLogger("urlquery");
    logger.logTargetRequest(
      `https://upstream.example/v1/models?key=${encodeURIComponent(SENT.connectionApiKey)}&token=${encodeURIComponent(SENT.oauthRefreshToken)}`,
      {},
      { model: "m" },
    );
    expect(leakSummary(logLeaks()), `logged URL query: ${NO_LEAKS}`).toBe("");
  });

  it("redacts credential values in logged raw stream chunks", async () => {
    const logger = await freshLogger("chunks");
    logger.appendProviderChunk(`data: {"token":"${SENT.oauthAccessToken}"}\n\n`);
    logger.appendOpenAIChunk(`data: ${SENT.bearerJwt}\n\n`);
    logger.appendConvertedChunk(`data: ${SENT.oauthRefreshToken}\n\n`);
    expect(leakSummary(logLeaks()), `logged chunks: ${NO_LEAKS}`).toBe("");
  });

  it("keeps benign fields and project names while masking credentials", async () => {
    const logger = await freshLogger("benign");
    const body = {
      max_tokens: 4096,
      usage: { prompt_tokens: 7 },
      thinking: { type: "enabled", budget_tokens: 2048 },
      content: [{ type: "thinking", thinking: "x", signature: "EqoBCkgIABICGAJAAkACAA" }],
      note: "sk-learn-project-alpha",
      prose: "discuss key=token values in chat prose",
      apiKey: SENT.connectionApiKey,
    };
    const snapshot = structuredClone(body);
    logger.logTargetRequest("https://upstream.example/v1", {}, body);
    expect(body).toEqual(snapshot);
    const text = collectFilesText(logsDir)
      .map((f) => f.text)
      .join("\n");
    const logged = JSON.parse(
      fs.readFileSync(path.join(logger.sessionPath, "4_req_target.json"), "utf8"),
    ).body;
    expect(logged.max_tokens).toBe(4096);
    expect(logged.usage.prompt_tokens).toBe(7);
    expect(logged.thinking.budget_tokens).toBe(2048);
    for (const kept of [
      "4096",
      "2048",
      "EqoBCkgIABICGAJAAkACAA",
      "sk-learn-project-alpha",
      body.prose,
    ]) {
      expect(text, kept).toContain(kept);
    }
    expect(text).not.toContain(SENT.connectionApiKey);
  });

  // providerSpecificData.apiKey is opaque. Exact provenance, as chatCore passes
  // it, redacts non-credential-named echoes; the same writes without provenance
  // retain it (negative control), proving the assertion is not vacuous.
  it("known-secret provenance masks opaque request-local secrets", async () => {
    const opaque = SENT.base64Hash;
    const write = (logger) => {
      logger.logClientRawRequest("/v1/chat/completions", { echo: opaque }, {});
      logger.appendProviderChunk(`data: ${opaque}\n\n`);
      logger.logError(new Error(`upstream connect failed for ${opaque}`), { echo: opaque });
    };
    const textOf = () =>
      collectFilesText(logsDir)
        .map((f) => f.text)
        .join("\n");

    fs.rmSync(logsDir, { recursive: true, force: true });
    const control = await loggerModule.createRequestLogger("openai", "openai", "sent378-no-prov");
    write(control);
    expect(textOf(), "negative control must retain opaque value").toContain(opaque);

    fs.rmSync(logsDir, { recursive: true, force: true });
    const logger = await loggerModule.createRequestLogger("openai", "openai", "sent378-known", {
      secrets: [opaque],
    });
    expect(logger.sessionPath, "logging session must be created").toBeTruthy();
    write(logger);
    expect(textOf()).not.toContain(opaque);
  });

  it("masks URL/JSON-encoded opaque request credentials in text sinks", async () => {
    fs.rmSync(logsDir, { recursive: true, force: true });
    const opaque = 'opaque/+==quote"slash\\suffix';
    const encoded = encodeURIComponent(opaque);
    const jsonEscaped = JSON.stringify(opaque).slice(1, -1);
    const logger = await loggerModule.createRequestLogger("openai", "openai", "encoded", {
      secrets: [opaque],
    });
    expect(logger.sessionPath).toBeTruthy();
    logger.logTargetRequest(
      `https://u.test/${encoded}`,
      { "x-note": encoded },
      { echo: jsonEscaped },
    );
    logger.appendProviderChunk(`data: ${jsonEscaped}`);
    logger.logError(new Error(encoded), { echo: opaque });
    const text = collectFilesText(logsDir)
      .map((f) => f.text)
      .join("\n");
    for (const form of [opaque, encoded, jsonEscaped, JSON.stringify(jsonEscaped).slice(1, -1)]) {
      expect(text).not.toContain(form);
    }
  });

  it("psd.cookie opaque echoes are redacted via credential provenance; metadata kept", async () => {
    fs.rmSync(logsDir, { recursive: true, force: true });
    const cookie = "opaque-psd-cookie-ZZ77";
    const credentials = {
      connectionName: "Team Connection",
      providerSpecificData: { cookie, region: "us-east-1" },
    };
    const logger = await loggerModule.createRequestLogger("openai", "openai", "psd", {
      secrets: () => collectCredentialSecrets(credentials),
    });
    expect(logger.sessionPath).toBeTruthy();
    logger.logRawRequest({ echo: cookie, region: "us-east-1", name: "Team Connection" });
    logger.appendProviderChunk(`data: ${cookie}\n\n`);
    logger.logError(new Error(`failed ${cookie}`), { note: cookie });
    const text = collectFilesText(logsDir)
      .map((f) => f.text)
      .join("\n");
    expect(text).not.toContain(cookie);
    expect(text).toContain("us-east-1");
    expect(text).toContain("Team Connection");
  });

  it("live provenance covers credentials refreshed after logger creation", async () => {
    fs.rmSync(logsDir, { recursive: true, force: true });
    const credentials = { apiKey: "initial-opaque-key-ZZ00" };
    const logger = await loggerModule.createRequestLogger("openai", "openai", "live", {
      secrets: () => [credentials.apiKey],
    });
    expect(logger.sessionPath).toBeTruthy();
    logger.logRawRequest({ echo: credentials.apiKey });
    credentials.apiKey = 'refreshed/+opaque"key-ZZ99';
    logger.logTargetRequest(
      `https://u.test/${encodeURIComponent(credentials.apiKey)}`,
      {},
      {
        echo: credentials.apiKey,
      },
    );
    logger.appendProviderChunk(`data: ${credentials.apiKey}`);
    logger.logError(new Error(credentials.apiKey), { echo: credentials.apiKey });
    const text = collectFilesText(logsDir)
      .map((f) => f.text)
      .join("\n");
    expect(text).not.toContain("initial-opaque-key-ZZ00");
    expect(text).not.toContain(credentials.apiKey);
    expect(text).not.toContain(encodeURIComponent(credentials.apiKey));
  });

  it("scrubs non-sensitive header values and referer URLs", async () => {
    const logger = await freshLogger("header-values");
    logger.logClientRawRequest(
      "/v1/chat/completions",
      {},
      {
        "x-forwarded-note": `has ${SENT.connectionApiKey}`,
        referer: `https://app.example/p?token=${SENT.oauthRefreshToken}`,
        "x-request-id": "plain-id",
      },
    );
    expect(leakSummary(logLeaks()), `header values: ${NO_LEAKS}`).toBe("");
    expect(
      collectFilesText(logsDir)
        .map((f) => f.text)
        .join("\n"),
    ).toContain("plain-id");
  });

  it("legacy logError redacts url, message, stack and body and never throws", async () => {
    const legacyLogger = await freshLogger("legacy");
    const err = new Error(`bad ${SENT.connectionApiKey}`);
    expect(() =>
      loggerModule.logError("prov", {
        error: err,
        url: `https://u.example/x?key=${SENT.oauthAccessToken}`,
        model: "m",
        requestBody: { apiKey: SENT.connectionApiKey, jwt: SENT.bearerJwt },
      }),
    ).not.toThrow();
    expect(leakSummary(logLeaks()), `legacy logError: ${NO_LEAKS}`).toBe("");
    expect(legacyLogger.sessionPath).toBeTruthy();
  });

  it("redacts the raw Vertex ?key= URL produced by VertexExecutor.buildUrl", async () => {
    const { VertexExecutor } = await import("open-sse/executors/vertex.js");
    const url = new VertexExecutor("vertex").buildUrl("gemini-2.5-pro", true, 0, {
      apiKey: SENT.connectionApiKey,
    });
    expect(url, "positive control: executor puts the key in the URL").toContain(
      SENT.connectionApiKey,
    );
    const logger = await freshLogger("vertex");
    logger.logTargetRequest(url, {}, { model: "m" });
    expect(leakSummary(logLeaks()), `vertex URL: ${NO_LEAKS}`).toBe("");
  });

  it("redacts credential values in logged error text and stacks", async () => {
    const logger = await freshLogger("errors");
    const err = new Error(`upstream connect failed for ${SENT.connectionApiKey}`);
    logger.logError(err, {
      apiKey: SENT.connectionApiKey,
      authorization: `Bearer ${SENT.bearerJwt}`,
    });
    expect(leakSummary(logLeaks()), `logged errors: ${NO_LEAKS}`).toBe("");
  });
});
