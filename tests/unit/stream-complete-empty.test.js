// YAN-1023 (1.0 backport): a clean 200 stream with no text/reasoning/tool
// output is saved as an error request detail, not a success.
import { describe, it, expect, vi } from "vitest";

const { details } = vi.hoisted(() => ({ details: [] }));
vi.mock("@/lib/usageDb.js", async (importOriginal) => ({
  ...(await importOriginal()),
  saveRequestDetail: vi.fn(async (d) => details.push(d)),
  saveUsageStats: vi.fn(async () => {}),
}));

const { buildOnStreamComplete } = await import(
  "../../open-sse/handlers/chatCore/streamingHandler.js"
);

describe("onStreamComplete empty-stream status", () => {
  it.each([
    ["empty", {}, null, "error"],
    ["text", { content: "hi" }, null, "success"],
    ["tool-only (token seen, no text)", {}, 123, "success"],
    ["untracked caller", {}, undefined, "success"],
  ])("%s → %s", (_l, content, firstTokenAt, status) => {
    details.length = 0;
    buildOnStreamComplete({
      provider: "p",
      model: "m",
      requestStartTime: Date.now(),
      body: {},
    }).onStreamComplete(content, null, null, { firstTokenAt });
    expect(details.at(-1).status).toBe(status);
  });
});
