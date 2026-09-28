import { describe, it, expect } from "vitest";
import {
  createReachableTracker,
  parseSseFrames,
  readTunnelStatus,
} from "@/app/(dashboard)/dashboard/endpoint/remoteAccessLogic";
import { REACHABLE_MISS_THRESHOLD } from "@/app/(dashboard)/dashboard/endpoint/endpointConstants";

describe("createReachableTracker", () => {
  it("rejects a non-positive threshold", () => {
    expect(() => createReachableTracker(0)).toThrow();
    expect(() => createReachableTracker(-3)).toThrow();
    expect(() => createReachableTracker(1.5)).toThrow();
  });

  it("flips to true on the first hit and latches everReachable", () => {
    const t = createReachableTracker(REACHABLE_MISS_THRESHOLD);
    expect(t.track(true)).toEqual({ reachable: true, everReachable: true });
    // A later miss streak below the threshold keeps the current value (null verdict).
    expect(t.track(false)).toEqual({ reachable: null, everReachable: true });
  });

  it("holds `null` below the threshold, then flips to false", () => {
    const t = createReachableTracker(3);
    expect(t.track(false).reachable).toBeNull();
    expect(t.track(false).reachable).toBeNull();
    const verdict = t.track(false);
    expect(verdict).toEqual({ reachable: false, everReachable: false });
  });

  it("resets the miss count on a hit", () => {
    const t = createReachableTracker(2);
    expect(t.track(false).reachable).toBeNull();
    expect(t.track(true).reachable).toBe(true);
    expect(t.track(false).reachable).toBeNull();
    expect(t.track(false).reachable).toBe(false);
  });

  it("forget() clears the last ping result for disabled transports", () => {
    const t = createReachableTracker(2);
    t.track(true);
    expect(t.lastObserved).toBe(true);
    t.forget();
    expect(t.lastObserved).toBe(false);
  });
});

describe("parseSseFrames", () => {
  it("parses progress/done/error frames and keeps the partial tail", () => {
    const { frames, rest } = parseSseFrames(
      'event: progress\ndata: {"message":"a"}\n\n' +
        'event: done\ndata: {"success":true}\n\n' +
        'event: error\ndata: {"error":"x"}\n\n' +
        'event: progress\ndata: {"message":"par',
    );
    expect(frames).toEqual([
      { event: "progress", data: { message: "a" } },
      { event: "done", data: { success: true } },
      { event: "error", data: { error: "x" } },
    ]);
    expect(rest).toBe('event: progress\ndata: {"message":"par');
  });

  it("defaults the event to progress and skips malformed payloads", () => {
    const { frames, rest } = parseSseFrames('data: {"message":"no-event"}\n\ndata: {broken}\n\n');
    expect(frames).toEqual([{ event: "progress", data: { message: "no-event" } }]);
    expect(rest).toBe("");
  });

  it("returns an empty frame list for an incomplete buffer", () => {
    expect(parseSseFrames("event: progress\ndata: ")).toEqual({
      frames: [],
      rest: "event: progress\ndata: ",
    });
  });
});

describe("readTunnelStatus", () => {
  it("prefers settingsEnabled over the live enabled flag", () => {
    const parsed = readTunnelStatus({
      tunnel: { settingsEnabled: true, enabled: false, tunnelUrl: "u", publicUrl: "p" },
      tailscale: { settingsEnabled: false, enabled: true, tunnelUrl: "t" },
    });
    expect(parsed).toEqual({
      tunnel: { enabled: true, url: "u", publicUrl: "p" },
      tailscale: { enabled: false, url: "t" },
    });
  });

  it("defaults missing fields to disabled with empty URLs", () => {
    expect(readTunnelStatus({})).toEqual({
      tunnel: { enabled: false, url: "", publicUrl: "" },
      tailscale: { enabled: false, url: "" },
    });
    expect(readTunnelStatus(null)).toEqual({
      tunnel: { enabled: false, url: "", publicUrl: "" },
      tailscale: { enabled: false, url: "" },
    });
  });
});
