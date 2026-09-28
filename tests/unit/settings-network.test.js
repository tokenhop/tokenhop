import { describe, it, expect } from "vitest";

import {
  tailscaleDisplay,
  tailscaleGateReason,
  tunnelDisplay,
  tunnelGateReason,
} from "@/app/(dashboard)/dashboard/settings/sections/networkUtils.js";

describe("tunnelDisplay", () => {
  it("shows Checking before the first status poll", () => {
    expect(tunnelDisplay(null)).toEqual({ label: "Checking", variant: "neutral" });
    expect(tunnelDisplay(undefined)).toEqual({ label: "Checking", variant: "neutral" });
  });

  it("shows Connected while the tunnel process is reachable", () => {
    expect(tunnelDisplay({ enabled: true, settingsEnabled: true })).toEqual({
      label: "Connected",
      variant: "ok",
    });
  });

  it("shows Starting while enabled but not yet reachable", () => {
    expect(tunnelDisplay({ enabled: false, settingsEnabled: true })).toEqual({
      label: "Starting",
      variant: "warn",
    });
  });

  it("shows Off once disabled", () => {
    expect(tunnelDisplay({ enabled: false, settingsEnabled: false })).toEqual({
      label: "Off",
      variant: "neutral",
    });
  });
});

describe("tailscaleDisplay", () => {
  it("mirrors the tunnel states", () => {
    expect(tailscaleDisplay(null)).toEqual({ label: "Checking", variant: "neutral" });
    expect(tailscaleDisplay({ enabled: true, settingsEnabled: true })).toEqual({
      label: "Connected",
      variant: "ok",
    });
    expect(tailscaleDisplay({ enabled: false, settingsEnabled: true })).toEqual({
      label: "Starting",
      variant: "warn",
    });
    expect(tailscaleDisplay({ enabled: false, settingsEnabled: false })).toEqual({
      label: "Off",
      variant: "neutral",
    });
  });
});

describe("tunnelGateReason", () => {
  const safe = { requireLogin: true, hasPassword: true, requireApiKey: true };

  it("allows the toggle when login, password and API key are set", () => {
    expect(tunnelGateReason(safe)).toBe("");
  });

  it("blocks when login is off", () => {
    expect(tunnelGateReason({ ...safe, requireLogin: false })).toMatch(/Require login/);
  });

  it("blocks on the default password", () => {
    expect(tunnelGateReason({ ...safe, hasPassword: false })).toMatch(/default.*password/i);
  });

  it("blocks when the API key is not required", () => {
    expect(tunnelGateReason({ ...safe, requireApiKey: false })).toMatch(/Require API key/);
  });
});

describe("tailscaleGateReason", () => {
  it("allows the toggle when login and password are set", () => {
    expect(tailscaleGateReason({ requireLogin: true, hasPassword: true })).toBe("");
  });

  it("blocks when login is off or the password is default", () => {
    expect(tailscaleGateReason({ requireLogin: false, hasPassword: true })).toMatch(
      /Require login/,
    );
    expect(tailscaleGateReason({ requireLogin: true, hasPassword: false })).toMatch(
      /default.*password/i,
    );
  });
});
