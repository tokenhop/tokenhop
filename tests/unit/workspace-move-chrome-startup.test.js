import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHROME_STARTUP_TIMEOUT_MS, waitForDevTools } from "../e2e/workspace-move/chrome.mjs";

// A stand-in for a spawned Chrome: an EventEmitter with a piped stderr.
function fakeChrome() {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

const LINE = "DevTools listening on ws://127.0.0.1:41234/devtools/browser/abc-123\n";

describe("waitForDevTools (YAN-2451)", () => {
  afterEach(() => vi.useRealTimers());

  it("budgets more than the old 15 s poll for cold CI runners", () => {
    expect(CHROME_STARTUP_TIMEOUT_MS).toBeGreaterThanOrEqual(60000);
  });

  it("resolves the port from Chrome's DevTools listening line", async () => {
    const chrome = fakeChrome();
    const ready = waitForDevTools(chrome);
    chrome.stderr.write("[0101/000000.000:WARNING:some_noise.cc(1)] noise\n");
    chrome.stderr.write(LINE);
    await expect(ready).resolves.toEqual({
      port: 41234,
      browserWsUrl: "ws://127.0.0.1:41234/devtools/browser/abc-123",
    });
  });

  it("handles the line split across stderr chunks", async () => {
    const chrome = fakeChrome();
    const ready = waitForDevTools(chrome);
    chrome.stderr.write(LINE.slice(0, 30));
    chrome.stderr.write(LINE.slice(30));
    await expect(ready).resolves.toMatchObject({ port: 41234 });
  });

  it("waits past 15 s and times out at the budget with the Chrome log", async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    const ready = waitForDevTools(chrome, { timeout: 60000 });
    const outcome = ready.then(
      () => "resolved",
      (error) => error,
    );
    chrome.stderr.write("slow start: loading profile\n");
    await vi.advanceTimersByTimeAsync(15001);
    await vi.advanceTimersByTimeAsync(44000);
    let settled = false;
    void outcome.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/Timed out after \d+ ms: isolated Chrome startup/);
    expect(error.message).toContain("slow start: loading profile");
  });

  it("rejects with the log when Chrome exits before DevTools is ready", async () => {
    const chrome = fakeChrome();
    const ready = waitForDevTools(chrome);
    chrome.stderr.write("FATAL: cannot open display\n");
    chrome.exitCode = 1;
    chrome.emit("exit", 1, null);
    await expect(ready).rejects.toThrow(
      /exited before DevTools was ready[\s\S]*cannot open display/,
    );
  });

  it("rejects at once if Chrome already exited", async () => {
    const chrome = fakeChrome();
    chrome.signalCode = "SIGKILL";
    await expect(waitForDevTools(chrome)).rejects.toThrow(/signal=SIGKILL/);
  });

  it("rejects with a CHROME_BIN hint when Chrome cannot launch", async () => {
    const chrome = fakeChrome();
    const ready = waitForDevTools(chrome);
    chrome.emit("error", new Error("spawn /usr/bin/google-chrome ENOENT"));
    await expect(ready).rejects.toThrow(/Chrome unavailable: .*ENOENT.*CHROME_BIN/);
  });

  it("detaches its listeners once settled", async () => {
    const chrome = fakeChrome();
    const ready = waitForDevTools(chrome);
    chrome.stderr.write(LINE);
    await ready;
    expect(chrome.listenerCount("exit")).toBe(0);
    expect(chrome.listenerCount("error")).toBe(0);
    expect(chrome.stderr.listenerCount("data")).toBe(0);
  });
});
