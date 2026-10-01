import {
  deriveToolStatus,
  countToolsByFilter,
  filterToolEntries,
  buildEndpointOptions,
  getToolBrand,
  TOOL_STATUS_KEYS,
} from "@/app/(dashboard)/dashboard/cli-tools/lib/toolStatus.js";
import { describe, it, expect } from "vitest";

const guideTool = { name: "Cursor", configType: "guide" };
const cliTool = { name: "Claude Code" };

describe("deriveToolStatus", () => {
  it("guide tools always report guide", () => {
    expect(deriveToolStatus(guideTool, { installed: true, hasTokenhop: true }).key).toBe("guide");
    expect(deriveToolStatus(guideTool, null).key).toBe("guide");
  });
  it("maps installed/hasTokenhop to connected", () => {
    expect(deriveToolStatus(cliTool, { installed: true, hasTokenhop: true })).toMatchObject({
      key: "connected",
      label: "Connected",
      variant: "ok",
    });
  });
  it("maps installed without config to notConfigured", () => {
    expect(deriveToolStatus(cliTool, { installed: true, hasTokenhop: false })).toMatchObject({
      key: "notConfigured",
      label: "Not configured",
      variant: "warn",
    });
  });
  it("maps a failed detection to an error, not notInstalled", () => {
    expect(deriveToolStatus(cliTool, { installed: false, error: "boom" })).toMatchObject({
      key: "error",
      label: "Detection failed",
      variant: "err",
    });
  });
  it("guide tools report a failed detection rather than hiding it as a guide", () => {
    expect(
      deriveToolStatus({ name: "GitHub Copilot", configType: "guide" }, { error: "status 500" }),
    ).toMatchObject({
      key: "error",
      label: "Detection failed",
    });
  });
  it("maps missing payload and not-installed to notInstalled", () => {
    expect(deriveToolStatus(cliTool, null).key).toBe("notInstalled");
    expect(deriveToolStatus(cliTool, { installed: false }).key).toBe("notInstalled");
  });
  it("remote mode reports manual for writers and guide for guides", () => {
    expect(deriveToolStatus(cliTool, null, { remote: true })).toMatchObject({
      key: "manual",
      label: "Manual setup",
      variant: "info",
    });
    expect(deriveToolStatus(cliTool, { error: "boom" }, { remote: true }).key).toBe("manual");
    expect(deriveToolStatus(guideTool, null, { remote: true }).key).toBe("guide");
  });
});

describe("countToolsByFilter + filterToolEntries", () => {
  const entries = [
    ["claude", { name: "Claude Code" }],
    ["cline", { name: "Cline" }],
    ["roo", { name: "Roo" }],
    ["cursor", { name: "Cursor", configType: "guide" }],
  ];
  const statuses = {
    claude: { installed: true, hasTokenhop: true },
    cline: { installed: true, hasTokenhop: false },
    roo: { installed: false },
  };
  it("counts each bucket", () => {
    expect(countToolsByFilter(entries, statuses)).toEqual({
      all: 4,
      connected: 1,
      needsSetup: 2,
      guides: 1,
      manual: 0,
    });
  });
  it("remote mode buckets writers as manual and leaves guides", () => {
    expect(countToolsByFilter(entries, statuses, { remote: true })).toEqual({
      all: 4,
      connected: 0,
      needsSetup: 0,
      guides: 1,
      manual: 3,
    });
    expect(
      filterToolEntries(entries, statuses, "guides", "", { remote: true }).map(([id]) => id),
    ).toEqual(["cursor"]);
    expect(
      filterToolEntries(entries, statuses, "all", "cl", { remote: true }).map(([id]) => id),
    ).toEqual(["claude", "cline"]);
  });
  it("filters needsSetup as notConfigured + notInstalled", () => {
    expect(filterToolEntries(entries, statuses, "needsSetup", "").map(([id]) => id)).toEqual([
      "cline",
      "roo",
    ]);
    expect(filterToolEntries(entries, statuses, "connected", "").map(([id]) => id)).toEqual([
      "claude",
    ]);
    expect(filterToolEntries(entries, statuses, "guides", "").map(([id]) => id)).toEqual([
      "cursor",
    ]);
  });
  it("matches the query against the tool name", () => {
    expect(filterToolEntries(entries, statuses, "all", "cl").map(([id]) => id)).toEqual([
      "claude",
      "cline",
    ]);
  });
  it("rejects unknown filters", () => {
    expect(() => filterToolEntries(entries, statuses, "nope", "")).toThrow();
  });
});

