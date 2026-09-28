import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  formatUptime,
  resolveListenPort,
  shapeGatewayStatus,
  uptimeSecondsSince,
} from "../../src/lib/gatewayStatus.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("resolveListenPort", () => {
  it("prefers PORT, then --port, else null", () => {
    expect(resolveListenPort({ PORT: "20128" }, ["node", "server"])).toBe(20128);
    expect(resolveListenPort({}, ["node", "next", "start", "--port", "20127"])).toBe(20127);
    expect(resolveListenPort({ PORT: "nope" }, ["node", "-p", "20129"])).toBe(20129);
    expect(resolveListenPort({}, ["node"])).toBeNull();
    expect(resolveListenPort({ PORT: "0" }, [])).toBeNull();
    expect(resolveListenPort({ PORT: "70000" }, [])).toBeNull();
  });
});

describe("shapeGatewayStatus", () => {
  it("returns ok, floored uptime, startedAt and port", () => {
    const nowMs = Date.parse("2026-09-25T12:00:00.000Z");
    expect(shapeGatewayStatus({ uptimeSeconds: 90.9, nowMs, port: 20128 })).toEqual({
      ok: true,
      uptimeSeconds: 90,
      startedAt: "2026-09-25T11:58:30.000Z",
      port: 20128,
    });
  });

  it("keeps a missing port as null", () => {
    const body = shapeGatewayStatus({ uptimeSeconds: 1, nowMs: 1_000, port: null });
    expect(body.port).toBeNull();
    expect(body.ok).toBe(true);
  });
});

describe("formatUptime", () => {
  it("uses seconds, minutes, hours and days", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(45)).toBe("45s");
    expect(formatUptime(90)).toBe("1m 30s");
    expect(formatUptime(3600)).toBe("1h");
    expect(formatUptime(3 * 3600 + 4 * 60)).toBe("3h 4m");
    expect(formatUptime(3 * 86400 + 4 * 3600)).toBe("3d 4h");
    expect(formatUptime(2 * 86400)).toBe("2d");
  });
});

describe("uptimeSecondsSince", () => {
  it("counts whole seconds from startedAt and rejects bad input", () => {
    const nowMs = Date.parse("2026-09-25T12:00:00.000Z");
    expect(uptimeSecondsSince("2026-09-25T11:58:30.000Z", nowMs)).toBe(90);
    expect(uptimeSecondsSince("2026-09-25T12:00:05.000Z", nowMs)).toBe(0);
    expect(uptimeSecondsSince(null, nowMs)).toBeNull();
    expect(uptimeSecondsSince("garbage", nowMs)).toBeNull();
  });
});

describe("gateway status route auth", () => {
  it("is not on the dashboard public API allowlist", () => {
    const source = readFileSync(path.join(repoRoot, "src/dashboardGuard.js"), "utf8");
    const start = source.indexOf("const PUBLIC_API_PATHS");
    const end = source.indexOf("];", start);
    const block = source.slice(start, end);
    expect(block).not.toContain("/api/gateway");
    expect(block).toContain("/api/health");
  });

  it("route is GET-only and exposes no env", () => {
    const route = readFileSync(path.join(repoRoot, "src/app/api/gateway/status/route.js"), "utf8");
    expect(route).toMatch(/export async function GET/);
    expect(route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
    expect(route).not.toMatch(/process\.env\)/);
  });
});
