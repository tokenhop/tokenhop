import { describe, it, expect } from "vitest";
import {
  badgeTint,
  languageButtonLabel,
  resolveUserRow,
  resolveVersionChip,
} from "@/shared/utils/shell.js";

describe("badgeTint", () => {
  it("hides missing (not yet loaded) and zero counts", () => {
    expect(badgeTint("providers", null)).toBeNull();
    expect(badgeTint("providers", undefined)).toBeNull();
    expect(badgeTint("combos", 0)).toBeNull();
    expect(badgeTint("quota", 0)).toBeNull();
  });

  it("tints low quota warn and providers by their worst attention status", () => {
    expect(badgeTint("quota", 2)).toBe("warn");
    expect(badgeTint("providers", 9, "err")).toBe("err");
    expect(badgeTint("providers", 9, "warn")).toBe("warn");
    expect(badgeTint("providers", 9, null)).toBe("neutral");
    expect(badgeTint("combos", 4)).toBe("neutral");
  });
});

describe("resolveVersionChip", () => {
  it("shortens a beta prerelease to one line and keeps the full version", () => {
    expect(resolveVersionChip("0.4.0-beta.7")).toEqual({
      label: "v0.4.0 β7",
      full: "v0.4.0-beta.7",
    });
  });

  it("leaves stable and other versions as-is", () => {
    expect(resolveVersionChip("0.4.0")).toEqual({ label: "v0.4.0", full: "v0.4.0" });
    expect(resolveVersionChip("0.4.0-rc.1")).toEqual({ label: "v0.4.0-rc.1", full: "v0.4.0-rc.1" });
    expect(resolveVersionChip(undefined)).toEqual({ label: "", full: "" });
  });

  it("shows the channel and short commit for an unreleased build", () => {
    const sha = "27bed7140fbebf6eb77d30440f4625972f91c91c";
    expect(resolveVersionChip("0.6.0", { channel: "dev", sha })).toEqual({
      label: "dev 27bed71",
      full: "v0.6.0+dev.27bed71",
    });
    expect(resolveVersionChip("0.6.0", { channel: "dev" })).toEqual({
      label: "dev",
      full: "v0.6.0+dev",
    });
  });

  it("ignores a commit without a channel, as in release and local builds", () => {
    expect(resolveVersionChip("0.6.1", { channel: "", sha: "27bed71" })).toEqual({
      label: "v0.6.1",
      full: "v0.6.1",
    });
  });
});

describe("resolveUserRow", () => {
  it("shows the real SSO or display name", () => {
    expect(
      resolveUserRow({ samlName: "Ada R", displayName: "Ada R", loginMethod: "SAML" }),
    ).toEqual({ name: "Ada R", sub: "SSO" });
    expect(resolveUserRow({ oidcEmail: "ops@example.com", loginMethod: "OIDC" }).name).toBe(
      "ops@example.com",
    );
    expect(resolveUserRow({ displayName: "Mina" }).name).toBe("Mina");
  });

  it("never shows a placeholder name", () => {
    expect(resolveUserRow({ displayName: "Password user", loginMethod: "Password" })).toEqual({
      name: "Admin",
      sub: "Password",
    });
    expect(resolveUserRow({ displayName: "OIDC user", loginMethod: "OIDC" }).name).toBe("Admin");
    expect(resolveUserRow({}).name).toBe("Admin");
  });

  it("says when no login is required", () => {
    expect(resolveUserRow({ requireLogin: false, loginMethod: "Password" }).sub).toBe(
      "No login required",
    );
  });
});

describe("languageButtonLabel", () => {
  it("gives a code chip and an accessible name", () => {
    expect(languageButtonLabel("en")).toEqual({ code: "EN", label: "Language: English" });
    expect(languageButtonLabel("zh-CN")).toEqual({ code: "ZH", label: "Language: 简体中文" });
    expect(languageButtonLabel("ar").code).toBe("AR");
  });
});