describe("status buckets stay consistent (YAN-388 merge gate)", () => {
  // One tool per status key, so every key is exercised by count and filter.
  // Fixtures are fixed here (not derived from TOOL_STATUS_KEYS) so a key
  // missing from that list can't silently drop out of the check.
  const PAYLOAD_FOR_KEY = {
    connected: { installed: true, hasTokenhop: true },
    notConfigured: { installed: true, hasTokenhop: false },
    notInstalled: { installed: false },
    error: { installed: false, error: "status 500" },
    guide: null,
  };
  const KEYS = Object.keys(PAYLOAD_FOR_KEY);
  const entries = KEYS.map((key) => [
    key,
    key === "guide" ? { name: "Guide tool", configType: "guide" } : { name: `Tool ${key}` },
  ]);
  const statuses = { ...PAYLOAD_FOR_KEY };

  it("TOOL_STATUS_KEYS lists every key deriveToolStatus can return", () => {
    const derived = entries.map(([id, tool]) => deriveToolStatus(tool, statuses[id]).key);
    expect(derived).toEqual(KEYS);
    expect([...TOOL_STATUS_KEYS].sort()).toEqual([...KEYS, "manual"].sort());
  });

  it("each filter's count equals its filtered list length for every status", () => {
    const counts = countToolsByFilter(entries, statuses);
    for (const filter of ["all", "connected", "needsSetup", "guides"]) {
      expect(filterToolEntries(entries, statuses, filter, "")).toHaveLength(counts[filter]);
    }
  });

  it("a failed detection lands in Needs setup, not nowhere", () => {
    expect(filterToolEntries(entries, statuses, "needsSetup", "").map(([id]) => id)).toEqual([
      "notConfigured",
      "notInstalled",
      "error",
    ]);
  });
});

describe("buildEndpointOptions", () => {
  it("orders Local/Tunnel/Tailscale/Custom with /v1", () => {
    const opts = buildEndpointOptions({
      tunnelEnabled: true,
      tunnelPublicUrl: "https://t.example",
      tailscaleEnabled: true,
      tailscaleUrl: "http://ts:20128",
      localOrigin: "http://localhost:20149",
    });
    expect(opts.map((o) => o.value)).toEqual(
      ["local", "tunnel", "tailscale", "custom"].map((v) => (v === "custom" ? "__custom__" : v)),
    );
    expect(opts[0].url).toBe("http://localhost:20149/v1");
    expect(opts[1].url).toBe("https://t.example/v1");
  });
  it("hides local when an external url is required", () => {
    const opts = buildEndpointOptions({ requiresExternalUrl: true, localOrigin: "http://x" });
    expect(opts.map((o) => o.value)).toEqual(["__custom__"]);
  });
});

describe("getToolBrand", () => {
  it("builds initials monograms", () => {
    expect(getToolBrand({ name: "Claude Code", color: "#D97757" })).toEqual({
      color: "#D97757",
      monogram: "CC",
    });
    expect(getToolBrand({ name: "Roo", color: "#FF6B6B" }).monogram).toBe("RO");
  });
  it("falls back for unknown tools", () => {
    expect(getToolBrand(null)).toEqual({ color: "#15171d", monogram: "?" });
    expect(getToolBrand({ name: "X", color: "red" }).color).toBe("#15171d");
  });
});
