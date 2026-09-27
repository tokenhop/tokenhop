import {
  deriveToolStatus,
  countToolsByFilter,
  filterToolEntries,
  buildEndpointOptions,
  getToolBrand,
} from "@/app/(dashboard)/dashboard/cli-tools/lib/toolStatus.js";
import { describe, it, expect } from "vitest";

const guideTool = { name: "Cursor", configType: "guide" };
const cliTool = { name: "Claude Code" };

describe("deriveToolStatus", () => {
  it("guide tools always report guide", () => {
    expect(deriveToolStatus(guideTool, { installed: true, has9Router: true }).key).toBe("guide");
    expect(deriveToolStatus(guideTool, null).key).toBe("guide");
  });
  it("maps installed/has9Router to connected", () => {
    expect(deriveToolStatus(cliTool, { installed: true, has9Router: true })).toMatchObject({
      key: "connected",
      label: "Connected",
      variant: "ok",
    });
  });
  it("maps installed without config to notConfigured", () => {
    expect(deriveToolStatus(cliTool, { installed: true, has9Router: false })).toMatchObject({
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
  it("maps missing payload and not-installed to notInstalled", () => {
    expect(deriveToolStatus(cliTool, null).key).toBe("notInstalled");
    expect(deriveToolStatus(cliTool, { installed: false }).key).toBe("notInstalled");
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
    claude: { installed: true, has9Router: true },
    cline: { installed: true, has9Router: false },
    roo: { installed: false },
  };
  it("counts each bucket", () => {
    expect(countToolsByFilter(entries, statuses)).toEqual({
      all: 4,
      connected: 1,
      needsSetup: 2,
      guides: 1,
    });
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
