import { describe, expect, it } from "vitest";
import {
  createLatestSaveQueue,
  mitmFailureMessage,
  readMitmResponse,
  resolveSaveVisibility,
  restoredMappings,
} from "../../src/app/(dashboard)/dashboard/cli-tools/components/mitmToolActions.js";

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (body instanceof Error) throw body;
    return body;
  },
});

describe("readMitmResponse", () => {
  it("returns the body for OK responses", async () => {
    await expect(
      readMitmResponse(response(200, { aliases: { a: "x/y" } }), "nope"),
    ).resolves.toEqual({ aliases: { a: "x/y" } });
  });

  it("throws the server error for non-OK responses instead of looking successful", async () => {
    await expect(
      readMitmResponse(response(403, { error: "DNS must be enabled for kiro" }), "fallback"),
    ).rejects.toThrow("DNS must be enabled for kiro");
  });

  it("rejects a malformed OK body instead of treating it as confirmed success", async () => {
    await expect(
      readMitmResponse(response(200, new Error("bad json")), "Failed to toggle DNS"),
    ).rejects.toThrow("Failed to toggle DNS: unreadable server response");
  });

  it("falls back when a failed response has no readable body", async () => {
    await expect(
      readMitmResponse(response(500, new Error("bad json")), "Failed to toggle DNS"),
    ).rejects.toThrow("Failed to toggle DNS");
  });
});

describe("restoredMappings", () => {
  it("rolls back to a copy of the last saved snapshot, including an empty map", () => {
    const saved = { "claude-sonnet": "cc/claude-sonnet" };
    const restored = restoredMappings(saved);
    expect(restored).toEqual(saved);
    expect(restored).not.toBe(saved);
    expect(restoredMappings(undefined)).toEqual({});
    expect(restoredMappings({})).toEqual({});
  });

  it("drops an unsaved optimistic edit after a failed save", async () => {
    let state = { fast: "old/model" };
    let saved = { ...state };
    state = { ...state, fast: "new/model" };
    try {
      await readMitmResponse(response(500, { error: "Failed to save aliases" }), "x");
      saved = state;
    } catch {
      state = restoredMappings(saved);
    }
    expect(state).toEqual({ fast: "old/model" });
  });
});

describe("createLatestSaveQueue", () => {
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it("runs saves one at a time so a slow earlier save cannot finish after a later one", async () => {
    const calls = [];
    const gates = [deferred(), deferred()];
    const enqueue = createLatestSaveQueue((mappings) => {
      calls.push(mappings.fast);
      return gates[calls.length - 1].promise;
    });
    const first = enqueue({ fast: "old" });
    const second = enqueue({ fast: "new" });
    await Promise.resolve();
    expect(calls).toEqual(["old"]);
    gates[0].resolve({ fast: "old" });
    await expect(first).resolves.toEqual({
      latest: false,
      saved: { fast: "old" },
      generation: 1,
    });
    await Promise.resolve();
    expect(calls).toEqual(["old", "new"]);
    gates[1].resolve({ fast: "new" });
    await expect(second).resolves.toEqual({
      latest: true,
      saved: { fast: "new" },
      generation: 2,
    });
  });

  it("reports failures without breaking later saves", async () => {
    let n = 0;
    const enqueue = createLatestSaveQueue(async (mappings) => {
      n += 1;
      if (n === 1) throw new Error("Alias store unavailable");
      return mappings;
    });
    const failed = await enqueue({ fast: "a" });
    expect(failed.latest).toBe(true);
    expect(failed.generation).toBe(1);
    expect(failed.error.message).toBe("Alias store unavailable");
    await expect(enqueue({ fast: "b" })).resolves.toEqual({
      latest: true,
      saved: { fast: "b" },
      generation: 2,
    });
  });
});

describe("resolveSaveVisibility", () => {
  it("keeps newer unsent typing visible when the latest queued PUT resolves", () => {
    const saved = { a: "saved/model" };
    const typing = { a: "still-typing/model" };
    expect(resolveSaveVisibility(typing, 3, saved, 2)).toBe(typing);
    expect(resolveSaveVisibility(typing, 2, saved, 2)).toBe(saved);
  });

  it("keeps newer local typing on failed-save rollback and initial-load completion", () => {
    const typing = { a: "draft/model" };
    expect(resolveSaveVisibility(typing, 4, {}, 2)).toBe(typing);
    expect(resolveSaveVisibility(typing, 4, { a: "server/model" }, 0)).toBe(typing);
  });
});

describe("mitmFailureMessage", () => {
  it("names the tool, the action and the server detail", () => {
    expect(mitmFailureMessage("load", "Kiro", "HTTP 500")).toBe(
      "Couldn't load model mappings for Kiro: HTTP 500.",
    );
    expect(mitmFailureMessage("save", "Kiro", "Failed to save aliases")).toBe(
      "Couldn't save model mappings for Kiro: Failed to save aliases. Check the mappings before trying again.",
    );
    expect(mitmFailureMessage("enable", "Antigravity", "Wrong sudo password")).toBe(
      "Couldn't start DNS for Antigravity: Wrong sudo password.",
    );
    expect(mitmFailureMessage("disable", "Antigravity")).toBe("Couldn't stop DNS for Antigravity.");
  });
});
