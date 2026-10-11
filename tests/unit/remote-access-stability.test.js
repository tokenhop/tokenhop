import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const controls = readFileSync(
  resolve(dir, "../../src/app/(dashboard)/dashboard/endpoint/hooks/useTunnelControls.js"),
  "utf8",
);
const sync = readFileSync(
  resolve(dir, "../../src/app/(dashboard)/dashboard/endpoint/hooks/useReachableSync.js"),
  "utf8",
);

/**
 * Source-contract guard against the fetch-storm regression (merge-gate BLOCK):
 * whole-object hook returns (`[tunnel, ts]`, `loadSettings`) as effect deps
 * re-created callbacks every render → endless /api/settings +
 * /api/tunnel/status refetching. The coordinator must load once when access resolves and
 * keep every effect callback referentially stable (refs for latest values).
 */
describe("useTunnelControls fetch-storm guard", () => {
  it("has no whole-object deps in useCallback/useEffect dependency arrays", () => {
    expect(controls).not.toMatch(/\[\s*tunnel\s*,\s*ts\s*\]/);
    expect(controls).not.toMatch(/\[\s*loadSettings\s*\]/);
  });

  it("loads once when access resolves, keyed only on the two capability booleans", () => {
    // Intentional contract change (YAN-769): not mount-only any more. Still a
    // single load per access transition, never keyed on callbacks/objects.
    expect(controls).toMatch(
      /useEffect\(\(\) => \{\s*epochRef\.current \+= 1;\s*if \(settingsAllowed \|\| hostAllowed\) loadSettings\(\);\s*else if \(ready\) tunnelRef\.current\.setChecking\(false\);\s*\}, \[settingsAllowed, hostAllowed\]\)/,
    );
    expect(controls).not.toMatch(/useEffect\(\(\) => \{\s*loadSettings\(\);\s*\}, \[\]\)/);
  });

  it("routes transport-hook access through latest-value refs", () => {
    expect(controls).toMatch(/tunnelRef\.current\s*=\s*tunnel/);
    expect(controls).toMatch(/tsRef\.current\s*=\s*ts/);
    expect(controls).toMatch(/tunnelRef\.current/);
    expect(controls).toMatch(/tsRef\.current/);
  });

  it("reaches transport setters only through refs inside stable callbacks", () => {
    // Extract the two useCallback bodies; they must use t./s. (ref locals),
    // never tunnel./ts. (whole objects that change identity per render).
    const useCallbackBodies = [
      ...controls.matchAll(
        /const (syncTunnelStatus|loadSettings) = useCallback\(async \(\) => \{(.*?)\n {2}\}, \[\]\);/gs,
      ),
    ];
    expect(useCallbackBodies.length).toBe(2);
    for (const [, name, body] of useCallbackBodies) {
      expect(body, `${name} must not touch whole hook objects`).not.toMatch(/[^.]tunnel\./);
      expect(body, `${name} must not touch whole hook objects`).not.toMatch(/[^.]ts\./);
      expect(body, `${name} must use ref locals`).toMatch(/[ts]\.(setUrl|setEnabled|setChecking)/);
    }
  });
});

describe("useReachableSync stability", () => {
  it("deps list contains only primitives and stable callbacks, never whole objects", () => {
    expect(sync).not.toMatch(/\[\s*tunnel\s*,\s*tailscale\s*\]/);
    // The effect deps must be the scalar fields + stable setters + trackers.
    expect(sync).toMatch(/tunnel\.enabled/);
    expect(sync).toMatch(/setTunnel/);
    expect(sync).toMatch(/trackers/);
  });

  it("a null tracker verdict never flips reachable (keeps previous value)", async () => {
    const { createReachableTracker } = await import(
      "@/app/(dashboard)/dashboard/endpoint/remoteAccessLogic"
    );
    const t = createReachableTracker(5);
    // First miss: below threshold → null verdict.
    expect(t.track(false).reachable).toBeNull();
  });
});
