// YAN-134: tool-call continuations and image turns must go to AgentService
// (never the retired ChatService), images must survive translation and reach
// SelectedContext as raw bytes, and a Cursor "Update Required" must never
// backoff-lock healthy accounts.
import { describe, expect, it } from "vitest";
import { decodeMessage, encodeSelectedContextImages } from "../../open-sse/utils/cursorProtobuf.js";
import {
  buildAgentRunFrame,
  classifyCursorError,
  CursorExecutor,
} from "../../open-sse/executors/cursor.js";
import { resolveCursorImages, CursorImageError } from "../../open-sse/utils/cursorImages.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { convertMessages } from "../../open-sse/translator/request/openai-to-cursor.js";
import { isPrivateIp } from "../../open-sse/utils/ipPolicy.js";

// Minimal 1x1 PNG header — signature + IHDR width/height are what we parse.
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
  0, 0, 0, 3, 8, 6, 0, 0, 0,
]);
const PNG_URI = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
const imagePart = (url = PNG_URI) => ({ type: "image_url", image_url: { url } });

function userMessageOf(frame) {
  const run = decodeMessage(decodeMessage(frame.subarray(5)).get(1)[0].value);
  const userAction = decodeMessage(decodeMessage(run.get(2)[0].value).get(1)[0].value);
  return decodeMessage(userAction.get(1)[0].value);
}

describe("SelectedContext.selected_images encoder", () => {
  it("encodes uuid(2), dimension(4), mime_type(7), raw data(8)", () => {
    const msg = decodeMessage(
      encodeSelectedContextImages([
        { uuid: "img-1", data: PNG_BYTES, mimeType: "image/png", width: 640, height: 480 },
      ]),
    );
    const image = decodeMessage(msg.get(1)[0].value);
    expect(Buffer.from(image.get(2)[0].value).toString()).toBe("img-1");
    const dim = decodeMessage(image.get(4)[0].value);
    expect([dim.get(1)[0].value, dim.get(2)[0].value]).toEqual([640, 480]);
    expect(Buffer.from(image.get(7)[0].value).toString()).toBe("image/png");
    expect(Buffer.from(image.get(8)[0].value)).toEqual(PNG_BYTES);
  });
});

describe("image turn → AgentService frame", () => {
  it("attaches a current-turn image as raw bytes with parsed dimensions", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "what is this?" }, imagePart()] },
    ];
    const images = await resolveCursorImages(messages);
    expect(images).toHaveLength(1);
    expect([images[0].width, images[0].height]).toEqual([2, 3]);

    const userMessage = userMessageOf(buildAgentRunFrame(messages, "gpt-5.2", [], { images }));
    const selected = decodeMessage(userMessage.get(3)[0].value).get(1);
    expect(selected).toHaveLength(1);
    expect(Buffer.from(decodeMessage(selected[0].value).get(8)[0].value)).toEqual(PNG_BYTES);
  });

  it("replays historical images into the current turn with a marker", async () => {
    const messages = [
      { role: "system", content: "inspect images" },
      { role: "user", content: [{ type: "text", text: "look" }, imagePart()] },
      { role: "assistant", content: "seen" },
      { role: "user", content: "and now?" },
    ];
    const images = await resolveCursorImages(messages);
    const userMessage = userMessageOf(buildAgentRunFrame(messages, "gpt-5.2", [], { images }));
    expect(decodeMessage(userMessage.get(3)[0].value).get(1)).toHaveLength(1);
    expect(Buffer.from(userMessage.get(1)[0].value).toString()).toContain(
      "[image 1 from prior turn 1]",
    );
  });

  it("translator keeps user, assistant, and tool-result images instead of dropping them", () => {
    const out = convertMessages([
      { role: "user", content: [{ type: "text", text: "hi" }, imagePart()] },
      { role: "assistant", content: [{ type: "text", text: "seen" }, imagePart()] },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "shot", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "ok" }, imagePart()] },
    ]);
    expect(out[0].content.filter((p) => p.type === "image_url")).toHaveLength(1);
    expect(out[1].content.filter((p) => p.type === "image_url")).toHaveLength(1);
    expect(out[3].content.filter((p) => p.type === "image_url")).toHaveLength(1);
    expect(out[3].content[0].text).toContain("<tool_result>");
  });

  it.each([
    ["malformed base64", "data:image/png;base64,!!!"],
    ["mime/bytes mismatch", `data:image/jpeg;base64,${PNG_BYTES.toString("base64")}`],
    ["non-image media type", "data:text/plain;base64,aGk="],
    ["SSRF target", "https://127.0.0.1/x.png"],
    ["v4-mapped v6 SSRF target", "https://[::ffff:127.0.0.1]/x.png"],
  ])("rejects %s request-scoped (never silently dropped)", async (_label, url) => {
    await expect(
      resolveCursorImages([{ role: "user", content: [imagePart(url)] }]),
    ).rejects.toThrow(CursorImageError);
  });

  it("parses JPEG SOF dimensions up to the exact buffer boundary", async () => {
    // SOI + SOF0(length 8) with height=4 width=5, ending exactly at the SOF end.
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 4, 0, 5]);
    const url = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    const [image] = await resolveCursorImages([{ role: "user", content: [imagePart(url)] }]);
    expect([image.width, image.height]).toEqual([5, 4]);
  });

  it("executor turns a bad image into a 400 without touching the network", async () => {
    const result = await new CursorExecutor().execute({
      model: "gpt-5.2",
      body: { messages: [{ role: "user", content: [imagePart("data:image/png;base64,!!!")] }] },
      stream: false,
      credentials: { accessToken: "t", providerSpecificData: { machineId: "m" } },
    });
    expect(result.response.status).toBe(400);
    const { error } = await result.response.json();
    expect(error.code).toBe("invalid_image");
    expect(checkFallbackError(400, error.message)).toEqual({
      shouldFallback: false,
      cooldownMs: 0,
    });
  });
  it("blocks private and mapped addresses (net.BlockList SSRF guard)", () => {
    for (const privateIp of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:0:7f00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "2002:a00:1::1",
    ]) {
      expect(isPrivateIp(privateIp), privateIp).toBe(true);
    }
    for (const publicIp of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
      expect(isPrivateIp(publicIp), publicIp).toBe(false);
    }
  });
});

describe("Cursor Update Required is account-neutral", () => {
  const updateRequired = {
    error: {
      code: "resource_exhausted",
      details: [
        {
          debug: {
            error: "ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT",
            details: { title: "Update Required" },
          },
        },
      ],
    },
  };

  it("maps to 400 and never locks or rotates the account", () => {
    const detail = classifyCursorError(updateRequired);
    expect(detail.status).toBe(400);
    expect(detail.code).toBe("cursor_client_update_required");
    expect(checkFallbackError(detail.status, detail.message)).toEqual({
      shouldFallback: false,
      cooldownMs: 0,
    });
  });

  it("keeps genuine resource_exhausted on 429 backoff", () => {
    const detail = classifyCursorError({
      error: { code: "resource_exhausted", message: "slow down" },
    });
    expect(detail.status).toBe(429);
    expect(checkFallbackError(detail.status, detail.message).shouldFallback).toBe(true);
  });
});
