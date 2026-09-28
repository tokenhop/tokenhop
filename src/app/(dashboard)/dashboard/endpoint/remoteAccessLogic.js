/**
 * Pure remote-access helpers (no React): the miss-debounced reachable tracker
 * and the Server-Sent Events frame parser used by the Tailscale installer.
 */

/**
 * Build an N-strike miss-debounced reachable tracker. The flip to `false`
 * fires only after `threshold` consecutive misses, so a brief backend refresh
 * doesn't flicker the UI; below the threshold the verdict is `null` (keep the
 * current value). A hit flips to `true` immediately and latches
 * `everReachable` (distinguishes "Checking..." from "Reconnecting...").
 *
 * `lastObserved` holds the latest browser-ping result so the status poll can
 * re-count it (the v1 sync path counted misses from the same client result).
 *
 * @param {number} threshold Consecutive misses before reporting unreachable.
 */
export function createReachableTracker(threshold) {
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(
      `createReachableTracker: threshold must be a positive integer, got ${threshold}`,
    );
  }
  let misses = 0;
  let everReachable = false;
  const tracker = {
    lastObserved: false,
    /**
     * @param {boolean} observed
     * @returns {{ reachable: boolean|null, everReachable: boolean }}
     */
    track(observed) {
      tracker.lastObserved = observed;
      if (observed) {
        misses = 0;
        everReachable = true;
        return { reachable: true, everReachable };
      }
      misses += 1;
      return { reachable: misses >= threshold ? false : null, everReachable };
    },
    /** Transport disabled: forget the last ping result (v1 reset the client ref). */
    forget() {
      tracker.lastObserved = false;
    },
  };
  return tracker;
}

/**
 * Split a Server-Sent Events text buffer into complete `{ event, data }`
 * frames plus the trailing partial frame. `event` defaults to "progress";
 * malformed JSON payloads and frames without data are skipped.
 *
 * @param {string} buffer
 * @returns {{ frames: Array<{ event: string, data: unknown }>, rest: string }}
 */
export function parseSseFrames(buffer) {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames = [];
  for (const part of parts) {
    let event = "progress";
    let data;
    for (const line of part.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      if (line.startsWith("data: ")) {
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          /* skip malformed payload */
        }
      }
    }
    if (data != null) frames.push({ event, data });
  }
  return { frames, rest };
}

/**
 * Read enabled/URL fields from a `/api/tunnel/status` payload. Trusts user
 * intent (`settingsEnabled`) so the UI stays "enabled" while the watchdog
 * restarts the backend process.
 *
 * @param {object} data
 * @returns {{ tunnel: { enabled: boolean, url: string, publicUrl: string }, tailscale: { enabled: boolean, url: string } }}
 */
export function readTunnelStatus(data) {
  return {
    tunnel: {
      enabled: data?.tunnel?.settingsEnabled ?? data?.tunnel?.enabled ?? false,
      url: data?.tunnel?.tunnelUrl || "",
      publicUrl: data?.tunnel?.publicUrl || "",
    },
    tailscale: {
      enabled: data?.tailscale?.settingsEnabled ?? data?.tailscale?.enabled ?? false,
      url: data?.tailscale?.tunnelUrl || "",
    },
  };
}
