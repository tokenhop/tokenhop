import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// agent.api5.cursor.sh is HTTP/2-only: cursorModels.js fetches via
// http2PostProto (node:http2 connect/request), so a global.fetch mock never
// sees the request. Mock node:http2 instead — the fake client emits a canned
// response (from h2ResponseQueue) when req.end() is called.
const { connectMock, h2ResponseQueue, h2Requests } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  h2ResponseQueue: [],
  h2Requests: [],
}));

vi.mock("http2", async () => {
  const { EventEmitter } = await import("node:events");
  connectMock.mockImplementation(() => {
    const client = new EventEmitter();
    client.close = () => {};
    client.request = (headers) => {
      const record = { headers };
      h2Requests.push(record);
      const req = new EventEmitter();
      req.end = (body) => {
        record.body = body;
        const next = h2ResponseQueue.shift() ?? { status: 200, body: new Uint8Array() };
        process.nextTick(() => {
          req.emit("response", { ":status": next.status ?? 200 });
          if (next.body?.length) req.emit("data", Buffer.from(next.body));
          req.emit("end");
        });
      };
      return req;
    };
    return client;
  });
  return { default: { connect: connectMock }, connect: connectMock };
});

import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    connectMock.mockClear();
    h2ResponseQueue.length = 0;
    h2Requests.length = 0;
  });

  afterEach(() => {
    clearCursorModelCache();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    h2ResponseQueue.push({
      status: 200,
      body: concat(model("claude-4.6-opus", "Claude 4.6 Opus")),
    });
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledWith("https://agent.api5.cursor.sh");
    expect(h2Requests[0].headers).toMatchObject({
      ":method": "POST",
      ":path": "/agent.v1.AgentService/GetUsableModels",
      ":authority": "agent.api5.cursor.sh",
      ":scheme": "https",
      "content-type": "application/proto",
      accept: "application/proto",
    });
    // Unary GET-like call: empty body → req.end(undefined).
    expect(h2Requests[0].body).toBeUndefined();
  });

  it("fails open when the Cursor catalog request fails", async () => {
    h2ResponseQueue.push({ status: 403, body: text("no") });

    await expect(
      resolveCursorModels({
        accessToken: "cursor-token",
        providerSpecificData: { machineId: "machine-id" },
      }),
    ).resolves.toBeNull();
  });
});
